# kivio-dsh-onebot —— 方案 D：dsh 官方插件路线（QQ ↔ dsh agent，不经 Kivio 对话框）

> QQ（NapCat/OneBot11）消息 → dsh 插件 → 官方 `ctx.agents` 会话（Agent/LLM/工具链全套）→ 回复回发 QQ。
> 对话只发生在 QQ 里；Kivio 桌面端**不参与执行**（可作为可选展示副本）。

```
手机QQ ↔ NapCat/OneBot11(WS) ↔ onebot-im 插件（cordis，随 dsh --profile kivio-im 常驻）
                                    ├─ OneBot 适配：收消息 / 分段回发
                                    ├─ ctx.agents.create/resume + agentPresets（四档模式）
                                    │    每用户一个 session（cwd = workspaces/onebot-<uuid>/）
                                    ├─ agent.followup(prompt) + session/event 收集 assistant 文本
                                    ├─ userQuestions 追问转发 QQ（下一句话作为回答）
                                    └─ 空闲卸载 agent（会话落盘 .dsh/sessions/，可 resume）
```

## 为什么这是“最正统”的造法

- 用官方 `dsh-sdk-jsonrpc-server` 同款的内部 API（`ctx.agents` / `agent.followup` / `agent.cancel` / `session/event`），写法逐段对标官方范例 `.dsh/profiles/kivio/kivio-dsh-bridge.mjs`。
- 会话持久化走 `dsh-session-persistence-jsonl`（`.dsh/sessions/`），重启后按 sessionId resume。
- 无第三方机器人框架、无额外进程：一个 dsh profile 常驻即全部。

## 目录

| 文件 | 作用 |
|---|---|
| `onebot-im.mjs` | cordis 插件本体（OneBot WS 客户端 + agent 会话编排 + 追问转发 + 空闲卸载） |
| `cordis.patch.yml` | profile 插件树：插入 onebot-im、挂 agent-presets、挂与 Kivio 相同的自建 provider |
| `package.json` / `pnpm-workspace.yaml` | dsh profile 工作区（bundles: dsh-base + 插件依赖） |
| `deploy.ps1` | 一键部署到 `~/.dsh/profiles/kivio-im/` 并 `pnpm install` |
| `test-import.mjs` | 导入测试：模块加载、Config 默认值/覆盖、`createUserMessage` 形状 |
| `test-gateway.mjs` | 集成测试：mock cordis ctx + mock agent + 模拟 OneBot 服务端，跑通主链路 |

## 测试（无需真实 dsh/NapCat）

```powershell
npm install        # 或 pnpm install，装 ws/schemastery/dsh-llm 三个依赖
node test-import.mjs
node test-gateway.mjs
```

集成测试覆盖：ack 回执、回复送达、agent 创建参数、排队串行、`/status`、追问转发与选项匹配、`/new`、白名单外丢弃。

## 部署

### 1. NapCat（QQ 侧）

1. 安装 NapCat 并登录 QQ 小号/主号。
2. 网络配置里开启 **OneBot11 正向 WebSocket**，端口如 `3001`；如启用 accessToken 记下。

### 2. 部署 profile

```powershell
cd "D:\ruanjian\Kivio\program\IM gateway\kivio-dsh-onebot"
powershell -ExecutionPolicy Bypass -File deploy.ps1
```

或手动：把 `package.json`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`onebot-im.mjs` 复制到 `%USERPROFILE%\.dsh\profiles\kivio-im\`，在其中执行 `pnpm install`。

### 3. 配置（都在 `%USERPROFILE%\.dsh\profiles\kivio-im\cordis.patch.yml`）

必改：

- `allowUsers`: 加你的 QQ 号（白名单，空 = 全部忽略）。
- `wsUrl`: 对准 NapCat 的正向 WS 地址。

按需：

- `provider`/`model`: 默认 `p-msuetdmv` + `deepseek-v4-flash-free`（与 Kivio 相同的自建 provider；需要设置环境变量 `KIVIO_DSH_P_MSUETDMV_API_KEY`）。想用官方渠道就改成 `deepseek-official`，并删掉 patch 里的 llm-pi-ai 块。
- `agentPreset`: `standard`（默认）/ `code` / `minimal` / `cordis`。
- `timeoutMs`: 单轮超时（默认 10 分钟）。
- `idleDisposeMs`: 空闲多久卸载 agent（默认 30 分钟；会话在盘，下一条消息自动 resume）。

### 4. 启动

```powershell
# 需要 API Key 时（自建 provider）：
$env:KIVIO_DSH_P_MSUETDMV_API_KEY = "..."   # 建议写入用户环境变量
dsh --profile kivio-im
```

看到 `[onebot-im] 已连接 OneBot 服务端` 与机器人账号日志即成功。Ctrl+C 退出（dsh 会优雅落盘会话）。

### 5. 验证

手机 QQ 私聊机器人：`/help` → 随便问一句 → 等待回复（首条会新建会话，日志可见 `新建会话 onebot-<uuid>`）。

## 指令

| 指令 | 作用 |
|---|---|
| `/new` | 新建会话（旧的保留在 `.dsh/sessions`） |
| `/stop` | 取消当前轮（`agent.cancel({kind:'user'})`） |
| `/status` | 状态：执行中/排队、sessionId、agent status |
| `/help` | 帮助 |

## 行为细节

- **排队**：同一用户同一时间只跑一轮，后续消息排队（上限 10），跨用户并行。
- **回复分段**：超过 `splitLength`（默认 4000 字）自动切块并带 `（i/N）` 序号。
- **追问往返**：agent 触发 `ask_user_question` 时，问题会转发到 QQ；你的**下一条消息**作为回答（匹配选项文本则视为选中，否则作为自定义输入）。超时未答则返回空答案。
- **空闲卸载**：agent 句柄空闲 30 分钟自动 dispose（防内存增长），映射 `qq号 → sessionId` 持久化在插件目录 `onebot-sessions.json`，下次消息自动 resume——上下文不丢。
- **工作目录**：每个会话独立 `workspaces/onebot-<uuid>/`，与 Kivio 的 chat-workspaces 同思路；agent 产生的文件都在里面。

## 依赖的已验证事实

- `ctx.agents.create/resume` + `agentPresets.mount` 组装方式：来自官方 `kivio-dsh-bridge.mjs`（正在生产使用）。
- `agent.followup(createUserMessage({content, source:{kind:'user'}}))`：来自官方 `dsh-sdk-jsonrpc-server` 的 `prompt()` 实现。
- 回复收集：`ctx.on('session/event')` 的 `assistant/message`（组装后的整段文本）与 `turn/end`（回合结束原因）；`agent.whenIdle()` 做兜底。
- dsh 会话按 **cwd 目录**隔离持久化（`.dsh/sessions/--<sanitized-cwd>--/`），故每会话独立 cwd。

## 已知边界

- 消息不进 Kivio 对话框——这是方案 D 的定义（要界面可见请用方案 C `kivio-im-gateway/`）。
- 群消息默认忽略（`allowGroups` 可开；回复发到群里，所有人可见，注意隐私）。
- 图片/文件消息当前只取文本段，附件不透传给 agent。
- 追问往返只支持“下一句话=答案”，多问题/多选场景按第一问处理。

## 常驻化（可选）

```powershell
# 计划任务示例：开机自启、崩溃自动拉起
schtasks /Create /TN "dsh-kivio-im" /SC ONLOGON /TR "cmd /c dsh --profile kivio-im >> %USERPROFILE%\.dsh\profiles\kivio-im\run.log 2>&1"
```
