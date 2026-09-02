# Kivio Remote（远程连接）

手机浏览器 ↔ **自建中继服务器** ↔ Kivio 桌面端。类似 ZCode 的"手机扫码远程"：
桌面端显示二维码，手机扫码后即可在浏览器里浏览 Kivio 会话、发消息、收回复、停止生成。

```text
Kivio 桌面端 ──wss 出站──▶ 中继服务器（你部署，本项目提供） ◀──wss 出站── 手机浏览器
```

- 桌面端与手机都**主动出站**连接中继——Kivio 所在机器无需公网 IP、无需开端口。
- 中继只做**配对与转发**（JSON 帧），不解析、不存储消息内容；落盘的只有 token 映射表。
- 所有流量走 TLS（手机网页与 WebSocket 同域同证书）。

## 目录结构

| 路径 | 说明 |
|---|---|
| `server/relay.mjs` | 中继服务器（Node ≥18，唯一依赖 `ws`） |
| `server/public/index.html` | 手机端网页（中继直接托管，无构建步骤） |
| `Dockerfile` | 容器化部署 |

## 一、部署中继服务器

### 方式 A：裸 Node + systemd

```bash
# 服务器上
unzip server.zip && cd server   # 或 git clone 后拷贝本目录
npm install --omit=dev
PORT=8787 node relay.mjs        # 前台试跑
```

`/etc/systemd/system/kivio-relay.service`：

```ini
[Unit]
Description=Kivio Remote Relay
After=network.target

[Service]
WorkingDirectory=/opt/kivio-remote/server
Environment=PORT=8787
Environment=DATA_FILE=/var/lib/kivio-relay/data.json
ExecStart=/usr/bin/node relay.mjs
Restart=always
User=www-data

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now kivio-relay
```

### 方式 B：Docker

```bash
docker build -t kivio-relay .
docker run -d --name kivio-relay -p 8787:8787 -v kivio-relay-data:/data kivio-relay
```

### TLS（必须）

手机端扫码链接与 WebSocket 都要求 HTTPS/WSS（浏览器 Mixed Content 限制）。
用 nginx 或 caddy 反代即可，以 caddy 最省事：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

nginx 等价配置需同时升级 WebSocket（`proxy_set_header Upgrade/Connection`），
并放行 `/api/pair`、`/ws`、`/` 三个路径。

## 二、Kivio 桌面端配对

1. Kivio 设置 → **远程连接** → 填服务器地址（`https://relay.example.com`）→ 开启开关。
2. 点 **开始配对** → 桌面显示二维码 + 8 位配对码（10 分钟有效）。
3. 手机扫码（或浏览器打开链接 / 输入配对码）→ 网页显示"已连接"。
4. 桌面端自动保存 `device_token`，手机端保存 `client_token`（localStorage），此后双方
   断线自动重连，无需重复配对。

## 三、手机端功能

- 会话列表（最近 50 个，标题/预览/时间）
- 打开会话查看历史（含"思考过程"折叠）
- 新建对话、发送消息、生成中可随时停止
- 回复为完成式回发（生成完毕一次性收到全文；超时 10 分钟自动取消并回收部分内容）

## 协议（JSON over WebSocket）

客户端/桌面端均为出站连接 `GET /ws?mode=device|client&token=…|code=…`。
首次配对用 `code=`，之后用 token。

| 方向 | 消息 |
|---|---|
| 桌面 → 服务器（配对成功） | `session_bound {device_token}` |
| 手机 → 服务器（配对成功） | `client_bound {client_token}` |
| 手机 → 桌面 | `conv_list` / `conv_history {conversation_id}` / `send {conversation_id?, content}` / `stop {conversation_id}` / `ping` |
| 桌面 → 手机 | `conv_list_result` / `conv_history_result` / `turn_started` / `turn_done` / `turn_busy` / `turn_error` / `stop_ack` / `pong` |

### 企业微信回调透传（`/wecom/callback`）

企业微信通道复用同一 relay：桌面端用第二个 device token 连接（IM 网关 → 企业微信 → 连接中继），
企微后台「接收消息」的 URL 填 `https://<relay>/wecom/callback?t=<该token>`。

- relay **不持有企微凭据、不解密**：`GET`（验证 URL）把签名参数转给桌面端解密后 5s 内回显；
  `POST`（消息推送）立即回 `success`（满足企微 5s 应答限制），密文 XML 原样转给桌面端。
- 桌面端发来的 `wecom_verify_result` 是设备控制帧，relay 路由到等待中的回调，不转发给手机。
- 桌面端离线时：验证返回 400；消息回 `success` 但会丢失（企微侧无补推）。

## 安全说明

- 中继请务必置于 HTTPS 反代之后；裸 HTTP 仅限本机/内网调试。
- token 是唯一凭据：`data.json`（token 表）与两端的 token 都要妥善保管；泄露后在服务器
  删除 `data.json` 里对应条目并重启即失效。
- 中继代码只转发，不落消息内容；但**请勿使用不受信的第三方中继**。
- 与 IM 网关相同：Kivio 权限策略不是「完全访问」时，远程触发的工具审批会在 60 秒超时后自动拒绝。
