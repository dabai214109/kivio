// 落地前置验证（方案文档“落地前置验证清单”的自动化版）：
//   1. Kivio 窗口探活 + UIA 输入框可见性（WebView2 无障碍是否开启）
//   2. 对话目录/index.json 可读性
//   3. --doctor 时额外测试 OneBot WS 连通
// 只做只读探测，不发送任何消息。

import { loadConfig } from './config.js'
import { KivioUiDriver } from './driver/ui-automation.js'
import { ConvStore } from './driver/conv-store.js'
import { OneBotClient } from './adapters/onebot.js'
import { createLogger } from './logger.js'

const log = createLogger('probe')

const args = new Set(process.argv.slice(2))
const doctor = args.has('--doctor')
const configArg = (() => {
  const i = process.argv.indexOf('--config')
  return i > 0 ? process.argv[i + 1] : undefined
})()

const cfg = loadConfig(configArg)
let failures = 0

function report(name, ok, detail) {
  const mark = ok ? '✅' : '❌'
  if (!ok) failures += 1
  console.log(`${mark} ${name}${detail ? `：${detail}` : ''}`)
}

// 1) Kivio 窗口 / UIA
const driver = new KivioUiDriver(cfg.kivio)
const probe = await driver.probe()
if (probe.ok) {
  const w = probe.window
  report('Kivio 窗口', true, `pid=${w.pid} title="${w.title}" rect=${w.rect.w}x${w.rect.h}`)
  report('UIA 输入框定位', probe.mode === 'uia',
    probe.mode === 'uia'
      ? `找到 ${probe.uia.editCount} 个 Edit（${probe.uia.names.slice(0, 3).join(' / ') || '无名称'}）`
      : '未找到 Edit —— 将退回坐标兜底；建议设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility 后重启 Kivio')
  if (probe.mode === 'coords') {
    console.log('   （坐标模式可用，但建议开启无障碍以提升稳定性）')
  }
} else {
  report('Kivio 窗口', false, probe.reason ?? '未找到（Kivio 是否已启动？进程名是否为 kivio？）')
}

// 2) 对话目录
try {
  const store = new ConvStore(cfg.kivio.conversations_dir)
  const idx = store.readIndex()
  const newest = [...idx.values()].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0]
  report('对话目录', true, `${cfg.kivio.conversations_dir}（${idx.size} 个会话）`)
  if (newest) {
    const conv = store.readConv(newest.id)
    report('对话文件读取', Boolean(conv),
      conv ? `${newest.id} rev=${conv.revision} messages=${conv.messages.length} runtime=${conv.runtime}` : '读取失败')
  }
} catch (err) {
  report('对话目录', false, `${cfg.kivio.conversations_dir} —— ${err.message}`)
}

// 3) OneBot（--doctor 时）
if (doctor) {
  const onebot = new OneBotClient(cfg.onebot)
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, detail: '连接超时' }), 8000)
    onebot.on('connected', async () => {
      try {
        const info = await onebot.call('get_login_info', {})
        clearTimeout(timer)
        resolve({ ok: true, detail: `${info?.nickname} (${info?.user_id})` })
      } catch (err) {
        clearTimeout(timer)
        resolve({ ok: false, detail: `已连接但 API 调用失败：${err.message}` })
      }
    })
    onebot.start()
  })
  onebot.stop()
  report('OneBot 连通', result.ok, result.detail)
} else {
  console.log('ℹ️  跳过 OneBot 连通性测试（npm run doctor 执行完整检查）')
}

console.log('')
if (failures === 0) {
  console.log('全部通过。')
} else {
  console.log(`${failures} 项未通过 —— 处理后再启动网关（npm start）。`)
  process.exitCode = 1
}
