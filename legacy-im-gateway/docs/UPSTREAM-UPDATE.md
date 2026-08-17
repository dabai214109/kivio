# Kivio 定制版（IM 网关 fork）— 上游更新作业指引

> 本文件写给**任何 AI 智能体或人类**，照做即可完成「原作者更新 → 定制版跟进 → 云端出新安装包」全流程。
> 无需了解历史上下文；所有事实都在本文里。

## 背景事实（先读）

| 项 | 值 |
|---|---|
| 本地仓库 | `D:\ruanjian\Kivio\program\IM gateway\kivio-2.9.1` |
| 你的仓库（origin） | `https://github.com/dabai214109/kivio` |
| 原作者仓库（upstream） | `https://github.com/ZMGID/kivio`（远端已配置） |
| 定制分支 | `im-gateway`（基于上游 v2.9.1 + IM 网关功能） |
| main 分支 | 跟随上游发版点（无自有改动） |
| 自动化 | push 到 im-gateway → 「IM Gateway CI」自动跑（cargo check + 单测 + tsc）；推 `v*` 标签 → 「Release」自动出 **仅 Windows** 的 NSIS 安装包 |
| 当前定制版本号 | 2.9.2-im.2（格式：`<上游版本>-im.<序号>`） |

**环境注意**：
- git/gh 访问 GitHub 需走代理：命令前加 `export HTTPS_PROXY=http://127.0.0.1:7897`（bash）或 `$env:HTTPS_PROXY="http://127.0.0.1:7897"`（PowerShell）。代理软件必须开着。
- gh 在 `~\.local\bin\gh.exe`；已 `gh repo set-default dabai214109/kivio`（多远端下不会认错仓库）。
- 本机 Rust 工具链在 `~\.cargo\bin`（本地编译可选，云端 CI 是权威验证）。

## 更新流程

上游发新版（如 `v2.9.3`）后：

### 第 1 步：同步 main

```bash
cd "D:/ruanjian/Kivio/program/IM gateway/kivio-2.9.1"
git fetch upstream --tags
git checkout main
git merge v2.9.3        # 用上游的版本标签，不用 upstream/main
git push origin main
```

### 第 2 步：定制分支 rebase 到新 main

```bash
git checkout im-gateway
git rebase main
```

**若冲突**：大概率在这些热点（都是“多一行”性质，好解）：
- `src-tauri/src/settings.rs` — Settings 结构体 / sanitize_settings（我们加了 `im_gateway` 分区）
- `src-tauri/src/lib.rs` — 模块声明、generate_handler 列表、setup spawn、退出清理（各加了 im_gateway 相关行）
- `src-tauri/src/chat/commands.rs` — `mod reply_runtime` 改成了 `pub(crate) mod`
- `src/api/tauri.ts`、`src/settings/SettingsShell.tsx`、`src/settings/NavIcons.tsx` — 前端设置页接线
- `src-tauri/build.rs`、`src-tauri/tests/` — Windows 测试 manifest 修复（上游若也修了同类问题，优先保留带 manifest 的版本）
- `src-tauri/Cargo.toml` / `Cargo.lock` — 我们加了 `tokio-tungstenite` 依赖；版本号行两边都改时要取新的 `-im` 版本
- `src-tauri/src/im_gateway/`、`src/settings/tabs/ImGatewayTab.tsx` 是纯新增文件，**不会冲突**；上游若重构了 chat 命令层（`chat_send_message` 签名、`create_chat_conversation_internal`），需要按新签名改 im_gateway 里的调用点（见模块头注释列出的对标函数）

解冲突：`git status` 看文件 → 手工合并 → `git add` → `git rebase --continue`。搞砸了就 `git rebase --abort` 回到 rebase 前状态。

### 第 3 步：更迭版本号（三处同步）

`src-tauri/tauri.conf.json`、`package.json` 的 `"version"`，和 `src-tauri/Cargo.toml` 的 `version =`，改成 `<上游新版本>-im.1`（如 `2.9.3-im.1`）。改完在 src-tauri 里跑任意 cargo 命令（如 `cargo check -q`）同步 Cargo.lock，或手工改 lock 里 kivio 的版本行。

### 第 4 步：推送，等 CI 绿

```bash
git push -f origin im-gateway     # rebase 过，强推自己的分支是安全的
export HTTPS_PROXY=http://127.0.0.1:7897
gh run watch $(gh run list --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
```

CI 必须全绿（cargo check + `--test im_gateway` 7 项 + tsc）。红了就修到绿，不允许带病打标签。

### 第 5 步：打标签出安装包

```bash
git tag v2.9.3-im.1
git push origin v2.9.3-im.1
# Release 工作流自动触发（仅 Windows NSIS），约 40-60 分钟
gh run list --workflow=release.yml --limit 1
```

完成后安装包在：`https://github.com/dabai214109/kivio/releases/tag/v2.9.3-im.1`
（文件名形如 `Kivio.Desktop_2.9.3-im.1_x64-setup.exe`）

## 快捷方式

第 1-4 步的机械部分可以一条命令代跑（冲突会自动停下并提示）：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\ruanjian\Kivio\program\IM gateway\sync-upstream.ps1" -Version 2.9.3
```

## 验收标准（做完检查）

1. im-gateway 上最新提交包含：上游新版全部内容 + 4~6 个 im-gateway 自有提交 + 1 个版本号提交
2. IM Gateway CI 全绿
3. Release 里能下载到新版 setup.exe
4. （人工）安装后：Kivio 设置里有「IM 网关」页，开关/白名单/地址功能正常
