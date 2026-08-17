// OneBot11 正向 WebSocket 客户端：连接 NapCat/Lagrange，收消息事件、发 API 调用。
// 只实现网关需要的最小子集：message 事件、send_private_msg / send_group_msg。

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { createLogger } from '../logger.js'

const log = createLogger('onebot')

// OneBot 消息段数组 -> 纯文本。字符串格式按纯文本处理并剥掉 CQ 码。
export function messageToText(message) {
  if (typeof message === 'string') {
    return message.replace(/\[CQ:[^\]]*\]/g, '').trim()
  }
  if (!Array.isArray(message)) return ''
  let out = ''
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    if (seg.type === 'text' && typeof seg.data?.text === 'string') out += seg.data.text
    else if (seg.type === 'at') out += `@${seg.data?.qq ?? ''}`
    // image/face/record 等非文本段忽略。
  }
  return out.trim()
}

export class OneBotClient extends EventEmitter {
  /**
   * @param {{ws_url:string, access_token:string, reconnect_interval_sec:number}} config
   */
  constructor(config) {
    super()
    this.config = config
    this.ws = null
    this.closed = false
    this.echoSeq = 0
    this.pending = new Map() // echo -> {resolve, reject, timer}
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start() {
    this.closed = false
    this.#connect()
  }

  stop() {
    this.closed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('onebot client stopped'))
    }
    this.pending.clear()
    if (this.ws) {
      try { this.ws.close(1000) } catch { /* ignore */ }
      this.ws = null
    }
  }

  #connect() {
    if (this.closed) return
    const url = new URL(this.config.ws_url)
    if (this.config.access_token) url.searchParams.set('access_token', this.config.access_token)

    log.info(`连接 ${url.host}${url.pathname} ...`)
    let ws
    try {
      ws = new WebSocket(url, {
        headers: this.config.access_token
          ? { Authorization: `Bearer ${this.config.access_token}` }
          : undefined,
      })
    } catch (err) {
      log.error(`WebSocket 构造失败：${err.message}，${this.config.reconnect_interval_sec}s 后重试`)
      return this.#scheduleReconnect()
    }
    this.ws = ws

    ws.on('open', () => {
      log.info('已连接 OneBot 服务端')
      this.call('get_login_info', {})
        .then((r) => log.info(`机器人账号：${r?.nickname} (${r?.user_id})`))
        .catch(() => { /* 不影响主流程 */ })
      this.emit('connected')
    })

    ws.on('message', (data) => this.#onPacket(data))

    ws.on('close', (code, reason) => {
      log.warn(`连接关闭 code=${code} ${reason?.length ? `reason=${reason}` : ''}`)
      this.#failAllPending(new Error('onebot connection closed'))
      this.emit('disconnected')
      this.#scheduleReconnect()
    })

    ws.on('error', (err) => {
      log.error(`连接错误：${err.message}`)
    })
  }

  #scheduleReconnect() {
    if (this.closed) return
    const sec = Math.max(1, Number(this.config.reconnect_interval_sec) || 5)
    setTimeout(() => this.#connect(), sec * 1000).unref?.()
  }

  #failAllPending(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }

  #onPacket(data) {
    let packet
    try {
      packet = JSON.parse(data.toString('utf8'))
    } catch {
      return log.warn('收到无法解析的数据包，已忽略')
    }

    if (packet.echo !== undefined && this.pending.has(packet.echo)) {
      const p = this.pending.get(packet.echo)
      this.pending.delete(packet.echo)
      clearTimeout(p.timer)
      if (packet.status?.retcode === 0 || packet.data !== undefined) return p.resolve(packet.data)
      const err = new Error(`onebot api 失败 retcode=${packet.status?.retcode} msg=${packet.status?.msg ?? packet.message ?? ''}`)
      return p.reject(err)
    }

    if (packet.post_type === 'meta_event' && packet.meta_event_type === 'heartbeat') return
    if (packet.post_type === 'meta_event' && packet.meta_event_type === 'lifecycle') {
      log.info(`生命周期事件：${packet.sub_type}`)
      return
    }

    if (packet.post_type === 'message') {
      const text = messageToText(packet.message)
      const inbound = {
        platform: 'qq',
        message_type: packet.message_type, // private | group
        user_id: String(packet.user_id),
        group_id: packet.group_id !== undefined ? String(packet.group_id) : null,
        sender: packet.sender?.nickname ?? packet.sender?.card ?? String(packet.user_id),
        text,
        ts: packet.time ? packet.time * 1000 : Date.now(),
        raw: packet,
      }
      if (text) this.emit('message', inbound)
      return
    }

    log.debug('未处理的事件包', { post_type: packet.post_type, sub_type: packet.sub_type })
  }

  /** 调用 OneBot API，15s 超时。 */
  call(action, params) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('onebot 未连接'))
      const echo = `${process.pid}-${++this.echoSeq}-${randomUUID().slice(0, 8)}`
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

  /** 按入站消息的来源渠道回复。 */
  async reply(inbound, text) {
    if (inbound.message_type === 'group' && inbound.group_id) return this.sendGroup(inbound.group_id, text)
    return this.sendPrivate(inbound.user_id, text)
  }
}
