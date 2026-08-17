// onebot-im —— dsh 官方插件路线（方案 D）。
//
// QQ(NapCat/OneBot11) 消息 → 本插件 → ctx.agents 会话（官方 Agent/LLM/工具链）→ 回复回发 QQ。
// 不经 Kivio 对话框（Kivio 只作可选展示副本）；会话持久化在 .dsh/sessions/，可跨进程 resume。
//
// 写法对标官方范例 .dsh/profiles/kivio/kivio-dsh-bridge.mjs：
//   - ctx.agents.create / resume + agentPresets.mount 组装 agent；
//   - agent.followup(createUserMessage(...)) 注入用户消息；
//   - ctx.on('session/event') 收 assistant/message 文本、以 turn/end 判定回合结束；
//   - agent.cancel({kind:'user'}) 取消；ctx.userQuestions.registerProvider 把追问转发到 QQ。

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import WebSocket from 'ws'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** OneBot 消息段数组 -> 纯文本（字符串格式剥 CQ 码）。 */
function messageToText(message) {
  if (typeof message === 'string') return message.replace(/\[CQ:[^\]]*\]/g, '').trim()
  if (!Array.isArray(message)) return ''
  let out = ''
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text' && typeof seg.data?.text === 'string') out += seg.data.text
    else if (seg.type === 'at') out += `@${seg.data?.qq ?? ''}`
  }
  return out.trim()
}

function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

const HELP_TEXT = [
  'Kivio/DSH IM（方案 D：dsh 直驱）指令：',
  '  /new     新建会话（旧的保留在 .dsh/sessions，可再 resume）',
  '  /stop    停止当前正在执行的一轮',
  '  /status  查看当前状态',
  '  /help    显示本帮助',
  '其余文本将作为 prompt 送入 dsh agent 会话，回复回发到本会话。',
].join('\n')

/* ========================================================================== */
/* OneBot11 正向 WS 客户端                                                     */
/* ========================================================================== */

class OneBotLink {
  constructor(ctx, config, onMessage) {
    this.ctx = ctx
    this.config = config
    this.onMessage = onMessage
    this.ws = null
    this.stopped = false
    this.echoSeq = 0
    this.pending = new Map()
    this.reconnectTimer = null
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start() {
    this.stopped = false
    this.connect()
    this.ctx.effect(() => () => this.stop(), 'onebot-im.link')
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('onebot link stopped'))
    }
    this.pending.clear()
    try { this.ws?.close(1000) } catch { /* ignore */ }
    this.ws = null
  }

  connect() {
    if (this.stopped) return
    const url = new URL(this.config.wsUrl)
    if (this.config.accessToken) url.searchParams.set('access_token', this.config.accessToken)
    let ws
    try {
      ws = new WebSocket(url, {
        headers: this.config.accessToken
          ? { Authorization: `Bearer ${this.config.accessToken}` }
          : undefined,
      })
    } catch (err) {
      log('error', `WebSocket 构造失败：${err.message}`)
      return this.scheduleReconnect()
    }
    this.ws = ws

    ws.on('open', () => {
      log('info', `已连接 OneBot 服务端 ${url.host}`)
      this.call('get_login_info', {})
        .then((r) => log('info', `机器人账号：${r?.nickname} (${r?.user_id})`))
        .catch(() => {})
    })
    ws.on('message', (data) => this.onPacket(data))
    ws.on('close', () => {
      log('warn', 'OneBot 连接关闭，准备重连')
      this.failAll(new Error('onebot connection closed'))
      this.scheduleReconnect()
    })
    ws.on('error', (err) => log('error', `OneBot 连接错误：${err.message}`))
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, Math.max(1000, this.config.reconnectIntervalMs))
  }

  failAll(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  onPacket(data) {
    let packet
    try {
      packet = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    if (packet.echo !== undefined && this.pending.has(packet.echo)) {
      const p = this.pending.get(packet.echo)
      this.pending.delete(packet.echo)
      clearTimeout(p.timer)
      if (packet.status?.retcode === 0 || packet.data !== undefined) return p.resolve(packet.data)
      return p.reject(new Error(`onebot api 失败 retcode=${packet.status?.retcode} ${packet.status?.msg ?? ''}`))
    }
    if (packet.post_type === 'message') {
      const text = messageToText(packet.message)
      if (!text) return
      this.onMessage({
        messageType: packet.message_type,
        userId: String(packet.user_id),
        groupId: packet.group_id !== undefined && packet.group_id !== null ? String(packet.group_id) : null,
        sender: packet.sender?.nickname ?? packet.sender?.card ?? String(packet.user_id),
        text,
        ts: packet.time ? packet.time * 1000 : Date.now(),
      })
    }
  }

  call(action, params) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('onebot 未连接'))
      const echo = `${++this.echoSeq}-${randomUUID().slice(0, 8)}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`onebot api "${action}" 超时`))
      }, 15000)
      this.pending.set(echo, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ action, params, echo }), (err) => {
        if (err) {
          this.pending.delete(echo)
          clearTimeout(timer)
          reject(err)
        }
      })
    })
  }

  async sendPrivate(userId, text) {
    return this.call('send_private_msg', { user_id: Number(userId), message: text })
  }

  async sendGroup(groupId, text) {
    return this.call('send_group_msg', { group_id: Number(groupId), message: text })
  }

  async reply(inbound, text) {
    if (inbound.messageType === 'group' && inbound.groupId) return this.sendGroup(inbound.groupId, text)
    return this.sendPrivate(inbound.userId, text)
  }
}

/* ========================================================================== */
/* 日志（ctx.logger 可用则用之，否则 console）                                  */
/* ========================================================================== */

let loggerSink = console
function log(level, msg) {
  const fn = loggerSink?.[level]
  if (typeof fn === 'function') fn(`[onebot-im] ${msg}`)
}

/* ========================================================================== */
/* 插件主体                                                                    */
/* ========================================================================== */

export const name = 'onebot-im'

// agents：会话工厂；sessionPersistence：resume 落盘；agentPresets：四档模式组装；
// userQuestions：把 agent 追问转发到 QQ（可选存在）。
export const inject = ['agents', 'sessionPersistence', 'agentPresets', 'userQuestions']

export const Config = Schema.object({
  wsUrl: Schema.string().default('ws://127.0.0.1:3001').description('NapCat/Lagrange OneBot11 正向 WS 地址'),
  accessToken: Schema.string().default('').description('OneBot access token（可空）'),
  reconnectIntervalMs: Schema.number().default(5000).description('断线重连间隔'),
  allowUsers: Schema.array(String).default([]).description('私聊白名单（QQ 号）；空 = 拒绝全部'),
  allowGroups: Schema.array(String).default([]).description('群白名单（群号）；空 = 忽略群消息'),
  onNotAllowed: Schema.string().default('drop').description('白名单外消息处理：drop | reject'),
  provider: Schema.string().default('deepseek-official').description('LLM provider id（见 cordis.patch.yml 里 llm-pi-ai 注入的供应商）'),
  model: Schema.string().default('deepseek-official').description('模型 id'),
  maxTokens: Schema.number().description('单轮输出上限（不填用默认）'),
  agentPreset: Schema.string().default('standard').description('Agent 模式：standard | code | minimal | cordis'),
  workspaceRoot: Schema.string().default('').description('每会话工作目录根（默认 <插件目录>/workspaces）'),
  timeoutMs: Schema.number().default(600000).description('单轮执行超时'),
  idleDisposeMs: Schema.number().default(1800000).description('空闲多久后卸载 agent（会话仍在盘，可 resume）'),
  splitLength: Schema.number().default(4000).description('回复分段单条最大字符数'),
  splitIntervalMs: Schema.number().default(400).description('分段发送间隔'),
  ackMessage: Schema.boolean().default(true).description('收到消息先回执一句'),
})

export function apply(ctx, config) {
  if (ctx.logger) loggerSink = ctx.logger

  const allowUsers = new Set(config.allowUsers.map(String))
  const allowGroups = new Set(config.allowGroups.map(String))
  const workspaceRoot = path.resolve(config.workspaceRoot || path.join(PLUGIN_DIR, 'workspaces'))
  fs.mkdirSync(workspaceRoot, { recursive: true })

  /** key -> { key, sessionId, handle, busy, queue[], pending, pendingAnswer, lastActive, lastError } */
  const records = new Map()
  const bySessionId = new Map()

  const indexFile = path.join(PLUGIN_DIR, 'onebot-sessions.json')
  function loadIndex() {
    try {
      return JSON.parse(fs.readFileSync(indexFile, 'utf8')) ?? {}
    } catch {
      return {}
    }
  }
  function saveIndex() {
    const obj = {}
    for (const [k, r] of records) obj[k] = { sessionId: r.sessionId, createdAt: r.createdAt, lastActive: r.lastActive }
    fs.writeFileSync(indexFile, JSON.stringify(obj, null, 2), 'utf8')
  }
  const persisted = loadIndex()

  function recordOf(key) {
    let r = records.get(key)
    if (!r) {
      r = {
        key,
        sessionId: persisted[key]?.sessionId ?? null,
        createdAt: persisted[key]?.createdAt ?? Date.now(),
        handle: null,
        busy: false,
        queue: [],
        pending: null,
        pendingAnswer: null,
        lastActive: Date.now(),
        lastError: '',
        replyTo: null,
      }
      records.set(key, r)
    }
    return r
  }

  /* ---------------- agent 装配（对标 kivio-dsh-bridge） ---------------- */

  async function mountPreset(agentCtx, presetId) {
    const presets = ctx.get('agentPresets')
    if (!presets) return
    await presets.mount(agentCtx, presetId)
  }

  function agentOptions() {
    return {
      provider: config.provider,
      model: config.model,
      ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
    }
  }

  async function ensureAgent(record) {
    if (record.handle) return record.handle
    if (record.sessionId) {
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: record.sessionId,
          agentOptions: agentOptions(),
          setup: (agentCtx) => {
            const recorded = agentCtx.agent?.session?.header?.agentPreset
            return mountPreset(agentCtx, recorded || config.agentPreset)
          },
        })
        record.handle = handle
        bySessionId.set(String(handle.agent.id), record)
        log('info', `${record.key} 已恢复会话 ${record.sessionId}`)
        return handle
      } catch (err) {
        log('warn', `${record.key} resume ${record.sessionId} 失败（${err.message}），改为新建`)
        record.sessionId = null
      }
    }
    const sessionId = `onebot-${randomUUID()}`
    const cwd = path.join(workspaceRoot, sessionId)
    fs.mkdirSync(cwd, { recursive: true })
    const handle = await ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset: config.agentPreset },
      agentOptions: agentOptions(),
      setup: (agentCtx) => mountPreset(agentCtx, config.agentPreset),
    })
    record.handle = handle
    record.sessionId = sessionId
    bySessionId.set(String(handle.agent.id), record)
    saveIndex()
    log('info', `${record.key} 新建会话 ${sessionId}（cwd=${cwd}）`)
    return handle
  }

  /* ---------------- 会话事件 -> 收集回复 / 判定回合结束 ---------------- */

  ctx.on('session/event', (session, event) => {
    const record = bySessionId.get(String(session?.id ?? ''))
    if (!record?.pending) return
    if (event?.type === 'assistant/message') {
      const text = textOfBlocks(event.data?.message?.content)
      if (text) record.pending.texts.push(text)
    } else if (event?.type === 'turn/end') {
      settlePending(record, `turn:${event.data?.reason ?? 'ended'}`)
    }
  })

  function settlePending(record, via) {
    const p = record.pending
    if (!p) return
    record.pending = null
    clearTimeout(p.timer)
    p.resolve({ via, texts: p.texts, startedAt: p.startedAt })
  }

  /* ---------------- 单轮执行 ---------------- */

  async function runOne(record, item) {
    const { text, inbound } = item
    const handle = await ensureAgent(record)
    const agent = handle.agent

    if (config.ackMessage) await safeReply(inbound, '⏳ 已提交给 dsh 会话…')

    const result = await new Promise((resolve) => {
      const pending = { texts: [], startedAt: Date.now(), resolve }
      record.pending = pending
      pending.timer = setTimeout(() => {
        // 超时：取消并把已生成部分发回。
        try { agent.cancel({ kind: 'user' }) } catch { /* ignore */ }
        settlePending(record, 'timeout')
      }, config.timeoutMs)
      // 安全网：turn/end 丢失时由 whenIdle 兜底收尾。
      void agent.whenIdle().then(async () => {
        await sleep(2000)
        if (record.pending === pending) settlePending(record, 'idle')
      })
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }))
    })

    const reply = result.texts.map((t) => t.trim()).filter(Boolean).join('\n\n')
    if (result.via === 'timeout') {
      await safeReply(inbound, `⚠️ 超时（${Math.round(config.timeoutMs / 60000)} 分钟），已请求取消。以下为已生成部分：`)
      return sendChunked(inbound, reply || '（无输出）')
    }
    if (result.via.startsWith('turn:') && result.via !== 'turn:completed') {
      await safeReply(inbound, `⚠️ 本轮以 ${result.via.slice(5)} 结束。`)
    }
    if (!reply) {
      return safeReply(inbound, '（本轮没有文本输出）')
    }
    log('info', `${record.key} 回复 ${reply.length} 字（${result.via}）`)
    return sendChunked(inbound, reply)
  }

  async function pump(record) {
    if (record.busy) return
    record.busy = true
    try {
      while (record.queue.length > 0) {
        const item = record.queue.shift()
        record.lastActive = Date.now()
        try {
          await runOne(record, item)
          record.lastError = ''
        } catch (err) {
          record.lastError = err.message
          log('error', `${record.key} 单轮失败：${err.message}`)
          await safeReply(item.inbound, `执行失败：${err.message}`)
        }
        record.lastActive = Date.now()
        saveIndex()
      }
    } finally {
      record.busy = false
    }
  }

  /* ---------------- 入站消息 ---------------- */

  const link = new OneBotLink(ctx, config, onInbound)

  function onInbound(inbound) {
    const allowed = inbound.messageType === 'group'
      ? allowGroups.has(inbound.groupId)
      : allowUsers.has(inbound.userId)
    if (!allowed) {
      if (config.onNotAllowed === 'reject') {
        link.reply(inbound, '未授权使用本机器人（白名单外）。').catch(() => {})
      }
      return
    }

    const key = inbound.groupId ? `qq-group:${inbound.groupId}:${inbound.userId}` : `qq:${inbound.userId}`
    const record = recordOf(key)
    record.replyTo = inbound
    record.lastActive = Date.now()

    // agent 追问等待中：这条消息作为答案，不进队列。
    if (record.pendingAnswer) {
      const waiter = record.pendingAnswer
      record.pendingAnswer = null
      clearTimeout(waiter.timer)
      waiter.resolve(inbound.text)
      return
    }

    if (inbound.text.startsWith('/')) return handleCommand(record, inbound)

    if (record.queue.length >= 10) {
      return void link.reply(inbound, '队列已满，请稍后再试。').catch(() => {})
    }
    record.queue.push({ text: inbound.text, inbound })
    if (record.busy) {
      link.reply(inbound, '当前仍在执行上一条，已排队。').catch(() => {})
    }
    void pump(record)
  }

  function handleCommand(record, inbound) {
    const [cmd, ...args] = inbound.text.trim().split(/\s+/)
    switch (cmd) {
      case '/help':
        return void link.reply(inbound, HELP_TEXT).catch(() => {})
      case '/status': {
        const lines = [
          `状态：${record.busy ? '执行中' : '空闲'}（排队 ${record.queue.length}）`,
          `会话：${record.sessionId ?? '未建立'}`,
          `agent：${record.handle ? record.handle.agent.status : '未加载（空闲已卸载，下一条消息自动 resume）'}`,
        ]
        if (record.lastError) lines.push(`上次错误：${record.lastError}`)
        return void link.reply(inbound, lines.join('\n')).catch(() => {})
      }
      case '/new': {
        void (async () => {
          if (record.handle) {
            try { await record.handle.dispose() } catch { /* ignore */ }
            bySessionId.delete(String(record.sessionId))
            record.handle = null
          }
          record.sessionId = null
          saveIndex()
          await safeReply(inbound, '已新建会话映射（旧会话保留在 .dsh/sessions，可后续 resume）。')
        })()
        return
      }
      case '/stop': {
        if (record.handle) {
          try {
            record.handle.agent.cancel({ kind: 'user' })
            return void safeReply(inbound, '已发出取消请求。')
          } catch (err) {
            return void safeReply(inbound, `取消失败：${err.message}`)
          }
        }
        return void safeReply(inbound, '当前没有加载中的 agent。')
      }
      default:
        return void link.reply(inbound, `未知指令 ${cmd}，/help 查看可用指令。`).catch(() => {})
    }
  }

  async function safeReply(inbound, text) {
    try {
      await link.reply(inbound, text)
    } catch (err) {
      log('warn', `回发失败：${err.message}`)
    }
  }

  async function sendChunked(inbound, text) {
    if (text.length <= config.splitLength) return safeReply(inbound, text)
    const chunks = []
    for (let i = 0; i < text.length; i += config.splitLength) chunks.push(text.slice(i, i + config.splitLength))
    for (let i = 0; i < chunks.length; i++) {
      await safeReply(inbound, `（${i + 1}/${chunks.length}）\n${chunks[i]}`)
      if (i < chunks.length - 1 && config.splitIntervalMs) await sleep(config.splitIntervalMs)
    }
  }

  /* ---------------- agent 追问 -> QQ 往返（对标 bridge 的 askViaHost） ---------------- */

  ctx.effect(() => {
    const questions = ctx.get('userQuestions')
    if (!questions?.registerProvider) return
    return questions.registerProvider({
      ask: async (request) => {
        const sessionId = String(request.agent?.id ?? '')
        const record = bySessionId.get(sessionId)
        if (!record?.replyTo) throw new Error('no interactive IM channel for this session')
        const qs = Array.isArray(request.questions) ? request.questions : []
        const first = qs[0]
        const lines = [first ? `❓ ${first.header ?? 'agent 追问'}：${first.question}` : '❓ agent 需要你的补充输入']
        if (first?.detail) lines.push(String(first.detail))
        if (Array.isArray(first?.options) && first.options.length > 0) {
          lines.push(`选项：${first.options.join(' / ')}`)
          lines.push('（直接回复选项文本，或回复自定义内容）')
        }
        lines.push(`（${Math.round(config.timeoutMs / 60000)} 分钟内有效）`)
        await safeReply(record.replyTo, lines.join('\n'))

        const answer = await new Promise((resolve) => {
          record.pendingAnswer = { resolve }
          record.pendingAnswer.timer = setTimeout(() => {
            if (record.pendingAnswer) record.pendingAnswer = null
            resolve(null)
          }, config.timeoutMs)
        })
        if (answer === null) {
          return { answers: [] }
        }
        const selected = []
        const custom = String(answer).trim()
        if (Array.isArray(first?.options) && first.options.includes(custom)) selected.push(custom)
        const answers = qs.map((q) => ({
          id: q.id,
          selected: q === first ? selected : [],
          ...(q === first && selected.length === 0 ? { custom } : {}),
        }))
        return { answers }
      },
    })
  }, 'onebot-im.user-questions')

  /* ---------------- 空闲卸载（内存对策）+ 退出清理 ---------------- */

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [, record] of records) {
      if (!record.handle || record.busy || record.pending || record.pendingAnswer) continue
      if (now - record.lastActive > config.idleDisposeMs) {
        const handle = record.handle
        record.handle = null
        bySessionId.delete(String(record.sessionId))
        log('info', `${record.key} 空闲超时，卸载 agent（会话保留在盘）`)
        handle.dispose().catch((err) => log('warn', `dispose 失败：${err.message}`))
      }
    }
  }, 60000)
  ctx.effect(() => () => clearInterval(sweep), 'onebot-im.sweep')

  ctx.effect(() => () => {
    for (const [, record] of records) {
      if (record.handle) record.handle.dispose().catch(() => {})
    }
  }, 'onebot-im.dispose')

  link.start()
  log('info', `插件已启动（ws=${config.wsUrl}，workspace=${workspaceRoot}，provider=${config.provider}/${config.model}）`)
  if (allowUsers.size === 0 && allowGroups.size === 0) {
    log('warn', '白名单为空：所有消息都会被忽略。请在 cordis.patch.yml 的 onebot-im 配置里加 allowUsers/allowGroups。')
  }
}
