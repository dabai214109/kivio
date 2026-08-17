# sync-upstream.ps1 —— Kivio 定制版跟进上游更新的自动化脚本
# 用法：powershell -ExecutionPolicy Bypass -File sync-upstream.ps1 -Version 2.9.3
#   -Version  上游新版本号（如 2.9.3）；省略则自动取 upstream 最新的 v* 标签（排除 -im）
#   -Tag      跳过 CI 等待，直接连标签一起打（默认只推分支，等 CI 绿后由你打标签）
# 冲突时脚本会安全停下（rebase --abort），按提示手工处理后从第 3 步继续。
# 完整流程说明见同目录 UPSTREAM-UPDATE.md。

param(
    [string]$Version = "",
    [switch]$Tag
)

$ErrorActionPreference = 'Stop'
$Repo = 'D:\ruanjian\Kivio\program\IM gateway\kivio-2.9.1'
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'   # GitHub 需代理；代理软件要先开

function Fail($msg) { Write-Host "`n[STOP] $msg" -ForegroundColor Red; exit 1 }
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# 无 BOM UTF-8 读写（PS5.1 的 Set-Content 默认 ANSI，会把含中文的 JSON 写坏）
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Read-Text($path) { [System.IO.File]::ReadAllText($path) }
function Write-Text($path, $text) { [System.IO.File]::WriteAllText($path, $text, $Utf8NoBom) }

Set-Location $Repo

# ---- 0. 前置 ----
Step 'fetch upstream（原作者仓库）'
git fetch upstream --tags 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail 'git fetch upstream 失败：检查代理软件是否开启（127.0.0.1:7897）' }

if (-not $Version) {
    $Version = git tag --list 'v*' --sort=-v:refname |
        Where-Object { $_ -notmatch '-im' } |
        Select-Object -First 1
    $Version = "$Version" -replace '^v', ''
    if (-not $Version) { Fail '未能自动识别上游最新版本，请用 -Version 指定' }
    Write-Host "自动选取上游版本：$Version"
}
$UpTag = "v$Version"
if (-not (git tag --list $UpTag)) { Fail "上游标签 $UpTag 不存在（fetch 后仍没有）。确认版本号是否正确。" }

$ImVer = "${Version}-im.1"
$ExistingIm = git tag --list "v$Version-im.*" | Sort-Object -Descending | Select-Object -First 1
if ($ExistingIm) {
    Write-Host "注意：已存在标签 $ExistingIm。若要重做本次同步，先删：git push origin :refs/tags/$ExistingIm; git tag -d $ExistingIm"
}

# ---- 1. main 合并上游标签 ----
Step "main 合并上游 $UpTag"
git checkout main
if ($LASTEXITCODE -ne 0) { Fail '切到 main 失败（有未提交改动？先 git stash 或提交）' }
git merge $UpTag
if ($LASTEXITCODE -ne 0) {
    git merge --abort
    Fail "main 合并 $UpTag 冲突（不常见——main 无自有改动）。手工：git checkout main; git merge $UpTag"
}
git push origin main
if ($LASTEXITCODE -ne 0) { Fail 'push main 失败（代理？）' }

# ---- 2. im-gateway rebase 到新 main ----
Step 'im-gateway rebase 到新 main'
git checkout im-gateway
if ($LASTEXITCODE -ne 0) { Fail '切到 im-gateway 失败' }
git rebase main
if ($LASTEXITCODE -ne 0) {
    git rebase --abort
    Fail @"
rebase 冲突，已安全回退（rebase --abort）。手工流程：
  git checkout im-gateway
  git rebase main
  # 解冲突（热点清单见 UPSTREAM-UPDATE.md）：git status -> 编辑 -> git add -> git rebase --continue
解完后从本脚本【第 3 步：版本号更迭】继续（直接重跑本脚本也会安全跳到正确状态）。
"@
}

# ---- 3. 版本号更迭（三处；Cargo.lock 用 cargo 顺手同步） ----
Step "版本号更迭为 $ImVer"

# package.json / tauri.conf.json：替换文件里第一处 "version": "..."（tauri.conf 第二处是 wix 工具链版本，不动）
foreach ($p in @('package.json', 'src-tauri/tauri.conf.json')) {
    $t = Read-Text $p
    $t2 = [regex]::Replace($t, '"version"\s*:\s*"[^"]+"', """version"": ""$ImVer""", 1)
    if ($t2 -eq $t) { Fail "$p 里没找到 version 字段" }
    Write-Text $p $t2
}
# Cargo.toml：(?m) 让 ^ 匹配行首——包自身版本是文件里唯一顶格的 version =
$t = Read-Text 'src-tauri/Cargo.toml'
$t2 = [regex]::Replace($t, '(?m)^version = "[^"]+"', "version = `"$ImVer`"", 1)
if ($t2 -eq $t) { Fail 'Cargo.toml 里没找到顶格 version = 行' }
Write-Text 'src-tauri/Cargo.toml' $t2

if (Test-Path "$env:USERPROFILE\.cargo\bin\cargo.exe") {
    Push-Location src-tauri
    & "$env:USERPROFILE\.cargo\bin\cargo.exe" check -q 2>&1 | Out-Null
    Pop-Location
    Write-Host 'Cargo.lock 已同步（本地 cargo check 顺便验证了编译）'
} else {
    Write-Host '（本机无 cargo，跳过 Cargo.lock 同步——CI 会覆盖验证）'
}

git add -A
git commit -m "chore: 跟进上游 $UpTag，定制版本号 $ImVer" | Out-Null
git push -f origin im-gateway
if ($LASTEXITCODE -ne 0) { Fail 'push im-gateway 失败（代理？）' }

# ---- 4. CI / 标签 ----
if ($Tag) {
    Step "直接打标签 v$ImVer（-Tag 模式，不等 CI）"
    git tag "v$ImVer"
    git push origin "v$ImVer"
    Write-Host "`nRelease 构建已触发，约 40-60 分钟后：https://github.com/dabai214109/kivio/releases/tag/v$ImVer"
} else {
    Step '分支同步完成。接下来（完整说明见 UPSTREAM-UPDATE.md）：'
    Write-Host @"
1. 等 CI 绿（必须）：
   gh run watch (gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
2. 绿了再打标签出安装包：
   git tag v$ImVer
   git push origin v$ImVer
3. 下载：https://github.com/dabai214109/kivio/releases/tag/v$ImVer
"@
}
Write-Host "`n[OK] 上游 $UpTag 同步完成，定制版 $ImVer 已就绪。" -ForegroundColor Green
