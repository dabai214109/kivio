# kivio-im-gateway —— 方案 C：完全自研极简网关（QQ ↔ Kivio 对话框，UI 驱动）

> 手机 QQ 发消息 → 网关把它**真实送进 Kivio 桌面对话框**（界面可见）→ 轮询对话文件取回执行结果 → 回发 QQ。
> Node.js 单进程，仅依赖 `ws` + `yaml`；无机器人框架、无黑盒。

```
手机QQ ↔ NapCat/OneBot11(WS:3001) ↔ 自研 gateway(Node.js)
                                      ├─ adapters/onebot.js     收消息 / 分段回发 / 自动重连
                                      ├─ driver/ui-automation   剪贴板+UIA/坐标：粘贴回车、新对话、停止、切换
                                      ├─ driver/conv-store      conversations/ 只读轮询（revision 游标）
                                      ├─ session.js             qq号↔conv_id 映射 + 队列 + 指令
                                      └─ gateway.js             编排：发送→识别对话→等回复→回发
                                                ↕ %APPDATA%\com.zmair.kivio\conversations\conv_<id>.json
                                                ↕ Kivio Desktop（Mode A：UI 驱动，需保持运行）
```

## 目录

```
kivio-im-gateway/
├─ config.example.yaml      # 配置模板（复制为 config.yaml）
├─ package.json
├─ src/
│  ├─ index.js              # 入口：配置、单例锁、信号处理
│  ├─ probe.js              # 落地前置验证（探活：窗口/UIA/对话目录/OneBot）
│  ├─ config.js             # yaml 加载 + 默认值 + 环境变量覆盖
│  ├─ logger.js
│  ├─ gateway.js            # 单轮编排（详见下文时序）
│  ├─ session.js            # 映射持久化(data/sessions.json) + 队列 + /指令
│  ├─ adapters/onebot.js    # OneBot11 正向 WS 客户端
│  └─ driver/
│     ├─ powershell.js      # PS 子进程（-EncodedCommand，规避转义/中文编码）
│     ├─ ui-automation.js   # Mode A 全部 UI 操作
│     └─ conv-store.js      # index.json 快照 + revision 游标 + assistant 提取
├─ data/                    # 运行期产物（sessions.json / gateway.lock）
├─ smoke-test.mjs           # 冒烟：配置加载 + 对话存储读取（只读真实 Kivio 数据）
└─ test-onebot.mjs          # OneBot 客户端离线测试（本地模拟 OneBot11 服务端）
```

## 快速开始

### 1. 依赖

- Node.js ≥ 18.17（本机验证于 v24）。
- NapCat 已跑通 QQ 并开启 OneBot11 正向 WS（默认假设 `ws://127.0.0.1:3001`）。
- Kivio Desktop 已安装并可启动。

### 2. 安装并配置

```powershell
cd "D:\ruanjian\Kivio\program\IM gateway\kivio-im-gateway"
npm install
Copy-Item config.example.yaml config.yaml
# 编辑 config.yaml：至少把 onebot.allow_private 填上你的 QQ 号
```

### 3. 强烈建议：开启 WebView2 无障碍（UIA 模式）

UIA 定位输入框需要 Kivio 以如下环境变量启动（一次性设置，永久生效）：

```powershell
[Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', '--force-renderer-accessibility', 'User')
```

设置后**重启 Kivio**。不开启也能用（自动退回坐标兜底模式），但稳定性下降。

### 4. 探活

```powershell
npm run probe     # 检查：Kivio 窗口 / UIA Edit 可见性 / 对话目录与 index.json
npm run doctor    # probe + OneBot WS 连通性（需 NapCat 已启动）
```

### 5. 启动

```powershell
npm start
```

手机 QQ 私聊机器人发 `/help` 验证；随后任意文本都会送进 Kivio 执行并回发结果。

## 单轮执行时序（Mode A）

1. **鉴权**：白名单外的消息丢弃（或回复未授权）。
2. **指令**：`/new` `/stop` `/status` `/bind` `/help` 直接处理。
3. **准备对话**：有映射且文件仍在 → 尽力切换到该会话（UIA 按标题点击侧栏）；否则点“新对话”。
4. **UI 发送**：剪贴板写入 → 激活窗口 → 焦点进输入框（UIA 优先，坐标兜底）→ Ctrl+V → Enter。
5. **identify**：轮询 `index.json`（≤20s），找 revision 增长或新出现的 conv → 更新映射。
6. **collect**：轮询 `conv_<id>.json`，等 `timestamp > 发送时刻` 的 assistant 消息出现，且 revision 连续 3 次不变（流式写完）→ 取全文。
7. **回发**：按 4000 字分段、带 `（i/N）` 序号回发；10 分钟超时则提示并把已生成部分发回。

## 指令

| 指令 | 作用 |
|---|---|
| `/new` | 解除映射，下一条消息在新 Kivio 对话中执行 |
| `/stop` | 停止当前轮（UIA 点“停止”按钮，找不到则发 Esc 兜底） |
| `/status` | 执行/排队状态、当前 conv_id、上次错误 |
| `/bind conv_<uuid>` | 绑定到指定对话（需 Kivio 当前打开它，切换是尽力而为） |
| `/help` | 帮助 |

## 配置项（config.yaml）

| 键 | 默认 | 说明 |
|---|---|---|
| `onebot.ws_url` | `ws://127.0.0.1:3001` | NapCat 正向 WS |
| `onebot.access_token` | 空 | 与 NapCat 一致 |
| `onebot.allow_private` / `allow_group` | `[]` | **白名单，必填**；空 = 拒绝一切 |
| `onebot.on_not_allowed` | `drop` | 白名单外：静默丢 / 回复未授权 |
| `kivio.conversations_dir` | 自动探测 | 对话目录 |
| `kivio.poll_interval_ms` | 800 | 文件轮询间隔 |
| `kivio.identify_timeout_sec` | 20 | 发送后识别目标对话的窗口 |
| `kivio.settle_polls` | 3 | revision 静默次数（判定回复写完） |
| `kivio.input_coords.x_ratio/y_ratio` | 0.5/0.93 | 坐标兜底的输入条位置（窗口比例） |
| `session.timeout_min` | 10 | 单轮超时 |
| `session.max_queue` | 10 | 每用户排队上限 |
| `session.split_length` | 4000 | 回复分段长度 |
| `session.ack_message` | true | 先回执“已提交” |
| `session.forget_after_min` | 720 | 映射过期时间 |

环境变量覆盖：`KIG_ONEBOT_WS`、`KIG_ONEBOT_TOKEN`、`KIG_CONVERSATIONS_DIR`。

## 设计依据（来自方案文档第 0 节探针实测）

- 发送必须走 UI：Kivio 不监听对话目录，写文件不会触发执行（已验证）。
- 接收走文件轮询可靠：每轮 Kivio 重写 conv json 与 index.json，`revision` 单调递增。
- UIA 需要无障碍开关；树取不到时坐标兜底（窗口几何按比例推算输入条）。
- 回复/请求错位用 revision 游标规避：只消费发送时刻之后新增的 assistant 消息。

## 风险与对策

| 风险 | 对策 |
|---|---|
| UIA 控件名随版本变化 | 定位分层（UIA→坐标）；`npm run probe` 先探活；失败路径都有明确回发 |
| 焦点被抢占/用户正在用 Kivio | 每次发送都重新激活窗口；指令/回执都走 QQ 不依赖本地交互 |
| 切换历史会话失败 | 明确提示“消息将进当前打开的对话”，identify 阶段用 index diff 自动纠正映射 |
| 长回复超限 | 分段 + 序号 |
| 多开 | `data/gateway.lock` 单例锁 |

## 常驻化（可选）

```powershell
schtasks /Create /TN "kivio-im-gateway" /SC ONLOGON /TR "cmd /c cd /d D:\ruanjian\Kivio\program\IM gateway\kivio-im-gateway && npm start >> run.log 2>&1"
```

（也可用 NSSM 装成服务；记得让服务账户能访问交互式桌面——UI 自动化必须在交互会话里跑。）

## 边界

- 只做了 Mode A（UI 驱动）。Mode B（dsh 无头直驱）不再需要自研——那就是方案 D（`../kivio-dsh-onebot/`）。
- 群消息支持白名单开启，回复发到群里（所有人可见）。
- 图片/附件不透传；只处理文本。
