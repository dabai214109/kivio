// Kivio UI 驱动（Mode A）：
//   发送 = 剪贴板写入 -> 激活窗口 -> 焦点进输入框(UIA 优先，坐标兜底) -> Ctrl+V -> Enter
//   新对话 / 停止 / 切换会话 = UIA 按名称定位控件并 Invoke（尽力而为，找不到时明确报错）。
// 前置条件：Kivio 以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility
//           启动后，WebView2 内容才会暴露给 UIA；未设置时 Edit 定位会返回 0 个，自动退回坐标模式。

import { runPowerShellJson, psStringLiteral } from './powershell.js'
import { createLogger } from '../logger.js'

const log = createLogger('ui')

const NEW_CHAT_NAMES = ['新对话', '新聊天', 'New Chat', 'New chat', '新建对话']
const STOP_NAMES = ['停止', 'Stop', '中断', '取消生成']

export class KivioUiDriver {
  /**
   * @param {{process_name:string, input_coords:{x_ratio:number,y_ratio:number}, uia_max_results:number}} config
   */
  constructor(config) {
    this.config = config
  }

  /** PowerShell 公共前缀：加载程序集、user32 P/Invoke、定位 Kivio 主窗口。 */
  #preamble() {
    const proc = this.config.process_name.replace(/[^A-Za-z0-9_.-]/g, '')
    const xr = Number(this.config.input_coords.x_ratio) || 0.5
    const yr = Number(this.config.input_coords.y_ratio) || 0.93
    return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -Namespace Kig -Name Native -MemberDefinition @'
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
'@
$InputXR = ${xr}
$InputYR = ${yr}
function Get-KivioWindow {
  $p = Get-Process -Name '${proc}' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { return $null }
  $r = New-Object Kig.Native+RECT
  [Kig.Native]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
  [pscustomobject]@{ Proc = $p; Hwnd = $p.MainWindowHandle; Title = $p.MainWindowTitle; Rect = $r }
}
function Convert-RectJson($r) { @{ l = $r.Left; t = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) } }
function Click-Point($x, $y) {
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point([int]$x, [int]$y)
  Start-Sleep -Milliseconds 60
  [Kig.Native]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [Kig.Native]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
function Get-Root([IntPtr]$hwnd) { [System.Windows.Automation.AutomationElement]::FromHandle($hwnd) }
function Find-ByControlType($root, $controlType, $max) {
  if (-not $root) { return @() }
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if ($found.Count -gt $max) { return $found | Select-Object -First $max }
  return $found
}
function Invoke-Element($el) {
  try {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke(); return 'invoke'
  } catch {
    try {
      $pt = $el.GetClickablePoint()
      Click-Point $pt.X $pt.Y; return 'click'
    } catch { return $null }
  }
}
function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 5 }
`
  }

  /**
   * 探活：窗口是否存在、UIA 能否看到输入框。
   * @returns {{ok:boolean, window:object|null, uia:{editCount:number, names:string[]}, mode:'uia'|'coords'|'down'}}
   */
  async probe() {
    try {
      const result = await runPowerShellJson(`${this.#preamble()}
$w = Get-KivioWindow
if (-not $w) { Out-Json @{ ok = $false; reason = 'window-not-found' }; exit 0 }
$root = Get-Root $w.Hwnd
$edits = @(Find-ByControlType $root ([System.Windows.Automation.ControlType]::Edit) ${this.config.uia_max_results})
$names = @()
foreach ($e in $edits) { $names += [string]$e.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty) }
Out-Json @{ ok = $true; window = @{ pid = $w.Proc.Id; title = $w.Title; rect = (Convert-RectJson $w.Rect) }; editCount = $edits.Count; editNames = $names }
`)
      const editCount = Number(result?.editCount ?? 0)
      return {
        ok: Boolean(result?.ok),
        window: result?.window ?? null,
        uia: { editCount, names: result?.editNames ?? [] },
        mode: !result?.ok ? 'down' : (editCount > 0 ? 'uia' : 'coords'),
        reason: result?.reason,
      }
    } catch (err) {
      return { ok: false, window: null, uia: { editCount: 0, names: [] }, mode: 'down', reason: err.message }
    }
  }

  /**
   * 把一段文本发送进 Kivio 当前对话输入框并回车。
   * @returns {{ok:boolean, mode:'uia'|'coords', detail:string}}
   */
  async sendText(text) {
    const literal = psStringLiteral(text)
    try {
      const result = await runPowerShellJson(`${this.#preamble()}
$text = ${literal}
$w = Get-KivioWindow
if (-not $w) { Out-Json @{ ok = $false; detail = '未找到 Kivio 窗口（进程未启动？）' }; exit 0 }
Set-Clipboard -Value $text
[Kig.Native]::ShowWindow($w.Hwnd, 9) | Out-Null   # SW_RESTORE
[Kig.Native]::SetForegroundWindow($w.Hwnd) | Out-Null
Start-Sleep -Milliseconds 200
$mode = 'coords'
$root = Get-Root $w.Hwnd
$edits = @(Find-ByControlType $root ([System.Windows.Automation.ControlType]::Edit) ${this.config.uia_max_results})
if ($edits.Count -gt 0) {
  $edit = $edits[$edits.Count - 1]   # 底部输入框通常是最后一个 Edit
  $focused = $false
  try {
    $pt = $edit.GetClickablePoint()
    Click-Point $pt.X $pt.Y; $focused = $true; $mode = 'uia'
  } catch {
    try { $edit.SetFocus(); $focused = $true; $mode = 'uia' } catch { }
  }
  if (-not $focused) {
    $r = $w.Rect
    Click-Point ($r.Left + $r.Width * $InputXR) ($r.Top + $r.Height * $InputYR)
  }
} else {
  $r = $w.Rect
  Click-Point ($r.Left + $r.Width * $InputXR) ($r.Top + $r.Height * $InputYR)
}
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
Out-Json @{ ok = $true; mode = $mode; detail = "已粘贴 $($text.Length) 字符并回车" }
`, { timeout_ms: 30000 })
      return { ok: Boolean(result?.ok), mode: result?.mode ?? 'coords', detail: result?.detail ?? '' }
    } catch (err) {
      return { ok: false, mode: 'coords', detail: `PowerShell 失败：${err.message}` }
    }
  }

  /** 点击“新对话”。返回 {ok, detail}。 */
  async newConversation() {
    const names = JSON.stringify(NEW_CHAT_NAMES)
    try {
      const result = await runPowerShellJson(`${this.#preamble()}
$candidates = ${names}
$w = Get-KivioWindow
if (-not $w) { Out-Json @{ ok = $false; detail = '未找到 Kivio 窗口' }; exit 0 }
[Kig.Native]::SetForegroundWindow($w.Hwnd) | Out-Null
$root = Get-Root $w.Hwnd
$buttons = @(Find-ByControlType $root ([System.Windows.Automation.ControlType]::Button) 200)
$hit = $null
:outer foreach ($b in $buttons) {
  $n = [string]$b.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
  foreach ($c in $candidates) { if ($n -and $n.Contains($c)) { $hit = $b; break outer } }
}
if (-not $hit) { Out-Json @{ ok = $false; detail = 'UIA 未找到“新对话”按钮（无障碍未开启或控件名不同）' }; exit 0 }
$how = Invoke-Element $hit
if ($how) { Out-Json @{ ok = $true; detail = "已通过 $how 触发新对话" } } else { Out-Json @{ ok = $false; detail = '找到按钮但无法触发（Invoke 与 ClickablePoint 均失败）' } }
`, { timeout_ms: 30000 })
      return { ok: Boolean(result?.ok), detail: result?.detail ?? '' }
    } catch (err) {
      return { ok: false, detail: `PowerShell 失败：${err.message}` }
    }
  }

  /** 尽力停止当前生成：找“停止”按钮，否则发 Esc。返回 {ok, detail}。 */
  async stopRun() {
    const names = JSON.stringify(STOP_NAMES)
    try {
      const result = await runPowerShellJson(`${this.#preamble()}
$candidates = ${names}
$w = Get-KivioWindow
if (-not $w) { Out-Json @{ ok = $false; detail = '未找到 Kivio 窗口' }; exit 0 }
[Kig.Native]::SetForegroundWindow($w.Hwnd) | Out-Null
$root = Get-Root $w.Hwnd
$buttons = @(Find-ByControlType $root ([System.Windows.Automation.ControlType]::Button) 200)
$hit = $null
:outer foreach ($b in $buttons) {
  $n = [string]$b.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
  foreach ($c in $candidates) { if ($n -and $n.Contains($c)) { $hit = $b; break outer } }
}
if ($hit) {
  $how = Invoke-Element $hit
  if ($how) { Out-Json @{ ok = $true; detail = "已通过 $how 点击停止按钮" }; exit 0 }
}
[System.Windows.Forms.SendKeys]::SendWait('{ESC}')
Out-Json @{ ok = $true; detail = '未找到停止按钮，已发送 Esc 兜底' }
`, { timeout_ms: 30000 })
      return { ok: Boolean(result?.ok), detail: result?.detail ?? '' }
    } catch (err) {
      return { ok: false, detail: `PowerShell 失败：${err.message}` }
    }
  }

  /**
   * 在会话侧栏里按标题（前缀）点击某个历史会话。尽力而为。
   * @param {string} title 目标会话标题
   */
  async switchConversation(title) {
    const literal = psStringLiteral(title.slice(0, 16))
    try {
      const result = await runPowerShellJson(`${this.#preamble()}
$title = ${literal}
$w = Get-KivioWindow
if (-not $w) { Out-Json @{ ok = $false; detail = '未找到 Kivio 窗口' }; exit 0 }
[Kig.Native]::SetForegroundWindow($w.Hwnd) | Out-Null
$root = Get-Root $w.Hwnd
$items = @(Find-ByControlType $root ([System.Windows.Automation.ControlType]::ListItem) 300)
$hit = $null
foreach ($i in $items) {
  $n = [string]$i.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
  if ($n -and ($n.Contains($title) -or $title.Contains($n))) { $hit = $i; break }
}
if (-not $hit) {
  $texts = @(Find-ByControlType $root ([System.Windows.Automation.ControlType]::Text) 300)
  foreach ($i in $texts) {
    $n = [string]$i.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
    if ($n -and $n.Length -gt 4 -and ($n.Contains($title) -or $title.Contains($n))) { $hit = $i; break }
  }
}
if (-not $hit) { Out-Json @{ ok = $false; detail = "侧栏未找到标题含“$title”的会话" }; exit 0 }
$how = Invoke-Element $hit
if ($how) { Out-Json @{ ok = $true; detail = "已通过 $how 点击会话“$title”" } } else { Out-Json @{ ok = $false; detail = '找到会话项但无法点击' } }
`, { timeout_ms: 30000 })
      return { ok: Boolean(result?.ok), detail: result?.detail ?? '' }
    } catch (err) {
      return { ok: false, detail: `PowerShell 失败：${err.message}` }
    }
  }
}
