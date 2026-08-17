// 集成测试：mock cordis ctx + mock agent + 模拟 OneBot 服务端，验证插件主链路：
//   入站消息 -> ensureAgent(create) -> followup -> session/event 收集 -> turn/end -> 回发 QQ
//   以及：排队串行、/status、/new、追问转发（userQuestions）。
import { WebSocketServer } from 'ws'
import * as plugin from './onebot-im.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 模拟 OneBot 服务端 ---------------- */
const wss = new WebSocketServer({ port: 3998 })
let botWs = null
const botReplies = []
wss.on('connection', (ws) => {
  botWs = ws
  ws.on('message', (raw) => {
    const p = JSON.parse(raw.toString('utf8'))
    if (p.action === 'get_login_info') {
      ws.send(JSON.stringify({ status: { retcode: 0 }, echo: p.echo, data: { user_id: 10001, nickname: '测试机器人' } }))
    } else {
      botReplies.push({ action: p.action, params: p.params })
      ws.send(JSON.stringify({ status: { retcode: 0 }, echo: p.echo, data: { message_id: botReplies.length } }))
    }
  })
})
function pushMessage(text, userId = '42') {
  botWs?.send(JSON.stringify({
    post_type: 'message', message_type: 'private', user_id: Number(userId),
    time: Math.floor(Date.now() / 1000), sender: { nickname: 'T' },
    message: [{ type: 'text', data: { text } }],
  }))
}
const textsToUser = () => botReplies.filter((r) => r.action === 'send_private_msg' && r.params.user_id === 42).map((r) => r.params.message)

/* ---------------- 模拟 cordis ctx / agents ---------------- */
const handlers = {}   // 事件名 -> [fn]
const created = []
let askProvider = null
let seq = 0

function makeMockAgent(sessionId, opts) {
  return {
    id: sessionId,
    session: { id: sessionId, header: { agentPreset: opts.meta?.agentPreset } },
    status: 'idle',
    cancel() { this.status = 'idle' },
    whenIdle() { return Promise.resolve() },
    followup(message) {
      const text = message.content?.[0]?.text ?? ''
      created.push({ sessionId, text, preset: opts.meta?.agentPreset, provider: opts.agentOptions?.provider })
      this.status = 'running'
      setTimeout(() => {
        for (const h of handlers['session/event'] ?? []) {
          h(this.session, { type: 'user/message', seq: seq++, data: message })
          h(this.session, { type: 'assistant/message', seq: seq++, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `回声：${text}` }] } } })
          h(this.session, { type: 'turn/end', seq: seq++, data: { turn: 1, reason: 'completed' } })
        }
        this.status = 'idle'
      }, 50)
    },
  }
}

const mockCtx = {
  effect(fn) { const dispose = fn(); return () => dispose?.() },
  on(name, h) { (handlers[name] ??= []).push(h) },
  get(name) {
    if (name === 'agentPresets') return { mount: async () => {} }
    if (name === 'userQuestions') return { registerProvider: (p) => { askProvider = p; return () => {} } }
    return undefined
  },
  agents: {
    async create(opts) {
      const agent = makeMockAgent(opts.sessionId, opts)
      return { agent, dispose: async () => {} }
    },
    async resume() { throw new Error('no persisted session in mock') },
  },
}

/* ---------------- 跑插件 ---------------- */
const disposers = []
const config = plugin.Config({ wsUrl: 'ws://127.0.0.1:3998', allowUsers: ['42'], ackMessage: true, timeoutMs: 8000, reconnectIntervalMs: 500 })
// 拦截 effect 以便收尾清理
mockCtx.effect = (fn) => { const d = fn(); disposers.push(d); return d }

plugin.apply(mockCtx, config)

await sleep(400) // 等 WS 连上

let pass = true
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? `：${detail}` : ''}`)
  if (!cond) pass = false
}

// 1. 基本回声
pushMessage('你好')
await sleep(700)
const t1 = textsToUser()
check('ack 回执', t1.some((x) => x.includes('已提交')))
check('回复送达', t1.some((x) => x === '回声：你好'), JSON.stringify(t1))
check('agent 创建参数', created[0]?.preset === 'standard' && created[0]?.provider === 'deepseek-official')

// 2. 排队串行：连发两条，按顺序各得一个回复
botReplies.length = 0
pushMessage('第一条')
pushMessage('第二条')
await sleep(1200)
const echos = textsToUser().filter((x) => x.startsWith('回声'))
check('排队串行', echos.length === 2 && echos[0] === '回声：第一条' && echos[1] === '回声：第二条', JSON.stringify(echos))

// 3. /status
botReplies.length = 0
pushMessage('/status')
await sleep(300)
check('/status', textsToUser().some((x) => x.includes('状态：空闲')), JSON.stringify(textsToUser()))

// 4. 追问转发：直接调 provider.ask（模拟 agent 内部触发）
if (askProvider) {
  botReplies.length = 0
  const askPromise = askProvider.ask({
    agent: { id: created[created.length - 1].sessionId },
    questions: [{ id: 'q1', question: '要继续吗？', options: ['是', '否'] }],
  })
  await sleep(200)
  check('追问转发到 QQ', textsToUser().some((x) => x.includes('要继续吗？')), JSON.stringify(textsToUser()))
  pushMessage('是') // 下一句话作为答案
  const answer = await askPromise
  check('答案匹配选项', JSON.stringify(answer) === JSON.stringify({ answers: [{ id: 'q1', selected: ['是'] }] }), JSON.stringify(answer))
} else {
  check('追问转发到 QQ', false, 'provider 未注册')
}

// 5. /new 后新会话 id
botReplies.length = 0
const before = created.length
pushMessage('/new')
await sleep(300)
pushMessage('新会话测试')
await sleep(700)
check('/new 新建会话', created.length === before + 1 && created[created.length - 1].text === '新会话测试')

// 6. 白名单外静默
botReplies.length = 0
pushMessage('偷偷用', '999')
await sleep(400)
check('白名单外丢弃', textsToUser().length === 0 && created.filter((c) => c.text === '偷偷用').length === 0)

// 收尾
for (const d of disposers) d?.()
wss.close()
console.log(pass ? 'GATEWAY INTEGRATION PASS' : 'GATEWAY INTEGRATION FAIL')
process.exit(pass ? 0 : 1)
