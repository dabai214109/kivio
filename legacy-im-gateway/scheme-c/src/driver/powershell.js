// PowerShell 子进程封装。
// 所有脚本一律走 -EncodedCommand（base64(UTF-16LE)），彻底规避命令行转义与中文编码问题；
// 脚本内部统一把 stdout 设为 UTF-8，Node 侧按 UTF-8 解析。

import { spawn } from 'node:child_process'

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']

/**
 * 执行一段 PowerShell 脚本，成功时返回其 stdout（UTF-8 字符串，已 trim）。
 * @param {string} script PowerShell 脚本文本
 * @param {{timeout_ms?: number}} [options]
 * @returns {Promise<string>}
 */
export function runPowerShell(script, options = {}) {
  const timeoutMs = options.timeout_ms ?? 20000
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [...PS_ARGS, '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`PowerShell 执行超时（${timeoutMs}ms）`))
    }, timeoutMs)

    child.stdout.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) resolve(stdout.trim())
      else reject(new Error(`PowerShell 退出码 ${code}: ${stderr.trim().slice(0, 500) || '(无 stderr)'}`))
    })
  })
}

/** 执行脚本并把 stdout 解析为 JSON（脚本需自行输出 JSON）。 */
export async function runPowerShellJson(script, options = {}) {
  const out = await runPowerShell(
    `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();\n${script}`,
    options,
  )
  if (!out) return null
  try {
    return JSON.parse(out)
  } catch (err) {
    throw new Error(`PowerShell 输出不是合法 JSON：${out.slice(0, 300)}`)
  }
}

/** PS 片段：把任意文本安全地嵌进 PowerShell（Base64 传输，脚本内解码）。 */
export function psStringLiteral(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64')
  return `[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}'))`
}
