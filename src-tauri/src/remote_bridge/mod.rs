//! Kivio Remote：手机浏览器 ↔ 自建中继服务器 ↔ 桌面端。
//!
//! 与 [`crate::im_gateway`] 平行的第二个常驻桥：目标不是 IM 私聊回发，
//! 而是「远程完整的会话界面」——手机上浏览会话列表/历史、发消息、收回复、停止生成。
//!
//! 连接拓扑（全部出站，桌面无需公网）：
//!
//! ```text
//! Kivio 桌面端 ──wss 出站──▶ 中继服务器(用户自建) ◀──wss 出站── 手机浏览器
//! ```
//!
//! 协议见 `remote-bridge/README.md`。本模块只负责桌面端一侧：
//! 配对（拿 device_token）+ 以 device 身份维持长连接 + 执行远程指令。
//!
//! 消息执行完全复用聊天内部路径（[`crate::chat::commands`]），
//! 发送/超时/取消的模式与 im_gateway 一致。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use futures::StreamExt;
use tokio_tungstenite::tungstenite::Message;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::chat::commands::catalog::{chat_get_conversation, create_chat_conversation_internal};
use crate::chat::commands::send::chat_send_message;
use crate::chat::types::ConversationListItem;
use crate::state::AppState;

/* ========================================================================== */
/* 全局运行状态                                                                */
/* ========================================================================== */

static SHUTDOWN_TX: OnceLock<tokio::sync::watch::Sender<bool>> = OnceLock::new();
static CONNECTED: AtomicBool = AtomicBool::new(false);
static LAST_ACTIVITY: Mutex<u64> = Mutex::new(0);

fn shutdown_rx() -> tokio::sync::watch::Receiver<bool> {
    SHUTDOWN_TX
        .get_or_init(|| tokio::sync::watch::channel(false).0)
        .subscribe()
}

/// app 退出时调用（lib.rs）。
pub fn request_shutdown() {
    if let Some(tx) = SHUTDOWN_TX.get() {
        let _ = tx.send(true);
    }
}

fn is_shutdown_requested() -> bool {
    SHUTDOWN_TX
        .get()
        .map(|tx| *tx.borrow())
        .unwrap_or(false)
}

/// 配对流程状态（设置页轮询）。
#[derive(Debug, Clone)]
enum PairPhase {
    Idle,
    Pending { server_url: String, code: String, client_url: String },
    Paired { device_token: String },
    Failed { error: String },
}

static PAIRING: OnceLock<Mutex<PairPhase>> = OnceLock::new();

fn pairing() -> &'static Mutex<PairPhase> {
    PAIRING.get_or_init(|| Mutex::new(PairPhase::Idle))
}

/* ========================================================================== */
/* 纯函数（tests/remote_bridge.rs 可测）                                       */
/* ========================================================================== */

/// `server_url` → WebSocket base。https→wss，http→ws，裸域名默认 wss。
pub fn ws_url_from_server(server_url: &str) -> String {
    let url = server_url.trim().trim_end_matches('/');
    if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if url.is_empty() {
        String::new()
    } else {
        format!("wss://{url}")
    }
}

/// 把对话历史裁成手机端需要的最小 JSON（role/content/reasoning），丢弃附件/图片等大字段。
pub fn slim_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter(|m| matches!(m.get("role").and_then(Value::as_str), Some("user") | Some("assistant")))
        .map(|m| {
            let mut obj = json!({
                "role": m.get("role").cloned().unwrap_or(Value::Null),
                "content": m.get("content").cloned().unwrap_or(Value::Null),
            });
            if let Some(reasoning) = m.get("reasoning").filter(|r| !r.is_null()) {
                obj["reasoning"] = reasoning.clone();
            }
            obj
        })
        .collect()
}

/// 会话列表项 → 手机端最小 JSON。
pub fn conv_list_item(item: &ConversationListItem) -> Value {
    json!({
        "id": item.id,
        "title": item.title,
        "preview": item.preview,
        "updated_at": item.updated_at,
        "message_count": item.message_count,
    })
}

/// 配对 URL → 内联 SVG 二维码（无外部渲染依赖，前端直接插入 DOM）。
pub fn qr_svg(text: &str) -> Result<String, String> {
    let code = qrcode::QrCode::with_error_correction_level(
        text.as_bytes(),
        qrcode::EcLevel::M,
    )
    .map_err(|e| format!("二维码生成失败: {e}"))?;
    let colors = code.to_colors();
    let width = code.width();
    let margin = 4usize;
    let size = width + margin * 2;
    let mut path = String::new();
    for y in 0..width {
        for x in 0..width {
            if colors[y * width + x] == qrcode::Color::Dark {
                path.push_str(&format!("M{}{}h1v1h-1z", x + margin, y + margin));
            }
        }
    }
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" \
         shape-rendering=\"crispEdges\" width=\"230\" height=\"230\">\
         <rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>\
         <path d=\"{path}\" fill=\"#111111\"/></svg>"
    ))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ========================================================================== */
/* 常驻 supervisor：设置热生效 + 断线重连                                       */
/* ========================================================================== */

enum ServeStop {
    Shutdown,
    Disconnected,
}

pub async fn run(app: AppHandle) {
    let mut shutdown = shutdown_rx();
    let mut backoff_secs: u64 = 1;

    loop {
        if is_shutdown_requested() {
            break;
        }
        let Some(state) = app.try_state::<AppState>() else {
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        let cfg = state.settings_read().remote_bridge.clone();
        let token = cfg.device_token.trim().to_string();
        let runnable = cfg.enabled && !cfg.server_url.trim().is_empty() && !token.is_empty();

        if !runnable {
            CONNECTED.store(false, Ordering::Relaxed);
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                _ = shutdown.changed() => break,
            }
            backoff_secs = 1;
            continue;
        }

        eprintln!("[remote-bridge] connecting {} ...", cfg.server_url);
        let stop = serve_device(&app, &cfg.server_url, &token, &mut shutdown).await;
        CONNECTED.store(false, Ordering::Relaxed);

        match stop {
            ServeStop::Shutdown => break,
            ServeStop::Disconnected => {
                eprintln!("[remote-bridge] disconnected; retry in {backoff_secs}s");
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(backoff_secs)) => {}
                    _ = shutdown.changed() => break,
                }
                backoff_secs = (backoff_secs * 2).min(30);
            }
        }
    }
    eprintln!("[remote-bridge] supervisor exited");
}

/* ========================================================================== */
/* device 连接：一问一答 + 长任务不阻塞读循环                                   */
/* ========================================================================== */

async fn serve_device(
    app: &AppHandle,
    server_url: &str,
    device_token: &str,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> ServeStop {
    let (ws, _) = match tokio_tungstenite::connect_async(format!(
        "{}/ws?mode=device&token={}",
        ws_url_from_server(server_url),
        device_token
    ))
    .await
    {
        Ok(v) => v,
        Err(err) => {
            eprintln!("[remote-bridge] connect failed: {err}");
            return ServeStop::Disconnected;
        }
    };
    eprintln!("[remote-bridge] device connected");

    use futures::SinkExt;
    let (mut sink, mut stream) = ws.split();

    // writer 任务独占 sink；读循环和各长任务通过 mpsc 投递回复。
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Message>(64);
    let writer = tokio::spawn(async move {
        while let Some(frame) = out_rx.recv().await {
            if sink.send(frame).await.is_err() {
                break;
            }
        }
    });

    let stop = loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = out_tx.send(Message::Text(json!({"type":"bye"}).to_string().into())).await;
                break ServeStop::Shutdown;
            }
            frame = stream.next() => {
                match frame {
                    Some(Ok(msg)) => {
                        match msg {
                            tokio_tungstenite::tungstenite::Message::Text(text) => {
                                handle_frame(app, &text, &out_tx).await;
                                *LAST_ACTIVITY.lock().unwrap_or_else(|e| e.into_inner()) = now_ms();
                            }
                            // 中继 30s 心跳：必须回 pong，否则会被服务端踢掉。
                            tokio_tungstenite::tungstenite::Message::Ping(payload) => {
                                out_tx
                                    .try_send(tokio_tungstenite::tungstenite::Message::Pong(payload))
                                    .ok();
                            }
                            _ => {}
                        }
                    }
                    _ => break ServeStop::Disconnected,
                }
            }
        }
    };

    writer.abort();
    stop
}

async fn handle_frame(app: &AppHandle, text: &str, out_tx: &tokio::sync::mpsc::Sender<Message>) {
    let Ok(frame) = serde_json::from_str::<Value>(text) else { return };
    let Some(kind) = frame.get("type").and_then(Value::as_str) else { return };
    let reply_of = |mut v: Value| {
        if let Some(req) = frame.get("req_id") {
            v["req_id"] = req.clone();
        }
        Message::Text(v.to_string().into())
    };

    match kind {
        "hello" => {
            CONNECTED.store(true, Ordering::Relaxed);
            eprintln!("[remote-bridge] ready (server hello)");
        }
        "conv_list" => {
            let result = list_conversations(app).await;
            let _ = out_tx.send(reply_of(result)).await;
        }
        "conv_history" => {
            let id = frame
                .get("conversation_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let result = conversation_history(app, &id).await;
            let _ = out_tx.send(reply_of(result)).await;
        }
        "send" => {
            // 长任务：spawn 执行，读循环继续收（stop 才能生效）。
            let app = app.clone();
            let out_tx = out_tx.clone();
            let conversation_id = frame
                .get("conversation_id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let content = frame
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            tokio::spawn(async move {
                let result = run_send(&app, conversation_id, content, &out_tx).await;
                out_tx.try_send(Message::Text(result.to_string().into())).ok();
            });
        }
        "stop" => {
            let id = frame
                .get("conversation_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            cancel_generation(app, &id);
            let _ = out_tx.send(reply_of(json!({"type":"stop_ack"}))).await;
        }
        "ping" => {
            let _ = out_tx.send(reply_of(json!({"type":"pong"}))).await;
        }
        _ => {}
    }
}

async fn list_conversations(app: &AppHandle) -> Value {
    match crate::chat::repository::repository(app)
        .list(app, 0, 50, None, None, None)
        .await
    {
        Ok(items) => json!({
            "type": "conv_list_result",
            "conversations": items.iter().map(conv_list_item).collect::<Vec<_>>(),
        }),
        Err(err) => json!({"type":"conv_list_result", "error": crate::chat::repository::repository_error(err)}),
    }
}

async fn conversation_history(app: &AppHandle, conversation_id: &str) -> Value {
    if conversation_id.is_empty() {
        return json!({"type":"conv_history_result", "error":"缺少 conversation_id"});
    }
    match chat_get_conversation(app.clone(), conversation_id.to_string()).await {
        Ok(value) => {
            let messages = value
                .get("conversation")
                .and_then(|c| c.get("messages"))
                .and_then(Value::as_array)
                .map(|m| slim_messages(m))
                .unwrap_or_default();
            json!({
                "type": "conv_history_result",
                "conversation_id": conversation_id,
                "messages": messages,
            })
        }
        Err(err) => json!({"type":"conv_history_result","conversation_id":conversation_id,"error":err}),
    }
}

/* ========================================================================== */
/* 发送一轮：与 im_gateway::run_turn 同模式（超时→取消→兜底部分内容）           */
/* ========================================================================== */

const TURN_TIMEOUT_SECS: u64 = 600;
const CANCEL_GRACE_SECS: u64 = 8;

async fn ensure_conversation(app: &AppHandle, conversation_id: Option<String>) -> Option<String> {
    if let Some(id) = conversation_id {
        if crate::chat::storage::load_conversation(app, &id).is_ok() {
            return Some(id);
        }
        eprintln!("[remote-bridge] conversation {id} missing; creating a new one");
    }
    let state = app.state::<AppState>();
    match create_chat_conversation_internal(
        app,
        state.inner(),
        None, None, None, None, None, None,
    )
    .await
    {
        Ok(conversation) => Some(conversation.id.to_string()),
        Err(err) => {
            eprintln!("[remote-bridge] create conversation failed: {err}");
            None
        }
    }
}

async fn run_send(
    app: &AppHandle,
    conversation_id: Option<String>,
    content: String,
    out_tx: &tokio::sync::mpsc::Sender<Message>,
) -> Value {
    if content.trim().is_empty() {
        return json!({"type":"turn_error","error":"消息为空"});
    }
    let Some(conv_id) = ensure_conversation(app, conversation_id).await else {
        return json!({"type":"turn_error","error":"创建会话失败"});
    };
    // 先广播 turn_started，手机端据此进入「生成中」并可随时停止。
    out_tx
        .try_send(Message::Text(
            json!({"type":"turn_started","conversation_id":conv_id}).to_string().into(),
        ))
        .ok();

    let send = chat_send_message(
        app.clone(),
        app.state::<AppState>(),
        conv_id.clone(),
        content,
        Vec::new(),
        None,
        None,
    );
    let mut send = Box::pin(send);

    match tokio::time::timeout(Duration::from_secs(TURN_TIMEOUT_SECS), send.as_mut()).await {
        Ok(result) => turn_result(result, &conv_id),
        Err(_) => {
            cancel_generation(app, &conv_id);
            match tokio::time::timeout(Duration::from_secs(CANCEL_GRACE_SECS), send.as_mut()).await {
                Ok(result) => turn_result(result, &conv_id),
                Err(_) => {
                    let partial = load_last_assistant(app, &conv_id);
                    json!({"type":"turn_done","conversation_id":conv_id,"content":partial.unwrap_or_default(),"cancelled":true})
                }
            }
        }
    }
}

fn turn_result(result: Result<Value, String>, conv_id: &str) -> Value {
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
                .and_then(crate::im_gateway::last_assistant_content);
            if success {
                json!({"type":"turn_done","conversation_id":conv_id,"content":reply.unwrap_or_default()})
            } else if error == crate::chat::commands::reply_runtime::CHAT_REPLY_BUSY_ERROR {
                json!({"type":"turn_busy","conversation_id":conv_id})
            } else {
                json!({"type":"turn_error","conversation_id":conv_id,"error":error})
            }
        }
        Err(err) => json!({"type":"turn_error","conversation_id":conv_id,"error":err}),
    }
}

fn load_last_assistant(app: &AppHandle, conv_id: &str) -> Option<String> {
    let conversation = crate::chat::storage::load_conversation(app, conv_id).ok()?;
    conversation
        .messages
        .iter()
        .rev()
        .find(|m| m.role == "assistant")
        .map(|m| m.content.clone())
}

fn cancel_generation(app: &AppHandle, conv_id: &str) {
    let Some(state) = app.try_state::<AppState>() else { return };
    state.cancel_chat_generation(conv_id);
    if let Some(control) = state.external_live_session_control_any(conv_id) {
        tauri::async_runtime::spawn(async move {
            let _ = control.send(crate::external_agents::session::live::SessionCommand::Cancel).await;
        });
    }
}

/* ========================================================================== */
/* 配对                                                                        */
/* ========================================================================== */

async fn pairing_connect(app: AppHandle, server_url: String, code: String) {
    use futures::SinkExt;

    let ws_url = format!(
        "{}/ws?mode=device&code={}",
        ws_url_from_server(&server_url),
        code
    );
    let (ws, _) = match tokio_tungstenite::connect_async(ws_url).await {
        Ok(v) => v,
        Err(err) => {
            eprintln!("[remote-bridge] pairing connect failed: {err}");
            *pairing().lock().unwrap_or_else(|e| e.into_inner()) =
                PairPhase::Failed { error: format!("连接中继失败: {err}") };
            return;
        }
    };
    let (mut sink, mut stream) = ws.split();

    // 等服务器下发 session_bound（配对码被手机扫码后触发）。
    let mut device_token: Option<String> = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10 * 60);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break,
            frame = stream.next() => {
                let Some(Ok(Message::Text(text))) = frame else { break };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                match v.get("type").and_then(Value::as_str) {
                    Some("session_bound") => {
                        device_token = v
                            .get("device_token")
                            .and_then(Value::as_str)
                            .map(|s| s.to_string());
                        break;
                    }
                    Some("error") => {
                        let error = v.get("error").and_then(Value::as_str).unwrap_or("配对失败").to_string();
                        *pairing().lock().unwrap_or_else(|e| e.into_inner()) = PairPhase::Failed { error };
                        let _ = sink.close().await;
                        return;
                    }
                    _ => {}
                }
            }
        }
    }

    let Some(token) = device_token else {
        *pairing().lock().unwrap_or_else(|e| e.into_inner()) =
            PairPhase::Failed { error: "配对超时（10 分钟内没有设备扫码）".into() };
        return;
    };

    eprintln!("[remote-bridge] pairing complete");
    *pairing().lock().unwrap_or_else(|e| e.into_inner()) = PairPhase::Paired {
        device_token: token.clone(),
    };

    // 直接用新 token 进入正式 serve（supervisor 随后用设置里的 token 重连时会
    // 把这条连接挤掉——服务器对同一 device 的重复连接发送 replaced 关闭旧连接）。
    let mut shutdown = shutdown_rx();
    let _ = serve_device(&app, &server_url, &token, &mut shutdown).await;
}

#[tauri::command]
pub(crate) async fn remote_bridge_start_pairing(
    app: AppHandle,
    server_url: String,
) -> Result<Value, String> {
    let server_url = server_url.trim().trim_end_matches('/').to_string();
    if server_url.is_empty() {
        return Err("请先填写中继服务器地址".into());
    }
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = http
        .post(format!("{server_url}/api/pair"))
        .send()
        .await
        .map_err(|e| format!("请求配对失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("配对接口返回 {}", resp.status()));
    }
    let value: Value = resp.json().await.map_err(|e| format!("解析配对响应失败: {e}"))?;
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .ok_or("配对响应缺少 code")?
        .to_string();
    let client_url = value
        .get("client_url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let qr = qr_svg(&client_url)?;

    *pairing().lock().unwrap_or_else(|e| e.into_inner()) = PairPhase::Pending {
        server_url: server_url.clone(),
        code: code.clone(),
        client_url: client_url.clone(),
    };
    tauri::async_runtime::spawn(pairing_connect(app, server_url, code.clone()));

    Ok(json!({
        "code": code,
        "client_url": client_url,
        "qr_svg": qr,
    }))
}

#[tauri::command]
pub(crate) fn remote_bridge_pairing_status() -> Value {
    let guard = pairing().lock().unwrap_or_else(|e| e.into_inner());
    match &*guard {
        PairPhase::Idle => json!({"status":"idle"}),
        PairPhase::Pending { code, client_url, .. } => {
            json!({"status":"pending","code":code,"client_url":client_url})
        }
        PairPhase::Paired { device_token } => {
            json!({"status":"paired","device_token":device_token})
        }
        PairPhase::Failed { error } => json!({"status":"failed","error":error}),
    }
}

#[tauri::command]
pub(crate) fn remote_bridge_cancel_pairing() {
    *pairing().lock().unwrap_or_else(|e| e.into_inner()) = PairPhase::Idle;
}

#[tauri::command]
pub(crate) fn remote_bridge_status(app: AppHandle) -> Value {
    let (enabled, server_url, token_set) = app
        .try_state::<AppState>()
        .map(|state| {
            let cfg = state.settings_read().remote_bridge.clone();
            (
                cfg.enabled,
                cfg.server_url.clone(),
                !cfg.device_token.trim().is_empty(),
            )
        })
        .unwrap_or((false, String::new(), false));
    json!({
        "enabled": enabled,
        "connected": CONNECTED.load(Ordering::Relaxed),
        "server_url": server_url,
        "token_set": token_set,
    })
}
