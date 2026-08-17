// Kivio 对话存储只读访问：index.json 快照 / conv_<id>.json 读取 / revision 游标。
// 事实依据（方案文档第 0 节）：Kivio 每轮都会重写 conv json 与 index.json，
// 但不监听目录 —— 所以这里只做读，写入不会触发任何执行。

import fs from 'node:fs'
import path from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger('convstore')

/** 消息 content 规整为纯文本：字符串直接返回；块数组只取 text 块。 */
export function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  }
  return ''
}

export class ConvStore {
  /**
   * @param {string} dir conversations 目录
   */
  constructor(dir) {
    this.dir = dir
  }

  #convPath(id) {
    // 防目录穿越：id 只允许 conv_xxx 形态。
    if (!/^[\w.-]+$/.test(id)) throw new Error(`非法会话 id: ${id}`)
    return path.join(this.dir, `${id}.json`)
  }

  exists(id) {
    try {
      return fs.existsSync(this.#convPath(id))
    } catch {
      return false
    }
  }

  /** 读 index.json，返回 Map(id -> {revision, title, updated_at, message_count})。 */
  readIndex() {
    const file = path.join(this.dir, 'index.json')
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : raw?.conversations
    const map = new Map()
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item?.id) map.set(item.id, item)
      }
    }
    return map
  }

  /** 读某个对话文件，返回精简结构；文件不存在/解析失败返回 null。 */
  readConv(id) {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#convPath(id), 'utf8'))
      const messages = Array.isArray(raw?.messages) ? raw.messages : []
      return {
        id: raw?.id ?? id,
        revision: Number(raw?.revision ?? 0),
        title: raw?.title ?? '',
        updated_at: Number(raw?.updated_at ?? 0),
        runtime: raw?.agent_runtime?.kind ?? 'builtin',
        messages: messages.map((m) => ({
          role: m?.role ?? '',
          text: contentToText(m?.content),
          ts: Number(m?.timestamp ?? 0),
        })),
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.debug(`读取 ${id} 失败：${err.message}`)
      return null
    }
  }

  /**
   * 取对话中 timestamp > sinceTs 的 assistant 消息文本（按时间排序拼接）。
   */
  assistantTextSince(id, sinceTs) {
    const conv = this.readConv(id)
    if (!conv) return null
    const picked = conv.messages
      .filter((m) => m.role === 'assistant' && m.ts > sinceTs && m.text.trim() !== '')
      .sort((a, b) => a.ts - b.ts)
    return {
      revision: conv.revision,
      title: conv.title,
      updated_at: conv.updated_at,
      text: picked.map((m) => m.text.trim()).join('\n\n'),
      count: picked.length,
    }
  }

  /**
   * 发送前的基线快照：当前 index 全量 id -> revision。
   */
  baseline() {
    try {
      const idx = this.readIndex()
      const out = new Map()
      for (const [id, item] of idx) out.set(id, Number(item?.revision ?? 0))
      return out
    } catch (err) {
      log.warn(`读 index.json 失败：${err.message}`)
      return new Map()
    }
  }

  /**
   * 对比基线，识别“这次发送落进了哪个对话”。
   * 优先级：revision 增长的已知对话 > 新出现的对话。
   * @returns {{id:string, kind:'bumped'|'new'}|null}
   */
  diffBaseline(baseline, preferredId = null) {
    let idx
    try {
      idx = this.readIndex()
    } catch {
      return null
    }
    if (preferredId && idx.has(preferredId)) {
      const before = baseline.get(preferredId)
      const now = Number(idx.get(preferredId)?.revision ?? 0)
      if (before === undefined || now > before) return { id: preferredId, kind: 'bumped' }
    }
    let bumped = null
    for (const [id, item] of idx) {
      const now = Number(item?.revision ?? 0)
      const before = baseline.get(id)
      if (before !== undefined && now > before) {
        if (!bumped || now > Number(idx.get(bumped)?.revision ?? 0)) bumped = id
      }
    }
    if (bumped) return { id: bumped, kind: 'bumped' }
    for (const id of idx.keys()) {
      if (!baseline.has(id)) return { id, kind: 'new' }
    }
    return null
  }
}
