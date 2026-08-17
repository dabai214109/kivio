# Kivio IM Gateway — 微信/QQ 远程驱动 Kivio 方案

> 目标：手机微信/QQ 和机器人对话 → 机器人把消息送进 Kivio 对话框（复用或新建）→ Kivio 执行 → 机器人把执行结果发回手机。
> 对标：Claude Code IM Gateway（IM 消息 ↔ 本地编码代理双向桥接）。

## ✅ 已确认的决策（2026-08-16）
- **IM 通道**：QQ —— NapCat / Lagrange + OneBot11 协议（本机跑框架，WebSocket 连接）。
- **执行模式**：Mode A —— UI 驱动为主（消息真实进 Kivio 对话框，界面可见，Kivio 需保持运行）。
- **技术栈**：Node.js（OneBot/机器人生态最全；Windows 输入自动化走 PowerShell 子进程，零原生依赖）。
- **交付物**：`kivio-im-gateway/` P0 骨架（见第 6 节目录，源码即方案）。

## 🔄 更新：IM 层改用现成框架（LangBot / AstrBot）
经核实（GitHub 实时数据，2026-08-16）：
- **LangBot**（`RockChinQ/LangBot`，Apache-2.0，Python）：自称"生产级多平台智能机器人平台"，插件系统 + Agent + 知识库编排，QQ（NapCat/OneBot）/微信（企微、公众号）/Telegram/Discord 等，仍在活跃维护，官网 langbot.app。
- **AstrBot**（已迁移到 **`AstrBotDevs/AstrBot`**，≈39k stars，Python）：IM 平台/LLM/插件集成框架，仍在活跃维护（2026-08 有推送），有桌面版 + 图形化启动器。网上确有长期运行内存增长（内存泄漏）的反馈。
- **两者都不原生支持"把消息注入 Kivio 对话框"**——它们的标准链路是 IM→LLM API→回复，Kivio 桥仍需自研，但可以大幅缩小为「框架内一个插件」。

**推荐架构（LangBot 或 AstrBot 承载 IM 层 + Kivio Bridge 插件）**：
```
手机QQ（NapCat/OneBot） ↔ LangBot/AstrBot（多平台接入、WebUI、会话管理）
                              ↕ 插件（Kivio Bridge）
                     Kivio 对话框（UI 驱动发送 + 轮询对话文件取回）
```
- 省掉了自研的：OneBot 客户端、多平台适配、消息分片、连接管理、WebUI。
- 只需要写：Kivio Bridge 插件（约几百行：UI 自动化发送 + `revision` 游标轮询结果）。
- 因框架是 Python，插件用 Python + `uiautomation`/pywin32 写，Win32 UI 自动化反而更顺手。
- **AstrBot 内存泄漏对策（对 LangBot 同样适用）**：定时重启（任务计划/NSSM 自动重启）、限制会话历史（本场景机器人侧可做成**无状态转发**——历史本来就在 Kivio 对话文件里，每轮不累积上下文，天然绕开主要内存增长源）、内存监控告警。

## 🔀 IM 层三种选型方案（详细对比）

### 三者共同内核：Kivio Bridge（无论选哪个方向都要写，只有这一块不可省）
- **发送**：激活 Kivio 窗口 → 剪贴板写入 → 焦点进输入框 → Ctrl+V → 回车；输入框定位用 UIA（需 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility` 重启 Kivio）或坐标兜底。
- **接收**：轮询 `conversations/conv_<id>.json`，以 `revision` 为游标增量取 assistant 全文（已验证该文件每轮被 Kivio 重写）。
- **会话映射**：`qq号 ↔ conv_<uuid>` 持久化；首条消息建新对话（UIA 点"新对话"或手动建后绑定）。
- **队列/指令/超时**：同会话排队、`/new` `/stop` `/status`、默认 10 分钟超时。
- 工作量约 300–500 行（不含框架差异）。

### 方案 A：LangBot 承载 IM 层
```
QQ ↔ NapCat/OneBot ↔ LangBot（多平台接入、WebUI、会话、限速）
                        ↕ 插件 langbot-kivio-bridge（Python）
                     Kivio Bridge 内核 → Kivio 对话框
```
- 插件形态：LangBot 插件系统（Python）。**落地先验证**：插件事件能否"吞掉"消息、不让它走 LangBot 内置 LLM（查 langbot.app 插件/事件文档或看示例插件）。
- 优点：生产级定位、QQ 走 NapCat 成熟、官网文档全、可顺带扩展企业微信/公众号/Telegram。
- 缺点：额外依赖其插件 API 契约；Python 环境（venv）。
- 工作量：中（桥插件 + LangBot 部署配置）。

### 方案 B：AstrBot 承载 IM 层
```
QQ ↔ NapCat/OneBot ↔ AstrBot（IM 平台/LLM/插件框架，WebUI、桌面版）
                        ↕ 插件 astrbot-kivio-bridge（Python，命令/事件处理器可自定义回复）
                     Kivio Bridge 内核 → Kivio 对话框
```
- 插件形态：AstrBot 插件可直接注册命令/事件处理并返回自定义回复（不走 LLM），契合度高。
- 优点：插件生态最丰富、有桌面版+启动器、多 LLM/平台。
- 缺点：**内存泄漏风评**——对策：① 机器人侧无状态转发（不累积上下文）；② 定时重启（NSSM/计划任务）；③ 内存监控告警；④ 注意项目已迁移到 `AstrBotDevs` 组织，装最新组织下版本。
- 工作量：中（同上）。

### 方案 C：完全自研极简网关（Node.js，最初的方案）
```
QQ ↔ NapCat/OneBot ↔ 自研 gateway（Node.js）
     ├─ OneBot WS 客户端（ws 库，~200 行）
     ├─ Kivio Bridge 内核（Mode A）
     ├─ 会话映射 + 队列 + 分段发送（~300 行）
     └─ config.yaml（单文件配置）
```
- 优点：无第三方框架 API 契约、行为完全可控、无框架级内存隐患、体积最小（只装 `ws`/`yaml`）；可顺带实现 Mode B（dsh 直驱）作为 Phase 2。
- 缺点：多平台（微信等）要自己接；无 WebUI（日志+配置文件够用）；一切自理。
- 工作量：中（约 1500–2500 行，但都是直白代码）。

### 横向对比

| 维度 | A: LangBot | B: AstrBot | C: 自研 |
|---|---|---|---|
| 本机部署复杂度 | 中（Python venv） | 中（有桌面版更易） | 低（Node 18+ 即跑） |
| QQ/NapCat 接入 | 现成 | 现成 | 自己写 WS 客户端 |
| 多平台扩展（微信等） | ✅现成 | ✅现成 | ❌需自研 |
| WebUI/管理面板 | ✅ | ✅ | ❌（配置文件+日志） |
| 框架 API 契约风险 | 中（需验证插件拦截） | 低（插件成熟） | 无 |
| 内存泄漏风险 | 低 | 中（按对策可解） | 无 |
| 后续加 Mode B（无头直驱） | 中间隔一层（插件内调） | 中间隔一层 | 直接内建 |
| 总工作量排序 | 中 | 中 | 中（无框架学习成本） |

### 建议
- 追求**省接入 + 以后扩展微信/Telegram** → **A: LangBot**（先 PoC 验证插件拦截能力）。
- 看重**插件生态/桌面管理**且愿意做内存对策 → **B: AstrBot**。
- 只跑 QQ、要**最可控最简** → **C: 自研**（Node.js 一套代码讲清楚，无黑盒）。

### 落地前置验证清单（三个方向通用，P0 必做）
1. NapCat/Lagrange 本机跑通，OneBot WS 收/发通。
2. Kivio 输入自动化探活：设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 重启后 UIA 能否定位输入框；不行则坐标模式。
3. （A/B）读目标框架插件文档，确认"拦截消息→返回自定义回复、不走内置 LLM"的写法；用最小插件验证。

## 🧩 补充：dsh 官方有没有类似插件？（已核实）
**没有现成的 IM 网关插件**。核对了两处：
- 本机 `.dsh` 已装官方包全量清单（约 180 个 `@deepseek-ai/*`，即 dsh-base bundle）：**没有任何 onebot/qq/wechat/telegram/im 相关组件**。
- npm 注册表探测 10 个候选名（`dsh-onebot`/`dsh-qq`/`dsh-wechat`/`dsh-im-gateway`/`dsh-telegram` 等）**全部 404**；`@zmair/kivio` 也 404（Kivio 同样没有对外 SDK）。

**但官方给了"自己造"的全部积木（最正宗的造法）**：
| 官方包 | 作用 |
|---|---|
| `dsh` / `dsh-headless` / `dsh-base` | 直接跑 Agent/Session，无 Host/HTTP/浏览器层——Kivio 就是这么用的 |
| `dsh-web-app` + `dsh-host-webserver` + `dsh-client-connection` | dsh 自己可起 **HTTP/WS 服务器**（默认 `127.0.0.1:3080`），外部客户端经 WebSocket 连入驱动会话 |
| `@deepseek-ai/dsh-sdk-jsonrpc-server` + `dsh-sdk-protocol` | 公开 SDK：第三方像 Kivio 一样经 stdio/WS JSON-RPC 驱动 dsh 会话（范例即 `.dsh/profiles/kivio/kivio-dsh-bridge.mjs`） |

**因此存在"方案 D：dsh 官方插件路线"（不经 Kivio 对话框）**：
```
QQ ↔ NapCat/OneBot ↔ dsh 插件（cordis，仿 kivio-dsh-bridge 写法）
                          ├─ OneBot 适配器（收消息/回发）
                          └─ ctx.agents 会话（每条 QQ 消息 → session/prompt → 回发回复）
```
- 用官方 Agent/Session/LLM 全套，**比自研网关代码更少、无第三方框架内存包袱**；会话持久化落在 `.dsh/sessions/`（可 resume）。
- 代价：消息不进 Kivio 对话框（Kivio 只作可选的"展示副本"）。
- 判定：**必须 Kivio 对话框可见** → 走 A/B/C + Kivio Bridge；**对话只在 QQ 里就行** → 方案 D 最优（最正统、最省代码）。

---

## 0. 事先验证过的关键事实（探针实测，非猜测）

| # | 事实 | 验证方式 | 结论 |
|---|------|----------|------|
| 1 | Kivio 的对话存储 | `%APPDATA%\com.zmair.kivio\conversations\conv_<id>.json`（含 messages、revision、agent_runtime、provider/model）+ `index.json` | 权威数据源，app 每轮都会重写 |
| 2 | **文件注入不能触发执行** | ① 新建 `conv_test_im_*.json` 注入用户消息 → 12s 后 index.json 无记录、无 live session、文件未被触碰；② 给空闲外部会话追加用户消息 + revision+1 → 15s 后无新 assistant 回复、live 文件未变 | ❌ Kivio **不监听** 自己的对话目录，写入文件不会让 Kivio 执行 |
| 3 | assistant 回复会落盘 | 外部 dsh 会话 `conv_dd591ff0`/`conv_73622c85` 均 user/assistant 成对持久化 | ✅ **轮询对话文件是可靠的结果回传通道** |
| 4 | Kivio 无对外 API | 无 kivio:// 协议注册；kivio.exe（Tauri+WebView2）无本地 HTTP/WS 监听端口；`export-chat-protocol.exe` 只是把内部协议 schema 导出为 ts/json | ❌ 没有官方第三方调用面 |
| 5 | UI 默认不暴露给无障碍 | Tauri 窗口 UIA 树只到 `BrowserRootView`，WebView2 网页内容默认不可见 | ⚠️ 需要 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility` 重启 Kivio 后才能用 UIA 定位输入框 |
| 6 | Kivio 的执行引擎 | 对话分 builtin（Kivio 内置跑模型）与 external（spawn `dsh` CLI，profile `kivio`，stdin/stdout 走 `dsh_json_rpc`：`session/open`、`session/prompt`、`session/ask`、`session/cancel`、`session/command`） | gateway 可复用同一套 dsh 运行时做**无头执行**（Mode B） |

结论：**发送必须走 UI 自动化（键盘/剪贴板+回车），接收走文件轮询**；这是当前 Kivio 唯一可行的外部驱动组合。

---

## 1. 总体架构

```
┌─────────────┐      ┌──────────────────────────────┐      ┌──────────────────────┐
│  手机端       │      │     IM Gateway（本机常驻）     │      │  Kivio Desktop（本机） │
│  微信 / QQ    │      │                              │      │                      │
└──────┬──────┘      └──────────────────────────────┘      └──────────┬───────────┘
       │ 消息                                                          │
       ▼                                                              │
┌───────────────┐   OneBot/Webhook    ┌────────────────┐   UIA/剪贴板   │
│ 机器人框架      │ ──────────────────▶ │  IM Adapter 层  │              │
│ NapCat/        │  ◀────────────────── │  (可插拔)       │ ──────────▶ │ 对话框输入框/发送 │
│ Lagrange/      │   回复(文本/图片)     │                │              │  (复用或新建)     │
│ 公众号/企业微信  │                     ├────────────────┤              ▼
│               │                     │  Session 映射    │      conversations/conv_<id>.json
└───────────────┘                     │  user↔conv_id   │ ◀────────── 轮询读取回复
                                      ├────────────────┤       (app 每轮写入)
                                      │  Kivio Driver   │
                                      │  Mode A: UI 驱动 │ ◀─┐ 可选
                                      │  Mode B: dsh 直驱 │──┘ 无头执行
                                      └────────────────┘
```

链路（Mode A，默认）：
1. 用户手机发消息 → 机器人框架收到 → 推给 gateway 的 adapter。
2. gateway 查会话映射 `wechat:<wxid> → conv_<uuid>`；无则新建（UIA 点“新对话”），有则切到该对话。
3. 剪贴板写入文本 → 激活 Kivio 窗口 → 焦点进输入框 → Ctrl+V → 回车。
4. gateway 轮询 `conversations/conv_<id>.json`：出现新 assistant 消息（按 timestamp/revision 判断）即算完成。
5. 取最后 assistant 文本（+附件路径），按平台长度限制分段回发手机。

---

## 2. 组件设计

### 2.1 IM Adapter（机器人侧，可插拔）
统一出/入接口，YAML 里选一个启用：

```yaml
adapters:
  qq_napcat:        # 推荐：NapCat / Lagrange + OneBot11（ws/http）
    type: onebot
    ws: "ws://127.0.0.1:3001"
    access_token: ""
  wechat_gzh:       # 订阅号/服务号：被动回复 + 客服消息（需已认证服务号才能主动推送）
    type: wechat_official
    token: "..."   # 微信公众平台消息校验
    app_id: "..."
    app_secret: "..."
  wechat_personal:  # 个人微信 hook（如 wcferry/wechaty）：封号风险，仅限小号测试
    type: wechat_hook
    ...
```

入站消息统一结构：
```ts
interface InboundMessage {
  platform: 'qq' | 'wechat' | ...;
  user_id: string;          // 发送者唯一 id
  text: string;
  attachments?: {path: string; kind: 'image'|'file'|...}[];
  ts: number;
}
```
出站：`send_reply(user_id, segments)` —— 支持文本分段 / 图片（本地路径或 base64）。

### 2.2 Session 映射与状态
- 映射表存本地 JSON/SQLite：`{ 'wechat:wxid_xxx': 'conv_<uuid>', created_at, title, last_active }`。
- 会话内消息**排队**：同一 conv 只允许一个运行中任务，后续消息进队列，避免打断上一轮。
- 指令：`/new`（新建对话）、`/stop`（取消当前轮：Mode A 点停止按钮；Mode B 发 `session/cancel`）、`/status`。
- 超时：默认 10 分钟无新 assistant 消息 → 判定失败/超时并回发提示；`timeout_min` 可配。

### 2.3 Kivio Driver

#### Mode A — UI 驱动（默认，Kivio 界面真实可见、结果实时出现在对话框）
- 前置：Kivio 启动 + 设置环境变量 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--force-renderer-accessibility` 后重启（让 WebView2 内容暴露给 Windows UIA），或用**坐标+剪贴板**方案（不依赖无障碍）。
- 发送：激活主窗口（`SetForegroundWindow`）→ 定位输入框（UIA `Edit`/`Document` 控件，或点底部输入条坐标）→ 剪贴板写入文本 → `Ctrl+V` → `Enter`。
- 新建对话：UIA 点击“新对话”按钮；若第一步失败则用快捷键（若有）。
- 接收：轮询 `conversations/conv_<id>.json`（0.5–1s 间隔），比对 `revision` / 最后一条消息 ts；只取 run 结束后新增的 assistant 全文（`content` 字段完整）。
- 失败兜底：UIA 树取不到输入框时，自动退回坐标模式；坐标从窗口几何（底部 10% 高度中线）推算。

#### Mode B — dsh 直驱（可选增强 / Kivio 未开时兜底）
- gateway 以 **dsh_json_rpc 客户端** 身份 spawn `dsh`（`C:\Users\18758\.dsh` 已装好 profile `kivio`，与 Kivio 同 provider/model/preset/skills）。
- 协议（stdio 换行分隔 JSON-RPC，与 Kivio↔dsh 桥完全一致）：
  - `session/open` `{sessionId, resume: bool}`
  - `session/prompt` `{sessionId, ...}`（注入用户消息）
  - 事件流回传（text_delta / run_completed / run_failed…）
  - `session/cancel` `{sessionId}`、`session/command` `{sessionId, line: "/..."}`、`shutdown`
- 会话持久化在 `.dsh/sessions/`，可 resume；工作目录用 `chat-workspaces/conv_<uuid>/`，与 UI 对话共用。
- 结果除回发手机外，可把完整转录写入 Kivio store（新建 conv json，仅展示不触发执行——已验证合法）或仅作为网关日志。

**推荐：Phase 1 只做 Mode A；Phase 2 加 Mode B 做“Kivio 没开也能跑”的增强。**

---

## 3. 关键风险与对策

| 风险 | 对策 |
|------|------|
| UIA 元素 ID 随版本变化 | 定位器分层（UIA→坐标兜底）；坐标阈值做成配置；发消息前先“探活”（能拿到输入框才算就绪） |
| 窗口焦点被抢占/用户正在用 Kivio | 只在空闲时驱动；发送前检测对话区域文本是否等于自己上轮回显，防重入；支持开关 `only_when_idle` |
| 微信个人号封号 | 默认推荐 QQ（NapCat/Lagrange）或公众号/企业微信；个人号 hook 仅限小号 |
| 长回复超 IM 长度上限 | 按平台分段（QQ 约 4500 字/条，微信约 2000 字/条），消息序号 `1/3` |
| 回复与用户消息错位（异步轮询竞态） | 以 conv json 的 `revision` 为游标：记录“处理到 rev=N”，只消费 >N 的 assistant 消息 |
| 多用户同时用 | 每个用户独立会话 + 队列；gateway 单例锁 |
| 本轮中断（Kivio 崩溃/窗口关闭） | Mode B 兜底自动接替；心跳监控 Kivio 进程 |

---

## 4. 实施方案（分阶段）

- **P0 — PoC 最小闭环（半天~1天）**：NapCat(QQ) 或公众号 → webhook 接收 → Mode A 发送到**固定测试对话** → 轮询取回 assistant 文本 → 回发。验证 UIA/坐标稳定性。
- **P1 — 完整功能**：会话映射（新建/复用/`/new`）、队列与超时、分段发送、`/stop`、多用户。
- **P2 — 增强**：Mode B 无头直驱、图片/附件双向、`/status` 汇报、开机自启、日志面板。

## 5. 技术栈建议
- **Node.js 18+**（机器人生态最全：OneBot SDK、wechaty、公众号 SDK 都有现成包；UIA 走 PowerShell 子进程或 `uiautomation` 包 / `nut.js` 做输入自动化）。
- 或 **Python**（`uiautomation` 库对 Win32 UIA 支持极好 + `cairosvg` 等），QQ 生态稍弱。
- 配置：单文件 `config.yaml`；常驻进程由 NSSM/计划任务守护。

## 6. 目录结构（建议）
```
kivio-im-gateway/
├─ config.yaml                # 适配器、模式、超时、白名单
├─ src/
│  ├─ adapters/               # onebot.ts / wechat-official.ts / wechat-hook.ts
│  ├─ driver/
│  │  ├─ ui-automation.ts      # Mode A：UIA + 剪贴板 + 坐标兜底
│  │  ├─ dsh-jsonrpc.ts        # Mode B：dsh 子进程 JSON-RPC 客户端
│  │  └─ conv-store.ts         # conversations/ 读写与 revision 游标
│  ├─ session.ts               # user↔conv 映射 + 队列
│  └─ gateway.ts               # 主循环/编排
└─ deploy/                    # NSSM 服务安装脚本、开机自启
```