# 把本目录部署为 dsh profile "kivio-im" 并安装依赖。
# 用法：powershell -ExecutionPolicy Bypass -File deploy.ps1
# 部署后启动：dsh --profile kivio-im   （常驻；Ctrl+C 退出）

$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:USERPROFILE '.dsh\profiles\kivio-im'

Write-Host "源目录：$src"
Write-Host "目标：  $dest"

New-Item -ItemType Directory -Force -Path $dest | Out-Null

foreach ($f in @('package.json', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'onebot-im.mjs')) {
  Copy-Item -Force (Join-Path $src $f) (Join-Path $dest $f)
  Write-Host "已复制 $f"
}

# 保留运行期产物（onebot-sessions.json / workspaces），不做删除。

Push-Location $dest
try {
  Write-Host '安装依赖（pnpm install）…'
  pnpm install
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install 失败' }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host '部署完成。后续步骤：'
Write-Host '  1. 编辑 cordis.patch.yml：allowUsers 加入你的 QQ 号；确认 wsUrl 指向 NapCat 的 OneBot11 正向 WS。'
Write-Host '  2. 设置环境变量 KIVIO_DSH_P_MSUETDMV_API_KEY（自建 provider 的 API Key；若改用 deepseek-official 可跳过）。'
Write-Host '  3. 启动：dsh --profile kivio-im'
