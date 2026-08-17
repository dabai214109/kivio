// 极简分级日志：时间戳 + 级别 + 模块名，直接写 stdout/stderr。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }

let threshold = LEVELS.info

export function setLogLevel(level) {
  const key = String(level || 'info').toLowerCase()
  threshold = LEVELS[key] ?? LEVELS.info
}

function ts() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

function emit(stream, tag, module, args) {
  stream.write(`${ts()} [${tag}]${module ? ` [${module}]` : ''} ${args.map(fmt).join(' ')}\n`)
}

function fmt(v) {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function createLogger(module = '') {
  return {
    debug: (...a) => { if (LEVELS.debug >= threshold) emit(process.stdout, 'DEBUG', module, a) },
    info: (...a) => { if (LEVELS.info >= threshold) emit(process.stdout, 'INFO ', module, a) },
    warn: (...a) => { if (LEVELS.warn >= threshold) emit(process.stderr, 'WARN ', module, a) },
    error: (...a) => { if (LEVELS.error >= threshold) emit(process.stderr, 'ERROR', module, a) },
  }
}
