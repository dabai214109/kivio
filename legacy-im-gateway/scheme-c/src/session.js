// 会话管理：IM 用户 <-> Kivio conv_<id> 映射（持久化到 data/sessions.json），
// 每用户消息队列与运行状态、指令处理（/new /stop /status /bind /help）。

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from './logger.js'

const log = createLogger('session')

const FORGET_MS = 0

export class SessionManager {
  /**
   * @param {object} options
   * @param {string} options.dataDir 数据目录（sessions.json 所在）
   * @param {{timeout_min:number, max_queue:number, forget_after_min:number}} options.config
   */
  constructor({ dataDir, config }) {
    this.config = config
    this.file = path.join(dataDir, 'sessions.json')
    /** @type {Map<string, {conv_id:string, title:string, created_at:number, last_active:number}>} */
    this.mapping = new Map()
    /** @type {Map<string, {queue:Array, running:boolean, lastError:string}>} */
    this.runtime = new Map()
    this.#load()
  }

  #load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      for (const [k, v] of Object.entries(raw ?? {})) {
        if (v?.conv_id) this.mapping.set(k, v)
      }
      log.info(`已加载 ${this.mapping.size} 条会话映射`)
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn(`sessions.json 读取失败：${err.message}`)
    }
  }

  #save() {
    const obj = Object.fromEntries(this.mapping)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(obj, null, 2), 'utf8')
  }

  static keyOf(inbound) {
    return inbound.group_id
      ? `qq-group:${inbound.group_id}:${inbound.user_id}`
      : `qq:${inbound.user_id}`
  }

  rt(key) {
    let r = this.runtime.get(key)
    if (!r) {
      r = { queue: [], running: false, lastError: '', startedAt: 0 }
      this.runtime.set(key, r)
    }
    return r
  }

  getMapping(key) {
    const m = this.mapping.get(key)
    if (!m) return null
    const forgetMs = Number(this.config.forget_after_min ?? FORGET_MS) * 60000
    if (forgetMs > 0 && Date.now() - m.last_active > forgetMs) {
      this.mapping.delete(key)
      this.#save()
      log.info(`会话 ${key} 超过 ${this.config.forget_after_min} 分钟未活跃，映射已过期`)
      return null
    }
    return m
  }

  setMapping(key, convId, title = '') {
    this.mapping.set(key, {
      conv_id: convId,
      title,
      created_at: this.mapping.get(key)?.created_at ?? Date.now(),
      last_active: Date.now(),
    })
    this.#save()
  }

  dropMapping(key) {
    const had = this.mapping.delete(key)
    if (had) this.#save()
    return had
  }

  touch(key) {
    const m = this.mapping.get(key)
    if (m) {
      m.last_active = Date.now()
      this.#save()
    }
  }

  /** 入队一条待发送文本；超限返回 false。 */
  enqueue(key, text, inbound) {
    const rt = this.rt(key)
    if (rt.queue.length >= this.config.max_queue) return false
    rt.queue.push({ text, inbound })
    return true
  }

  dequeue(key) {
    return this.rt(key).queue.shift() ?? null
  }

  /** /status 文本。 */
  statusText(key) {
    const m = this.mapping.get(key)
    const rt = this.rt(key)
    const lines = [
      `状态：${rt.running ? '执行中' : '空闲'}`,
      `排队：${rt.queue.length}/${this.config.max_queue}`,
    ]
    if (rt.running && rt.startedAt) {
      const min = Math.floor((Date.now() - rt.startedAt) / 60000)
      lines.push(`当前轮已运行：${min} 分钟（超时上限 ${this.config.timeout_min} 分钟）`)
    }
    if (rt.lastError) lines.push(`上次错误：${rt.lastError}`)
    if (m) lines.push(`Kivio 会话：${m.conv_id}${m.title ? `（${m.title.slice(0, 30)}）` : ''}`)
    else lines.push('Kivio 会话：尚未建立（下一条消息将新建）')
    return lines.join('\n')
  }
}

export const HELP_TEXT = [
  'Kivio IM Gateway 指令：',
  '  /new     新建 Kivio 对话（当前映射解除，下一条消息在新对话里执行）',
  '  /stop    停止当前正在执行的一轮',
  '  /status  查看当前状态',
  '  /bind <conv_id>  绑定到指定 Kivio 对话（如 conv_xxx-…）',
  '  /help    显示本帮助',
  '其余任何文本都会原样送进 Kivio 对话框执行，执行结果回发到本会话。',
].join('\n')
