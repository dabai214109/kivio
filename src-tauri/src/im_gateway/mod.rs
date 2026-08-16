//! IM 网关：QQ（NapCat / OneBot11 正向 WebSocket）↔ Kivio 会话 双向桥。
//!
//! 手机 QQ 私聊 → 本模块（常驻 tokio 任务）→ [`crate::chat::commands::send::chat_send_message`]
//! （与聊天窗口输入框**完全相同**的生成路径，消息真实出现在 Kivio 对话里）→ 该函数
//! 本身 await 完整一轮并带回最终 assistant 消息 → 分段回发 QQ。
//!
//! 设计要点（对标库内既有范式）：
//! - 监督循环照 MCP idle reaper / probe watcher 的写法（lib.rs setup 里 spawn），
//!   每 2s 重读设置：改开关/地址/token 无需重启即生效；断线指数退避（封顶 30s）。
//! - 会话映射 `qq号 → conversation_id` 持久化在 `{app_data}/im-gateway/sessions.json`，
//!   与 external-agent-sessions 同思路。
//! - 每用户用 keyed mutex 串行（同一用户同一时间只跑一轮），跨用户并行。
//! - 超时取消走两条既有路径：内置循环 `AppState::cancel_chat_generation`，外部 CLI
//!   会话 `SessionCommand::Cancel`；随后宽限等待收尾（`chat_send_message` 取消后以
//!   `cancelled` 正常返回）。
//! - 白名单（`imGateway.allowUsers`）外的私聊静默丢弃；群消息 v1 不处理。
//!
//! 已知边界：无头执行时若全局审批策略不是 `auto`，工具审批请求会等 GUI，60s 超时后
//! 按拒绝处理（interaction.rs 的 fail-closed）——设置页有提示文案。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::chat::commands::catalog::create_chat_conversation_internal;
use crate::chat::commands::send::chat_send_message;
use crate::external_agents::session::live::SessionCommand;
use crate::settings::ImGatewayConfig;
use crate::state::AppState;

/// 每用户排队上限（同一用户在途 + 等待的消息条数）。
const MAX_QUEUED_PER_USER: usize = 5;
/// OneBot API 调用（回发消息）的超时。
const SEND_API_TIMEOUT_SECS: u64 = 15;
/// 取消后的宽限等待：`chat_send_message` 收到取消后应在此窗口内返回。
const CANCEL_GRACE_SECS: u64 = 20;
/// 分段发送之间的间隔，规避风控。
const SPLIT_INTERVAL_MS: u64 = 350;

/* ========================================================================== */
/* 生命周期信号                                                                */
/* ========================================================================== */

static SHUTDOWN_TX: OnceLock<tokio::sync::watch::Sender<bool>> = OnceLock::new();

fn shutdown_rx() -> tokio::sync::watch::Receiver<bool> {
    SHUTDOWN_TX
        .get_or_init(|| tokio::sync::watch::channel(false).0)
        .subscribe()
}

/// 请求网关停止（lib.rs 的 ExitRequested 真退出分支调用；幂等）。
pub fn request_shutdown() {
    if let Some(tx) = SHUTDOWN_TX.get() {
        let _ = tx.send(true);
    }
}

fn is_shutdown_requested() -> bool {
    SHUTDOWN_TX
        .get()
        .is_some_and(|tx| *tx.borrow())
}

/* ========================================================================== */
/* 状态快照（/status 指令与 im_gateway_status 命令共用）                        */
/* ========================================================================== */

#[derive(Clone, Default)]
struct StatusInfo {
    enabled: bool,
    connected: bool,
    ws_url: String,
    bot_name: String,
    /// 正在执行的轮数（跨用户合计）。
    active_turns: usize,
}

static STATUS: OnceLock<Mutex<StatusInfo>> = OnceLock::new();

fn status_mut() -> &'static Mutex<StatusInfo> {
    STATUS.get_or_init(|| Mutex::new(StatusInfo::default()))
}

fn update_status(f: impl FnOnce(&mut StatusInfo)) {
    let mut guard = status_mut().lock().unwrap_or_else(|e| e.into_inner());
    f(&mut guard);
}

/// 供前端/调试查看网关状态。
#[tauri::command]
pub(crate) fn im_gateway_status() -> Value {
    let guard = status_mut().lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "enabled": guard.enabled,
        "connected": guard.connected,
        "wsUrl": guard.ws_url,
        "botName": guard.bot_name,
        "activeTurns": guard.active_turns,
    })
}

/* ========================================================================== */
/* 纯函数：消息解析 / 回复分段（可单测）                                        */
/* ========================================================================== */

/// OneBot 消息段（数组或字符串）→ 纯文本。字符串格式剥掉 CQ 码；数组只取 text 段。
/// pub：tests/ 集成测试需要（lib 单测二进制在 Windows 上因 comctl32 v6 manifest
/// 缺失无法启动，见 build.rs 注释）。
pub fn onebot_message_to_text(message: &Value) -> String {
    match message {
        Value::String(s) => strip_cq_codes(s),
        Value::Array(segments) => {
            let mut out = String::new();
            for seg in segments {
                let Some(obj) = seg.as_object() else { continue };
                match obj.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(text) = obj.get("data").and_then(|d| d.get("text")).and_then(Value::as_str) {
                            out.push_str(text);
                        }
                    }
                    Some("at") => {
                        if let Some(qq) = obj.get("data").and_then(|d| d.get("qq")) {
                            out.push_str(&format!("@{qq}"));
                        }
                    }
                    _ => {}
                }
            }
            out.trim().to_string()
        }
        _ => String::new(),
    }
}

/// 去掉 `[CQ:...]` 码（字符串格式消息里可能混有）。
pub fn strip_cq_codes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        if c == '[' && s[i..].starts_with("[CQ:") {
            // 跳到下一个 ']'
            if let Some(end) = s[i..].find(']') {
                for _ in 0..end {
                    chars.next();
                }
                continue;
            }
        }
        out.push(c);
    }
    out.trim().to_string()
}

/// 把回复按 `limit` 切块；多块时带 `（i/N）` 序号前缀。
pub fn split_reply(text: &str, limit: usize) -> Vec<String> {
    let limit = limit.max(50);
    if text.chars().count() <= limit {
        return vec![text.to_string()];
    }
    let chunks: Vec<String> = text
        .chars()
        .collect::<Vec<_>>()
        .chunks(limit)
        .map(|c| c.iter().collect::<String>())
        .collect();
    let total = chunks.len();
    chunks
        .into_iter()
        .enumerate()
        .map(|(i, c)| format!("（{}/{total}）\n{c}", i + 1))
        .collect()
}

/* ========================================================================== */
/* 会话映射持久化                                                              */
/* ========================================================================== */

struct SessionStore {
    path: PathBuf,
    map: HashMap<String, String>,
}

impl SessionStore {
    fn load(app: &AppHandle) -> Self {
        let path = sessions_file_path(app);
        let map = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(&raw).ok())
            .unwrap_or_default();
        Self { path, map }
    }

    fn save(&self) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(raw) = serde_json::to_string_pretty(&self.map) {
            let _ = std::fs::write(&self.path, raw);
        }
    }

    fn get(&self, qq: &str) -> Option<&String> {
        self.map.get(qq)
    }

    fn set(&mut self, qq: &str, conv_id: &str) {
        self.map.insert(qq.to_string(), conv_id.to_string());
        self.save();
    }

    fn remove(&mut self, qq: &str) {
        if self.map.remove(qq).is_some() {
            self.save();
        }
    }
}

fn sessions_file_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("kivio-im-gateway"))
        .join("im-gateway")
        .join("sessions.json")
}

/* ========================================================================== */
/* 网关共享状态                                                                */
/* ========================================================================== */

struct Gateway {
    app: AppHandle,
    sessions: Mutex<SessionStore>,
    /// 每用户串行锁。
    user_locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    /// 每用户等待数（排队上限）。
    user_waiting: Mutex<HashMap<String, Arc<AtomicUsize>>>,
    /// 当前连接的回发通道（断线时为 None）。
    outbound: Mutex<Option<OutboundHandle>>,
}

impl Gateway {
    fn new(app: AppHandle) -> Self {
        Self {
            sessions: Mutex::new(SessionStore::load(&app)),
            user_locks: Mutex::new(HashMap::new()),
            user_waiting: Mutex::new(HashMap::new()),
            outbound: Mutex::new(None),
            app,
        }
    }

    fn user_lock(&self, qq: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.user_locks.lock().unwrap_or_else(|e| e.into_inner());
        locks
            .entry(qq.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    fn user_waiting(&self, qq: &str) -> Arc<AtomicUsize> {
        let mut map = self.user_waiting.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(qq.to_string())
            .or_insert_with(|| Arc::new(AtomicUsize::new(0)))
            .clone()
    }

    /// 回发私聊；未连接时静默失败（调用方已尽量在连接内使用）。
    async fn send_private(&self, user_id: i64, text: &str) -> Result<(), String> {
        let outbound = self
            .outbound
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let Some(outbound) = outbound else {
            return Err("gateway not connected".to_string());
        };
        outbound.call("send_private_msg", json!({ "user_id": user_id, "message": text })).await
    }

    /// 连接断开后清掉出站通道，让后续回发快速失败而不是挂在死流上。
    fn clear_outbound(&self) {
        self.outbound
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}

/// 一条已建立连接的出站能力（API echo 匹配 + 写半流）。
#[derive(Clone)]
struct OutboundHandle {
    writer: Arc<tokio::sync::Mutex<futures::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, tokio_tungstenite::tungstenite::Message>>>,
    pending: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    echo_seq: Arc<AtomicUsize>,
}

impl OutboundHandle {
    /// 调用 OneBot API，成功时返回完整响应 JSON（`data` 由调用方自行取用）。
    async fn call_raw(&self, action: &str, params: Value) -> Result<Value, String> {
        let echo = format!("im-{}", self.echo_seq.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel::<Value>();
        self.pending
            .lock()
            .await
            .insert(echo.clone(), tx);
        let frame = json!({ "action": action, "params": params, "echo": echo });
        {
            let mut writer = self.writer.lock().await;
            writer
                .send(tokio_tungstenite::tungstenite::Message::Text(frame.to_string().into()))
                .await
                .map_err(|e| format!("ws send failed: {e}"))?;
        }
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(SEND_API_TIMEOUT_SECS),
            rx,
        )
        .await
        // 超时后残留的 echo 项不在此清理（闭包里无法 await）：迟到的响应会在
        // handle_packet 的 echo 匹配处自然出队；永不响应则占用可忽略。
        .map_err(|_| format!("onebot api {action} timeout"))?
        .map_err(|_| "onebot api response channel closed".to_string())?;
        let retcode = response
            .get("status")
            .and_then(|s| s.get("retcode"))
            .and_then(Value::as_i64)
            .unwrap_or(-1);
        if retcode == 0 {
            Ok(response)
        } else {
            Err(format!(
                "onebot api {action} retcode={retcode} msg={}",
                response.get("status").and_then(|s| s.get("msg")).and_then(Value::as_str).unwrap_or("?")
            ))
        }
    }

    async fn call(&self, action: &str, params: Value) -> Result<(), String> {
        self.call_raw(action, params).await.map(|_| ())
    }
}

/* ========================================================================== */
/* 监督循环                                                                    */
/* ========================================================================== */

enum ServeStop {
    Disabled,
    SettingsChanged,
    Disconnected,
    Shutdown,
}

pub async fn run(app: AppHandle) {
    let gateway = Arc::new(Gateway::new(app.clone()));
    let mut shutdown = shutdown_rx();
    let mut backoff_secs: u64 = 1;

    loop {
        if is_shutdown_requested() {
            break;
        }
        let state = match app.try_state::<AppState>() {
            Some(state) => state,
            None => {
                // AppState 尚未 manage（极早期）：稍后再试。
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
        };
        let cfg = state.settings_read().im_gateway.clone();
        update_status(|s| {
            s.enabled = cfg.enabled;
            s.ws_url = cfg.ws_url.clone();
        });

        if !cfg.enabled {
            update_status(|s| s.connected = false);
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {}
                _ = shutdown.changed() => break,
            }
            backoff_secs = 1;
            continue;
        }

        eprintln!("[im-gateway] connecting {} ...", cfg.ws_url);
        match serve_connection(&app, &gateway, &cfg, &mut shutdown).await {
            ServeStop::Shutdown => break,
            ServeStop::Disabled => {
                eprintln!("[im-gateway] disabled by settings; standing by");
                backoff_secs = 1;
            }
            ServeStop::SettingsChanged => {
                eprintln!("[im-gateway] settings changed; reconnecting");
                backoff_secs = 1;
            }
            ServeStop::Disconnected => {
                eprintln!("[im-gateway] disconnected; retry in {backoff_secs}s");
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(backoff_secs)) => {}
                    _ = shutdown.changed() => break,
                }
                backoff_secs = (backoff_secs * 2).min(30);
            }
        }
        gateway.clear_outbound();
        update_status(|s| s.connected = false);
    }
    eprintln!("[im-gateway] supervisor exited");
}

async fn serve_connection(
    app: &AppHandle,
    gateway: &Arc<Gateway>,
    cfg: &ImGatewayConfig,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> ServeStop {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    let mut url = cfg.ws_url.clone();
    if !cfg.access_token.is_empty() {
        // NapCat 兼容 query 参数鉴权；同时下面再补 Authorization 头。
        url = format!(
            "{}{}access_token={}",
            url,
            if url.contains('?') { '&' } else { '?' },
            urlencoding_minimal(&cfg.access_token)
        );
    }
    let mut request = match url.into_client_request() {
        Ok(request) => request,
        Err(err) => {
            eprintln!("[im-gateway] invalid ws url {}: {err}", cfg.ws_url);
            return ServeStop::Disconnected;
        }
    };
    if !cfg.access_token.is_empty() {
        if let Ok(value) = cfg.access_token.parse() {
            request.headers_mut().insert("Authorization", value);
        }
    }

    let (ws, _resp) = match tokio_tungstenite::connect_async(request).await {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("[im-gateway] connect failed: {err}");
            return ServeStop::Disconnected;
        }
    };
    eprintln!("[im-gateway] connected to {}", cfg.ws_url);
    update_status(|s| s.connected = true);

    let (writer, mut reader) = ws.split();
    let outbound = OutboundHandle {
        writer: Arc::new(tokio::sync::Mutex::new(writer)),
        pending: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        echo_seq: Arc::new(AtomicUsize::new(0)),
    };
    *gateway
        .outbound
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(outbound.clone());

    // 连上后问一下机器人身份（失败不影响主流程）。
    let info = outbound
        .call_raw("get_login_info", json!({}))
        .await
        .ok()
        .and_then(|v| {
            let nickname = v
                .get("data")
                .and_then(|d| d.get("nickname"))
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string();
            let user_id = v
                .get("data")
                .and_then(|d| d.get("user_id"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            Some(format!("{nickname} ({user_id})"))
        })
        .unwrap_or_default();
    if !info.is_empty() {
        eprintln!("[im-gateway] bot: {info}");
        update_status(|s| s.bot_name = info);
    }

    let mut settings_ticker = tokio::time::interval(std::time::Duration::from_secs(2));
    settings_ticker.tick().await; // interval 首个 tick 立即到，消费掉。

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = shutdown.borrow();
                return ServeStop::Shutdown;
            }
            _ = settings_ticker.tick() => {
                // 设置热生效：关掉或改地址/token → 断开，由监督循环决策。
                let Some(state) = app.try_state::<AppState>() else { continue };
                let latest = state.settings_read().im_gateway.clone();
                if !latest.enabled {
                    return ServeStop::Disabled;
                }
                if latest.ws_url != cfg.ws_url || latest.access_token != cfg.access_token {
                    return ServeStop::SettingsChanged;
                }
            }
            frame = reader.next() => {
                let Some(frame) = frame else {
                    return ServeStop::Disconnected;
                };
                match frame {
                    Ok(tokio_tungstenite::tungstenite::Message::Text(text)) => {
                        handle_packet(app, gateway, &outbound, &text).await;
                    }
                    Ok(tokio_tungstenite::tungstenite::Message::Ping(payload)) => {
                        let _ = outbound
                            .writer
                            .lock()
                            .await
                            .send(tokio_tungstenite::tungstenite::Message::Pong(payload))
                            .await;
                    }
                    Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => {
                        return ServeStop::Disconnected;
                    }
                    Ok(_) => {}
                    Err(err) => {
                        eprintln!("[im-gateway] ws error: {err}");
                        return ServeStop::Disconnected;
                    }
                }
            }
        }
    }
}

/// 极简 URL query 编码（只处理 token 里常见的保留字符）。
pub fn urlencoding_minimal(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

async fn handle_packet(
    app: &AppHandle,
    gateway: &Arc<Gateway>,
    outbound: &OutboundHandle,
    text: &str,
) {
    let Ok(packet) = serde_json::from_str::<Value>(text) else {
        return;
    };

    // API 响应：echo 匹配。
    if let Some(echo) = packet.get("echo").and_then(Value::as_str) {
        if let Some(tx) = outbound.pending.lock().await.remove(echo) {
            let _ = tx.send(packet);
            return;
        }
    }

    if packet.get("post_type").and_then(Value::as_str) != Some("message") {
        return; // 心跳/生命周期等 v1 不关心
    }
    if packet.get("message_type").and_then(Value::as_str) != Some("private") {
        return; // v1 仅私聊
    }
    let Some(user_id) = packet.get("user_id").and_then(Value::as_i64) else {
        return;
    };
    let text = onebot_message_to_text(packet.get("message").unwrap_or(&Value::Null));
    if text.is_empty() {
        return;
    }

    // 白名单。
    let allowed = app
        .try_state::<AppState>()
        .map(|state| {
            state
                .settings_read()
                .im_gateway
                .allow_users
                .iter()
                .any(|u| u == &user_id.to_string())
        })
        .unwrap_or(false);
    if !allowed {
        return;
    }

    dispatch_inbound(gateway.clone(), user_id, text);
}

/* ========================================================================== */
/* 入站消息分发（指令 / 排队 / 执行）                                           */
/* ========================================================================== */

fn dispatch_inbound(gateway: Arc<Gateway>, user_id: i64, text: String) {
    tokio::spawn(async move {
        let qq = user_id.to_string();

        if text.starts_with('/') {
            handle_command(&gateway, user_id, &qq, text.trim()).await;
            return;
        }

        // 排队上限：等待者 + 在途 ≤ MAX_QUEUED_PER_USER。
        let waiting = gateway.user_waiting(&qq);
        let current = waiting.load(Ordering::Relaxed);
        if current >= MAX_QUEUED_PER_USER {
            let _ = gateway
                .send_private(user_id, &format!("队列已满（{MAX_QUEUED_PER_USER} 条），请稍后再试。"))
                .await;
            return;
        }
        waiting.store(current + 1, Ordering::Relaxed);

        let lock = gateway.user_lock(&qq);
        let is_busy = lock.try_lock().is_err();
        if is_busy {
            let _ = gateway.send_private(user_id, "上一条仍在执行，已排队。").await;
        }
        let _guard = lock.lock().await;
        waiting.fetch_sub(1, Ordering::Relaxed);

        let result = std::panic::AssertUnwindSafe(run_turn_for_user(&gateway, user_id, &qq, &text));
        if let Err(panic) = futures::FutureExt::catch_unwind(result).await {
            eprintln!("[im-gateway] turn panicked: {panic:?}");
            let _ = gateway.send_private(user_id, "执行发生内部错误，请重试或 /new 新建会话。").await;
        }
    });
}

async fn handle_command(gateway: &Arc<Gateway>, user_id: i64, qq: &str, text: &str) {
    let mut parts = text.split_whitespace();
    let cmd = parts.next().unwrap_or("");
    match cmd {
        "/help" => {
            let help = [
                "Kivio IM 网关指令：",
                "  /new     新建 Kivio 会话（旧的保留在历史里）",
                "  /stop    停止当前正在执行的一轮",
                "  /status  查看网关与会话状态",
                "  /help    显示本帮助",
                "其余文本将作为消息送入 Kivio 会话执行，结果回发到本对话。",
            ]
            .join("\n");
            let _ = gateway.send_private(user_id, &help).await;
        }
        "/status" => {
            let conv = gateway
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(qq)
                .cloned()
                .unwrap_or_default();
            let (connected, bot) = {
                let guard = status_mut().lock().unwrap_or_else(|e| e.into_inner());
                (guard.connected, guard.bot_name.clone())
            };
            let busy = gateway.user_lock(qq).try_lock().is_err();
            let lines = [
                format!("网关：{}", if connected { "已连接" } else { "未连接" }),
                if bot.is_empty() { String::new() } else { format!("机器人：{bot}") },
                format!("执行：{}", if busy { "执行中" } else { "空闲" }),
                if conv.is_empty() {
                    "Kivio 会话：尚未建立".to_string()
                } else {
                    format!("Kivio 会话：{conv}")
                },
            ];
            let body = lines.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
            let _ = gateway.send_private(user_id, &body).await;
        }
        "/new" => {
            gateway
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(qq);
            let _ = gateway
                .send_private(user_id, "已解除会话映射，下一条消息将在新 Kivio 会话中执行。")
                .await;
        }
        "/stop" => {
            let conv = gateway
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(qq)
                .cloned()
                .unwrap_or_default();
            if conv.is_empty() {
                let _ = gateway.send_private(user_id, "当前没有关联的 Kivio 会话。").await;
                return;
            }
            cancel_turn(&gateway.app, &conv);
            let _ = gateway.send_private(user_id, "已发出停止请求。").await;
        }
        _ => {
            let _ = gateway
                .send_private(user_id, &format!("未知指令 {cmd}，/help 查看可用指令。"))
                .await;
        }
    }
}

/// 取消一路生成：内置循环清 generation；外部 CLI 会话发协议级 Cancel。
fn cancel_turn(app: &AppHandle, conv_id: &str) {
    let Some(state) = app.try_state::<AppState>() else { return };
    state.cancel_chat_generation(conv_id);
    if let Some(control) = state.external_live_session_control_any(conv_id) {
        // 控制通道是异步的；这里用 block_on 会有嵌套运行时风险（调用方本就在 runtime 里），
        // 改为 spawn 投递。
        tauri::async_runtime::spawn(async move {
            let _ = control.send(SessionCommand::Cancel).await;
        });
    }
}

/* ========================================================================== */
/* 单轮执行：确保会话 → chat_send_message → 取回复 → 分段回发                    */
/* ========================================================================== */

enum TurnOutcome {
    /// success:true（含 cancelled 按成功处理）。
    Success { reply: String },
    /// success:false + error。
    Failed { error: String, reply: Option<String> },
    /// 该会话正被其它轮占用（GUI 里在跑）。
    Busy,
    /// 超时且宽限期内未收尾。
    TimedOut { partial: Option<String> },
}

async fn run_turn_for_user(gateway: &Arc<Gateway>, user_id: i64, qq: &str, text: &str) {
    let app = gateway.app.clone();

    // 1) 确保会话：映射存在且文件仍在 → 复用；否则新建。
    let conv_id = ensure_conversation(gateway, qq).await;
    let Some(conv_id) = conv_id else {
        let _ = gateway
            .send_private(user_id, "无法创建 Kivio 会话（详见应用日志）。")
            .await;
        return;
    };

    let _ = gateway.send_private(user_id, "⏳ 已提交给 Kivio，执行完成后回发结果…").await;

    let timeout_sec = app
        .try_state::<AppState>()
        .map(|state| state.settings_read().im_gateway.timeout_sec)
        .unwrap_or(600);
    update_status(|s| s.active_turns += 1);
    let outcome = run_turn(&app, &conv_id, text, timeout_sec).await;
    update_status(|s| s.active_turns = s.active_turns.saturating_sub(1));

    let split_length = app
        .try_state::<AppState>()
        .map(|state| state.settings_read().im_gateway.split_length)
        .unwrap_or(3800);

    match outcome {
        TurnOutcome::Success { reply } => {
            let body = if reply.trim().is_empty() {
                "（本轮没有文本输出）".to_string()
            } else {
                reply.trim().to_string()
            };
            send_chunked(gateway, user_id, &body, split_length).await;
        }
        TurnOutcome::Failed { error, reply } => {
            let _ = gateway
                .send_private(user_id, &format!("⚠️ 执行失败：{error}"))
                .await;
            if let Some(reply) = reply.filter(|r| !r.trim().is_empty()) {
                send_chunked(gateway, user_id, &format!("已生成的部分：\n{}", reply.trim()), split_length).await;
            }
        }
        TurnOutcome::Busy => {
            let _ = gateway
                .send_private(user_id, "该 Kivio 会话正在生成中（可能正被电脑端使用），请稍后再发。")
                .await;
        }
        TurnOutcome::TimedOut { partial } => {
            let _ = gateway
                .send_private(user_id, &format!("⚠️ 超时（{timeout_sec} 秒），已请求停止。"))
                .await;
            if let Some(partial) = partial.filter(|p| !p.trim().is_empty()) {
                send_chunked(gateway, user_id, &format!("已生成的部分：\n{}", partial.trim()), split_length).await;
            }
        }
    }
}

async fn ensure_conversation(gateway: &Arc<Gateway>, qq: &str) -> Option<String> {
    // 复用：映射存在且对话文件仍可加载。
    let existing = {
        let sessions = gateway.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions.get(qq).cloned()
    };
    if let Some(conv_id) = existing {
        if crate::chat::storage::load_conversation(&gateway.app, &conv_id).is_ok() {
            return Some(conv_id);
        }
        eprintln!("[im-gateway] mapped conversation {conv_id} missing; creating a new one");
    }

    // 新建：与聊天窗口「新对话」同一条创建路径，provider/model 走默认选择。
    let state = gateway.app.state::<AppState>();
    match create_chat_conversation_internal(
        &gateway.app,
        state.inner(),
        None, None, None, None, None, None,
    )
    .await
    {
        Ok(conversation) => {
            let conv_id = conversation.id.to_string();
            gateway
                .sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .set(qq, &conv_id);
            eprintln!("[im-gateway] created conversation {conv_id} for {qq}");
            Some(conv_id)
        }
        Err(err) => {
            eprintln!("[im-gateway] create conversation failed: {err}");
            None
        }
    }
}

async fn run_turn(app: &AppHandle, conv_id: &str, content: &str, timeout_sec: u64) -> TurnOutcome {
    let send = chat_send_message(
        app.clone(),
        app.state::<AppState>(),
        conv_id.to_string(),
        content.to_string(),
        Vec::new(),
        None,
        None,
    );
    let mut send = Box::pin(send);

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_sec), send.as_mut()).await {
        // 限时 内正常返回。
        Ok(result) => parse_send_result(result),
        // 超时：触发两条取消路径，再宽限等待收尾（取消后 chat_send_message 以
        // success:true + cancelled 语义返回，或带部分内容失败返回）。
        Err(_) => {
            cancel_turn(app, conv_id);
            match tokio::time::timeout(std::time::Duration::from_secs(CANCEL_GRACE_SECS), send.as_mut()).await {
                Ok(result) => parse_send_result(result),
                Err(_) => {
                    let partial = load_last_assistant(app, conv_id);
                    TurnOutcome::TimedOut { partial }
                }
            }
        }
    }
}

fn parse_send_result(result: Result<Value, String>) -> TurnOutcome {
    match result {
        Ok(value) => {
            let success = value.get("success").and_then(Value::as_bool).unwrap_or(false);
            let error = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let reply = value
                .get("conversation")
                .and_then(|c| c.get("messages"))
                .and_then(Value::as_array)
                .and_then(last_assistant_content);
            if success {
                TurnOutcome::Success {
                    reply: reply.unwrap_or_default(),
                }
            } else if error == crate::chat::commands::reply_runtime::CHAT_REPLY_BUSY_ERROR {
                TurnOutcome::Busy
            } else {
                TurnOutcome::Failed { error, reply }
            }
        }
        Err(err) => TurnOutcome::Failed { error: err, reply: None },
    }
}

pub fn last_assistant_content(messages: &Vec<Value>) -> Option<String> {
    messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(Value::as_str) == Some("assistant"))
        .and_then(|m| m.get("content"))
        .and_then(Value::as_str)
        .map(|s| s.to_string())
}

/// 兜底取盘上最后一条 assistant 消息（超时场景的部分内容）。
fn load_last_assistant(app: &AppHandle, conv_id: &str) -> Option<String> {
    let conversation = crate::chat::storage::load_conversation(app, conv_id).ok()?;
    conversation
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| m.content.clone())
}

async fn send_chunked(gateway: &Arc<Gateway>, user_id: i64, text: &str, limit: usize) {
    let chunks = split_reply(text, limit);
    let total = chunks.len();
    for (i, chunk) in chunks.into_iter().enumerate() {
        if let Err(err) = gateway.send_private(user_id, &chunk).await {
            eprintln!("[im-gateway] send chunk {}/{} failed: {err}", i + 1, total);
            return;
        }
        if i + 1 < total {
            tokio::time::sleep(std::time::Duration::from_millis(SPLIT_INTERVAL_MS)).await;
        }
    }
}
