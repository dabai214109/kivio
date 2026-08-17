// 网关编排：入站消息 -> 鉴权/指令 -> 会话队列 -> UI 发送 -> 轮询对话文件 -> 分段回发。
//
// 单轮执行的完整时序（Mode A）：
//   1. 白名单校验（私聊/群）。
//   2. 指令（/new /stop /status /bind /help）直接处理，不进队列。
//   3. 取用户映射的 conv：存在且文件仍在 -> 先尝试切换到该对话（尽力而为）；
//      否则视为需要新建（先点“新对话”再发送，靠 index diff 识别新 conv）。
//   4. 记录发送基线（index 快照 + 时间戳），UI 发送文本。
//   5. identify 阶段：轮询 index.json，找到 revision 增长/新出现的对话 -> 更新映射。
//   6. collect 阶段：轮询 conv json，等待 timestamp > 发送时刻 的 assistant 消息出现，
//      且 revision 连续 settle_polls 次不变（流式写盘结束）-> 取全文。
//   7. 按 split_length 分段、带序号回发；超时则回发超时提示。

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConvStore } from './driver/conv-store.js'
import { KivioUiDriver } from './driver/ui-automation.js'
import { SessionManager, HELP_TEXT } from './session.js'
import { createLogger } from './logger.js'

const log = createLogger('gateway')
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class Gateway {
  /**
   * @param {object} cfg 完整配置（loadConfig 产物）
   * @param {import('./adapters/onebot.js').OneBotClient} onebot
   */
  constructor(cfg, onebot) {
    this.cfg = cfg
    this.onebot = onebot
    this.store = new ConvStore(cfg.kivio.conversations_dir)
    this.driver = new KivioUiDriver(cfg.kivio)
    this.sessions = new SessionManager({
      dataDir: path.join(__dirname, '..', 'data'),
      config: cfg.session,
    })
    this.stopping = false
  }

  start() {
    this.onebot.on('message', (m) => { void this.#onMessage(m) })
    log.info(`网关就绪（会话目录：${this.cfg.kivio.conversations_dir}）`)
    void this.#startupProbe()
  }

  async stop() {
    this.stopping = true
  }

  async #startupProbe() {
    const probe = await this.driver.probe()
    if (!probe.ok) {
      log.warn(`Kivio 探活失败：${probe.reason ?? '窗口未找到'} —— 请确认 Kivio 已启动`)
    } else {
      log.info(`Kivio 探活通过：输入定位模式=${probe.mode}，UIA Edit 数=${probe.uia.editCount}`)
      if (probe.mode === 'coords') {
        log.warn(
          'UIA 未暴露输入框（WebView2 无障碍未开启）。将使用坐标兜底模式；' +
          '建议以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility 重启 Kivio。',
        )
      }
    }
    try {
      const idx = this.store.readIndex()
      log.info(`对话索引读取正常，共 ${idx.size} 个会话`)
    } catch (err) {
      log.error(`对话索引读取失败：${err.message} —— 检查 kivio.conversations_dir 配置`)
    }
  }

  async #onMessage(inbound) {
    const { onebot } = this.cfg
    const isPrivate = inbound.message_type !== 'group'
    const allowed = isPrivate
      ? onebot._allow_private.has(inbound.user_id)
      : onebot._allow_group.has(inbound.group_id)

    if (!allowed) {
      if (onebot.on_not_allowed === 'reject') {
        await this.#safeReply(inbound, '未授权使用本网关（白名单外）。').catch(() => {})
      }
      return log.debug(`白名单外消息已忽略：${inbound.message_type} ${inbound.user_id}`)
    }

    const text = inbound.text
    if (text.startsWith('/')) return this.#handleCommand(inbound, text)

    const key = SessionManager.keyOf(inbound)
    const rt = this.sessions.rt(key)
    if (rt.running) {
      const ok = this.sessions.enqueue(key, text, inbound)
      if (!ok) return this.#safeReply(inbound, `队列已满（${this.cfg.session.max_queue}），请稍后再试。`)
      return this.#safeReply(inbound, '当前仍在执行上一条，已排队。')
    }
    if (!this.sessions.enqueue(key, text, inbound)) {
      return this.#safeReply(inbound, `队列已满（${this.cfg.session.max_queue}），请稍后再试。`)
    }
    void this.#pump(key)
  }

  #handleCommand(inbound, text) {
    const key = SessionManager.keyOf(inbound)
    const [cmd, ...args] = text.trim().split(/\s+/)
    switch (cmd) {
      case '/help':
        return this.#safeReply(inbound, HELP_TEXT)
      case '/status':
        return this.#safeReply(inbound, this.sessions.statusText(key))
      case '/new': {
        this.sessions.dropMapping(key)
        const rt = this.sessions.rt(key)
        if (rt.running) rt.lastError = '执行中被 /new，映射已清空'
        return this.#safeReply(inbound, '已解除会话映射，下一条消息将在新 Kivio 对话中执行。')
      }
      case '/stop': {
        void (async () => {
          const r = await this.driver.stopRun()
          this.#safeReply(inbound, r.ok ? `停止请求已发出（${r.detail}）。` : `停止失败：${r.detail}`)
        })()
        return
      }
      case '/bind': {
        const id = args[0]
        if (!id || !/^conv_[\w-]+$/.test(id)) return this.#safeReply(inbound, '用法：/bind conv_<uuid>（从 Kivio 或 /status 里获取）')
        if (!this.store.exists(id)) return this.#safeReply(inbound, `未在对话目录中找到 ${id}`)
        this.sessions.setMapping(key, id)
        return this.#safeReply(inbound, `已绑定 ${id}。发送前请确保 Kivio 当前打开的就是该对话（切换为尽力而为）。`)
      }
      default:
        return this.#safeReply(inbound, `未知指令 ${cmd}，/help 查看可用指令。`)
    }
  }

  #safeReply(inbound, text) {
    return this.onebot.reply(inbound, text).catch((err) => log.warn(`回发失败：${err.message}`))
  }

  /** 逐条泵出某个用户的队列。 */
  async #pump(key) {
    const rt = this.sessions.rt(key)
    if (rt.running) return
    rt.running = true
    rt.startedAt = Date.now()
    try {
      while (!this.stopping) {
        const item = this.sessions.dequeue(key)
        if (!item) break
        rt.startedAt = Date.now()
        try {
          await this.#runOne(key, item)
          rt.lastError = ''
        } catch (err) {
          rt.lastError = err.message
          log.error(`会话 ${key} 单轮失败：${err.message}`)
          await this.#safeReply(item.inbound, `执行失败：${err.message}`)
        }
        this.sessions.touch(key)
      }
    } finally {
      rt.running = false
    }
  }

  /** 执行一轮：定位/新建对话 -> UI 发送 -> 轮询取回 -> 回发。 */
  async #runOne(key, { text, inbound }) {
    const { kivio } = this.cfg

    // 1) 准备目标对话
    let preferredId = null
    let needNew = false
    const mapping = this.sessions.getMapping(key)
    if (mapping && this.store.exists(mapping.conv_id)) {
      preferredId = mapping.conv_id
      if (mapping.title) {
        const sw = await this.driver.switchConversation(mapping.title)
        log.info(`切换会话 ${preferredId}：${sw.ok ? '成功' : `失败（${sw.detail}）`}`)
        if (!sw.ok) {
          await this.#safeReply(inbound, `提示：未能切换到历史会话（${sw.detail}），消息将发进 Kivio 当前打开的对话。`)
        }
      }
    } else {
      needNew = true
      const nc = await this.driver.newConversation()
      log.info(`新建对话：${nc.ok ? '已点击' : `失败（${nc.detail}）`}`)
      if (!nc.ok) {
        // 新建失败也可以继续：发进当前对话，靠 diff 识别。
        await this.#safeReply(inbound, `提示：新建对话失败（${nc.detail}），将使用当前打开的对话。`)
      }
    }

    // 2) 发送
    if (this.cfg.session.ack_message) {
      await this.#safeReply(inbound, needNew ? '⏳ 已提交到新 Kivio 对话…' : '⏳ 已提交给 Kivio…')
    }
    const baseline = this.store.baseline()
    const sendTs = Math.floor(Date.now() / 1000) - 1 // 秒级时间戳，留 1s 容差
    const sendStart = Date.now()
    const sent = await this.driver.sendText(text)
    if (!sent.ok) throw new Error(`UI 发送失败：${sent.detail}`)
    log.info(`UI 发送完成（mode=${sent.mode}，${sent.detail}）`)

    // 3) identify：确认这轮落进了哪个对话
    const identifyDeadline = sendStart + kivio.identify_timeout_sec * 1000
    let target = null
    while (Date.now() < identifyDeadline) {
      await sleep(Math.max(200, kivio.poll_interval_ms))
      target = this.store.diffBaseline(baseline, preferredId)
      if (target) break
    }
    if (!target) {
      if (preferredId) target = { id: preferredId, kind: 'assume' }
      else throw new Error('发送后未能识别目标对话（index.json 无变化）——Kivio 可能没有真正收到消息')
    }
    this.sessions.setMapping(key, target.id)
    log.info(`目标对话：${target.id}（${target.kind}）`)

    // 4) collect：等 assistant 回复出现并写完
    const timeoutMs = this.cfg.session.timeout_min * 60000
    const collectStart = Date.now()
    let lastRevision = -1
    let settle = 0
    let sawReply = false
    while (Date.now() - collectStart < timeoutMs) {
      await sleep(kivio.poll_interval_ms)
      const snap = this.store.assistantTextSince(target.id, sendTs)
      if (!snap) continue
      if (snap.count > 0 && snap.text.trim() !== '') sawReply = true
      if (snap.revision !== lastRevision) {
        lastRevision = snap.revision
        settle = 0
      } else {
        settle += 1
      }
      if (sawReply && settle >= kivio.settle_polls) {
        const reply = snap.text.trim()
        log.info(`取到回复（rev=${snap.revision}，${reply.length} 字）`)
        await this.#sendChunked(inbound, reply)
        return
      }
    }
    if (sawReply) {
      // 超时但已有部分回复：把已有内容发回，避免丢字。
      const snap = this.store.assistantTextSince(target.id, sendTs)
      await this.#safeReply(inbound, `⚠️ 超时（${this.cfg.session.timeout_min} 分钟）但回复可能未写完，以下为已生成部分：`)
      await this.#sendChunked(inbound, snap?.text?.trim() ?? '（无内容）')
    } else {
      throw new Error(`超时（${this.cfg.session.timeout_min} 分钟）未检测到 Kivio 回复`)
    }
  }

  /** 分段发送：按 split_length 切块，带 i/N 序号。 */
  async #sendChunked(inbound, text) {
    const limit = Math.max(200, Number(this.cfg.session.split_length) || 4000)
    const gap = Math.max(0, Number(this.cfg.session.split_interval_ms) || 0)
    if (text.length <= limit) {
      return this.#safeReply(inbound, text)
    }
    const chunks = []
    for (let i = 0; i < text.length; i += limit) chunks.push(text.slice(i, i + limit))
    for (let i = 0; i < chunks.length; i++) {
      await this.#safeReply(inbound, `（${i + 1}/${chunks.length}）\n${chunks[i]}`)
      if (i < chunks.length - 1 && gap) await sleep(gap)
    }
  }
}
