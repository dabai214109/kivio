// OneBot 客户端离线测试：起一个本地 OneBot11 模拟 WS 服务端，验证收发闭环。
import { WebSocketServer } from 'ws'
import { OneBotClient } from './src/adapters/onebot.js'

const wss = new WebSocketServer({ port: 3999 })
const received = []

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    const packet = JSON.parse(raw.toString('utf8'))
    if (packet.action === 'get_login_info') {
      ws.send(JSON.stringify({ status: { retcode: 0 }, echo: packet.echo, data: { user_id: 10001, nickname: '测试机器人' } }))
    } else if (packet.action === 'send_private_msg' || packet.action === 'send_group_msg') {
      received.push({ action: packet.action, params: packet.params })
      ws.send(JSON.stringify({ status: { retcode: 0 }, echo: packet.echo, data: { message_id: received.length } }))
    }
  })
  // 连上后推一条私聊消息（段数组格式）
  setTimeout(() => {
    ws.send(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      user_id: 123456,
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '测试用户' },
      message: [{ type: 'text', data: { text: '你好 Kivio' } }],
    }))
    // 再推一条字符串格式 + CQ 码
    setTimeout(() => {
      ws.send(JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        group_id: 777,
        user_id: 123456,
        time: Math.floor(Date.now() / 1000),
        sender: { nickname: '测试用户' },
        message: '[CQ:at,qq=10001] 帮我看下 [CQ:image,file=abc.jpg] 这个报错',
      }))
    }, 300)
  }, 200)
})

const client = new OneBotClient({ ws_url: 'ws://127.0.0.1:3999', access_token: '', reconnect_interval_sec: 1 })
const inbound = []
client.on('message', (m) => inbound.push(m))

client.start()
await new Promise((r) => setTimeout(r, 900))

console.log('收到消息数:', inbound.length)
console.log('私聊解析:', JSON.stringify(inbound[0]))
console.log('群聊解析:', JSON.stringify(inbound[1]))

await client.sendPrivate('123456', '回复：好的')
await client.sendGroup('777', '回复：收到')
console.log('服务端收到的回复:', JSON.stringify(received))

client.stop()
wss.close()

const ok = inbound.length === 2
  && inbound[0].text === '你好 Kivio' && inbound[0].user_id === '123456'
  && inbound[1].text.includes('帮我看下') && inbound[1].text.includes('这个报错') && inbound[1].group_id === '777'
  && received.length === 2 && received[0].params.user_id === 123456
console.log(ok ? 'ONEBOT TEST PASS' : 'ONEBOT TEST FAIL')
process.exit(ok ? 0 : 1)
