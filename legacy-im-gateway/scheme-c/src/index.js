// 入口：加载配置 -> 连接 OneBot -> 启动网关；单例锁防多开。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './config.js'
import { OneBotClient } from './adapters/onebot.js'
import { Gateway } from './gateway.js'
import { createLogger } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const log = createLogger('main')

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true
  }
  return out
}

function acquireSingletonLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true })
  const lockFile = path.join(dataDir, 'gateway.lock')
  if (fs.existsSync(lockFile)) {
    const pid = Number(fs.readFileSync(lockFile, 'utf8').trim())
    if (Number.isInteger(pid) && pid > 0) {
      try {
        // Windows 下 kill(0) 不可靠，用 process.kill(pid, 0) 探测：能通说明进程仍在。
        process.kill(pid, 0)
        log.error(`已有网关实例在运行（pid=${pid}，锁文件 ${lockFile}）。如确认没有，请删除锁文件后重试。`)
        process.exit(1)
      } catch {
        log.info('发现残留锁文件（进程已不存在），覆盖。')
      }
    }
  }
  fs.writeFileSync(lockFile, String(process.pid), 'utf8')
  const release = () => { try { fs.unlinkSync(lockFile) } catch { /* ignore */ } }
  process.on('exit', release)
  process.on('SIGINT', () => process.exit(0))
  process.on('SIGTERM', () => process.exit(0))
}

const HELP = `
kivio-im-gateway —— QQ(NapCat/OneBot11) <-> Kivio Desktop 桥（方案 C）

用法：
  node src/index.js [--config <path/to/config.yaml>]
  npm run probe   # 环境探活（Kivio 窗口 / UIA / 对话目录 / OneBot 连通）
  npm start

环境变量：
  KIG_ONEBOT_WS            覆盖 onebot.ws_url
  KIG_ONEBOT_TOKEN         覆盖 onebot.access_token
  KIG_CONVERSATIONS_DIR    覆盖 kivio.conversations_dir
`.trim()

const args = parseArgs(process.argv)
if (args.help) {
  console.log(HELP)
  process.exit(0)
}

const cfg = loadConfig(args.config)
log.info(`配置来源：${cfg._path}`)
if (cfg.onebot._allow_private.size === 0 && cfg.onebot._allow_group.size === 0) {
  log.warn('白名单为空：所有消息都会被忽略。请在 config.yaml 的 onebot.allow_private/allow_group 里加 QQ 号。')
}

acquireSingletonLock(path.join(__dirname, '..', 'data'))

const onebot = new OneBotClient(cfg.onebot)
const gateway = new Gateway(cfg, onebot)
gateway.start()
onebot.start()

const shutdown = async (signal) => {
  log.info(`收到 ${signal}，退出中…`)
  await gateway.stop()
  onebot.stop()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => log.error('unhandledRejection:', err))
