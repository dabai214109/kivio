// 冒烟测试：配置加载 + 对话存储读取（只读，不碰 UI、不连 OneBot）。
import { loadConfig } from './src/config.js'
import { ConvStore } from './src/driver/conv-store.js'

const cfg = loadConfig()
console.log('config ok:', cfg._path, '| convdir:', cfg.kivio.conversations_dir)

const store = new ConvStore(cfg.kivio.conversations_dir)
const idx = store.readIndex()
const newest = [...idx.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))[0]
console.log('index ok:', idx.size, 'convs | newest:', newest.id, 'rev', newest.revision)

const conv = store.readConv(newest.id)
console.log('conv ok:', conv.messages.length, 'messages | runtime', conv.runtime)

const snap = store.assistantTextSince(newest.id, 0)
console.log('assistantTextSince(0):', snap.count, 'msgs,', snap.text.length, 'chars')

const baseline = store.baseline()
console.log('baseline ok:', baseline.size)
console.log('SMOKE PASS')
