// 插件导入测试：验证模块可加载、Config schema 可求值、createUserMessage 形状正确。
import * as m from './onebot-im.mjs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { pathToFileURL } from 'node:url'

console.log('name:', m.name)
console.log('inject:', JSON.stringify(m.inject))
console.log('apply:', typeof m.apply)

const defaulted = m.Config({})
console.log('defaults: wsUrl=' + defaulted.wsUrl
  + ' provider=' + defaulted.provider
  + ' model=' + defaulted.model
  + ' timeoutMs=' + defaulted.timeoutMs
  + ' ackMessage=' + defaulted.ackMessage
  + ' allowUsers=' + JSON.stringify(defaulted.allowUsers))

const withInput = m.Config({ wsUrl: 'ws://127.0.0.1:4001', allowUsers: ['123'], maxTokens: 8192 })
console.log('override: wsUrl=' + withInput.wsUrl
  + ' allowUsers=' + JSON.stringify(withInput.allowUsers)
  + ' maxTokens=' + withInput.maxTokens
  + ' model(保持默认)=' + withInput.model)

const msg = createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } })
console.log('createUserMessage: role=' + msg.role
  + ' content=' + JSON.stringify(msg.content)
  + ' source=' + JSON.stringify(msg.source)
  + ' id=' + (typeof msg.id === 'string' ? 'string' : typeof msg.id))

if (m.name !== 'onebot-im' || typeof m.apply !== 'function' || msg.role !== 'user') {
  console.log('PLUGIN IMPORT FAIL')
  process.exit(1)
}
console.log('PLUGIN IMPORT PASS')
