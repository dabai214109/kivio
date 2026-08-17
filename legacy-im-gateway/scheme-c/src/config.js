// 配置加载：config.yaml（不存在时用内置默认值），环境变量可覆盖关键项。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { setLogLevel } from './logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const DEFAULT_CONFIG = {
  onebot: {
    ws_url: 'ws://127.0.0.1:3001',
    access_token: '',
    reconnect_interval_sec: 5,
    allow_private: [],
    allow_group: [],
    on_not_allowed: 'drop',
  },
  kivio: {
    conversations_dir: '',
    process_name: 'kivio',
    poll_interval_ms: 800,
    identify_timeout_sec: 20,
    settle_polls: 3,
    input_coords: { x_ratio: 0.5, y_ratio: 0.93 },
    uia_max_results: 50,
  },
  session: {
    timeout_min: 10,
    max_queue: 10,
    split_length: 4000,
    split_interval_ms: 400,
    ack_message: true,
    forget_after_min: 720,
  },
  log: {
    level: 'info',
  },
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function deepMerge(base, over) {
  if (!isPlainObject(over)) return base
  const out = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (isPlainObject(v) && isPlainObject(base?.[k])) out[k] = deepMerge(base[k], v)
    else if (v !== undefined) out[k] = v
  }
  return out
}

export function defaultConversationsDir() {
  const appdata = process.env.APPDATA
  if (!appdata) return ''
  return path.join(appdata, 'com.zmair.kivio', 'conversations')
}

export function loadConfig(explicitPath) {
  const candidates = explicitPath
    ? [explicitPath]
    : [
        path.join(process.cwd(), 'config.yaml'),
        path.join(__dirname, '..', 'config.yaml'),
      ]

  let raw = null
  let used = '(defaults)'
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      raw = YAML.parse(fs.readFileSync(file, 'utf8')) || {}
      used = file
      break
    }
  }

  let cfg = deepMerge(DEFAULT_CONFIG, raw)

  // 环境变量覆盖（便于 NSSM/计划任务部署时少一份配置文件）。
  if (process.env.KIG_ONEBOT_WS) cfg.onebot.ws_url = process.env.KIG_ONEBOT_WS
  if (process.env.KIG_ONEBOT_TOKEN) cfg.onebot.access_token = process.env.KIG_ONEBOT_TOKEN
  if (process.env.KIG_CONVERSATIONS_DIR) cfg.kivio.conversations_dir = process.env.KIG_CONVERSATIONS_DIR

  if (!cfg.kivio.conversations_dir) cfg.kivio.conversations_dir = defaultConversationsDir()
  // 白名单统一转成字符串 Set 供快速判断。
  cfg.onebot._allow_private = new Set(cfg.onebot.allow_private.map(String))
  cfg.onebot._allow_group = new Set(cfg.onebot.allow_group.map(String))

  setLogLevel(cfg.log.level)
  cfg._path = used
  return cfg
}
