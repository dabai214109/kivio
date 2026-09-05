//! QQ 官方机器人（q.qq.com 开放平台）适配器 —— WebSocket 方式。
//!
//! 协议要点（官方文档 2026-08 核实）：
//! - 鉴权：`POST https://api.bot.qq.com/app/getAppAccessToken` `{appId, clientSecret}`
//!   → `{access_token, expires_in(~7200s)}`；API/WS 统一用 `Authorization: QQBot <token>`。
//! - 网关：`GET https://api.sgroup.qq.com/gateway` → `{url}`（wss）。连上收 op10 Hello
//!   （心跳周期）→ 发 op2 IDENTIFY（intents、shard）→ 收 READY（session_id）→ 周期
//!   op1 心跳（d=最新 seq）；断线 op6 RESUME 补发。
//! - intents：单聊+群事件共用 `GROUP_AND_C2C_EVENT = 1<<25`；本模块只消费
//!   `C2C_MESSAGE_CREATE`（单聊），群事件忽略。
//! - 回复：`POST /v2/users/{openid}/messages` `{content, msg_type:0, msg_id, msg_seq}`；
//!   被动回复须带触发消息的 msg_id，60 分钟窗口内每条消息最多 4 条（msg_seq 递增）。
//!   因此本模式下不发"已提交"回执、分段上限 4（超了尾部合并）。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::{dispatch_inbound, update_status, Gateway, ServeStop, UserKey};

const API_BASE: &str = "https://api.sgroup.qq.com";
const TOKEN_URL: &str = "https://api.bot.qq.com/app/getAppAccessToken";
/// 单聊+群事件位。
pub const INTENT_GROUP_AND_C2C: u32 = 1 << 25;
/// 被动回复配额：每条入站消息最多回复 4 条。
pub const MAX_PASSIVE_REPLIES: usize = 4;

/* ---------------- token 管理 ---------------- */

struct CachedToken {
    token: String,
    fetched_at: Instant,
    expires_in: u64,
}

/// 提前刷新的余量：官方说明过期前 60s 内请求会拿到新 token，旧 token 仍有 60s 效力。
pub fn token_refresh_after(expires_in: u64) -> Duration {
    Duration::from_secs(expires_in.saturating_sub(60).max(60))
}

pub struct TokenState {
    app_id: String,
    client_secret: String,
    cached: tokio::sync::RwLock<Option<CachedToken>>,
}

impl TokenState {
    pub fn new(app_id: &str, client_secret: &str) -> Self {
        Self {
            app_id: app_id.to_string(),
            client_secret: client_secret.to_string(),
            cached: tokio::sync::RwLock::new(None),
        }
    }

    pub async fn get(&self, http: &reqwest::Client) -> Result<String, String> {
        {
            let guard = self.cached.read().await;
            if let Some(c) = guard.as_ref() {
                if c.fetched_at.elapsed() < token_refresh_after(c.expires_in) {
                    return Ok(c.token.clone());
                }
            }
        }
        self.refresh(http).await
    }

    async fn refresh(&self, http: &reqwest::Client) -> Result<String, String> {
        let resp = http
            .post(TOKEN_URL)
            .json(&json!({ "appId": self.app_id, "clientSecret": self.client_secret }))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("getAppAccessToken 请求失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("getAppAccessToken HTTP {}", resp.status()));
        }
        let body: Value = resp
            .json()
            .await
            .map_err(|e| format!("getAppAccessToken 响应解析失败: {e}"))?;
        let token = body
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("getAppAccessToken 响应缺 access_token: {body}"))?
            .to_string();
        let expires_in = body.get("expires_in").and_then(Value::as_u64).unwrap_or(7200);
        *self.cached.write().await = Some(CachedToken {
            token: token.clone(),
            fetched_at: Instant::now(),
            expires_in,
        });
        Ok(token)
    }
}

/* ---------------- 事件解析（可单测） ---------------- */

pub struct C2cInbound {
    pub openid: String,
    pub content: String,
    pub msg_id: String,
}

/// 解析 C2C_MESSAGE_CREATE 的 `d`：openid 取 author.user_openid（兜底 author.id），
/// content 为空视为无效（纯附件消息 v1 不支持）。
pub fn parse_c2c_event(d: &Value) -> Option<C2cInbound> {
    let msg_id = d.get("id").and_then(Value::as_str)?.to_string();
    let openid = d
        .pointer("/author/user_openid")
        .and_then(Value::as_str)
        .or_else(|| d.pointer("/author/id").and_then(Value::as_str))?
        .to_string();
    let content = d
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if content.is_empty() {
        return None;
    }
    Some(C2cInbound { openid, content, msg_id })
}

/// 分段条数压进被动回复配额：超出 max 时把尾部全部并进最后一段。
pub fn clamp_passive_chunks(chunks: Vec<String>, max: usize) -> Vec<String> {
    let max = max.max(1);
    if chunks.len() <= max {
        return chunks;
    }
    let mut out: Vec<String> = chunks[..max - 1].to_vec();
    out.push(chunks[max - 1..].join("\n"));
    out
}

/// msg_id 去重（官方会重复推送同一 msg_id）：环形缓冲，容量即记忆窗口。
pub struct MsgIdDedup {
    seen: VecDeque<String>,
    cap: usize,
}

impl MsgIdDedup {
    pub fn new(cap: usize) -> Self {
        Self {
            seen: VecDeque::with_capacity(cap),
            cap: cap.max(16),
        }
    }

    /// 记录并返回是否首次出现。
    pub fn push(&mut self, id: &str) -> bool {
        if self.seen.iter().any(|x| x == id) {
            return false;
        }
        if self.seen.len() >= self.cap {
            self.seen.pop_front();
        }
        self.seen.push_back(id.to_string());
        true
    }
}

/* ---------------- 出站通道（被动回复） ---------------- */

struct ReplyState {
    msg_id: String,
    seq: u32,
}

#[derive(Clone)]
pub struct QqOfficialOutbound {
    http: reqwest::Client,
    token: Arc<TokenState>,
    reply_state: Arc<std::sync::Mutex<HashMap<String, ReplyState>>>,
}

impl QqOfficialOutbound {
    pub fn new(http: reqwest::Client, token: Arc<TokenState>) -> Self {
        Self {
            http,
            token,
            reply_state: Arc::new(std::sync::Mutex::new(HashMap::new())),
        }
    }

    /// 收到入站消息时登记：后续回复都挂在这个 msg_id 下（seq 重置）。
    pub fn note_inbound(&self, openid: &str, msg_id: &str) {
        self.reply_state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(openid.to_string(), ReplyState {
                msg_id: msg_id.to_string(),
                seq: 0,
            });
    }

    /// 发一条被动回复；seq 用尽（>MAX_PASSIVE_REPLIES）返回 Err。
    pub async fn send(&self, openid: &str, content: &str) -> Result<(), String> {
        let (msg_id, msg_seq) = {
            let mut map = self.reply_state.lock().unwrap_or_else(|e| e.into_inner());
            let Some(state) = map.get_mut(openid) else {
                return Err("无被动回复上下文（未记录该用户的入站消息）".to_string());
            };
            state.seq += 1;
            if state.seq as usize > MAX_PASSIVE_REPLIES {
                return Err(format!(
                    "被动回复配额用尽（每条消息最多 {MAX_PASSIVE_REPLIES} 条），剩余内容已截断"
                ));
            }
            (state.msg_id.clone(), state.seq)
        };
        let token = self.token.get(&self.http).await?;
        let url = format!("{API_BASE}/v2/users/{openid}/messages");
        let resp = self
            .http
            .post(&url)
            .header("Authorization", format!("QQBot {token}"))
            .json(&json!({ "content": content, "msg_type": 0, "msg_id": msg_id, "msg_seq": msg_seq }))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| format!("发送请求失败: {e}"))?;
        let status = resp.status();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            Ok(())
        } else {
            let code = body.get("code").and_then(Value::as_i64).unwrap_or(0);
            let message = body
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("无错误信息");
            Err(format!("发送失败 HTTP {status} code={code}: {message}"))
        }
    }
}

/* ---------------- 连接主循环 ---------------- */

enum WsStop {
    Disconnected,
    Shutdown,
    SettingsChanged,
}

pub async fn serve(
    app: &AppHandle,
    gateway: &Arc<Gateway>,
    cfg: &crate::settings::ImGatewayConfig,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> ServeStop {
    let qq = &cfg.qq_official;
    let http = app
        .try_state::<crate::state::AppState>()
        .map(|s| s.http.clone())
        .unwrap_or_default();
    let token = Arc::new(TokenState::new(&qq.app_id, &qq.client_secret));

    // 先拿一次 token：凭据错误在这里就暴露，进入退避重连而不是刷屏。
    if let Err(err) = token.get(&http).await {
        eprintln!("[im-gateway/qq-official] 鉴权失败: {err}");
        return ServeStop::Disconnected;
    }

    // 获取 wss 网关地址。
    let gateway_url = match fetch_gateway_url(&http, &token).await {
        Ok(url) => url,
        Err(err) => {
            eprintln!("[im-gateway/qq-official] 获取网关地址失败: {err}");
            return ServeStop::Disconnected;
        }
    };
    eprintln!("[im-gateway/qq-official] gateway: {gateway_url}");

    let outbound = QqOfficialOutbound::new(http.clone(), token.clone());
    gateway.set_outbound(super::OutboundChannel::QqOfficial(outbound.clone()));
    update_status(|s| s.connected = true);

    let mut dedup = MsgIdDedup::new(512);
    // RESUME 会话状态（跨一次断线重连有效）。
    let mut session: Option<(String /*session_id*/, u64 /*last seq*/)> = None;

    loop {
        match ws_session(app, gateway, &gateway_url, &token, &outbound, &mut dedup, &mut session, shutdown).await {
            WsStop::Shutdown => return ServeStop::Shutdown,
            WsStop::SettingsChanged => return ServeStop::SettingsChanged,
            WsStop::Disconnected => {
                eprintln!("[im-gateway/qq-official] 连接断开，1.5s 后重连");
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(1500)) => {}
                    _ = shutdown.changed() => return ServeStop::Shutdown,
                }
            }
        }
    }
}

async fn fetch_gateway_url(http: &reqwest::Client, token: &Arc<TokenState>) -> Result<String, String> {
    let access = token.get(http).await?;
    let resp = http
        .get(format!("{API_BASE}/gateway"))
        .header("Authorization", format!("QQBot {access}"))
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }
    body.get("url")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .ok_or_else(|| format!("响应缺 url: {body}"))
}

/// 一次 WS 会话（连接 → identify/resume → 心跳+收事件）。
async fn ws_session(
    app: &AppHandle,
    gateway: &Arc<Gateway>,
    gateway_url: &str,
    token: &Arc<TokenState>,
    outbound: &QqOfficialOutbound,
    dedup: &mut MsgIdDedup,
    session: &mut Option<(String, u64)>,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> WsStop {
    let (ws, _resp) = match tokio_tungstenite::connect_async(gateway_url).await {
        Ok(pair) => pair,
        Err(err) => {
            eprintln!("[im-gateway/qq-official] 连接失败: {err}");
            return WsStop::Disconnected;
        }
    };
    let (mut writer, mut reader) = ws.split();

    // 等 op10 Hello 拿心跳周期（可被退出信号打断，不挂在无响应连接上）。
    let heartbeat_interval = loop {
        tokio::select! {
            _ = shutdown.changed() => return WsStop::Shutdown,
            frame = reader.next() => {
                match frame {
                    Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text))) => {
                        let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                        if v.get("op").and_then(Value::as_i64) == Some(10) {
                            match v.pointer("/d/heartbeat_interval").and_then(Value::as_u64) {
                                Some(ms) => break Duration::from_millis(ms.max(5000)),
                                None => break Duration::from_secs(30),
                            }
                        }
                    }
                    _ => return WsStop::Disconnected,
                }
            }
        }
    };

    // IDENTIFY（新会话）或 RESUME（有会话）。
    let access = match token.get(&app
        .try_state::<crate::state::AppState>()
        .map(|s| s.http.clone())
        .unwrap_or_default())
        .await
    {
        Ok(t) => t,
        Err(err) => {
            eprintln!("[im-gateway/qq-official] 刷 token 失败: {err}");
            return WsStop::Disconnected;
        }
    };
    let payload = if let Some((session_id, seq)) = session.clone() {
        json!({
            "op": 6,
            "d": { "token": format!("QQBot {access}"), "session_id": session_id, "seq": seq },
        })
    } else {
        json!({
            "op": 2,
            "d": {
                "token": format!("QQBot {access}"),
                "intents": INTENT_GROUP_AND_C2C,
                "shard": [0, 1],
                "properties": { "$os": "windows", "$browser": "kivio", "$device": "kivio" },
            },
        })
    };
    if writer
        .send(tokio_tungstenite::tungstenite::Message::Text(payload.to_string().into()))
        .await
        .is_err()
    {
        return WsStop::Disconnected;
    }

    let mut heartbeat = tokio::time::interval(heartbeat_interval);
    heartbeat.tick().await; // 首个 tick 立即到，消费掉
    let mut last_seq: u64 = session.as_ref().map(|(_, s)| *s).unwrap_or(0);
    let mut settings_ticker = tokio::time::interval(Duration::from_secs(2));
    settings_ticker.tick().await;
    let cfg_snapshot = app
        .try_state::<crate::state::AppState>()
        .map(|s| s.settings_read().im_gateway.clone());

    loop {
        tokio::select! {
            _ = shutdown.changed() => {
                let _ = shutdown.borrow();
                return WsStop::Shutdown;
            }
            _ = heartbeat.tick() => {
                let d: Value = if last_seq > 0 { json!(last_seq) } else { Value::Null };
                let frame = json!({ "op": 1, "d": d });
                if writer
                    .send(tokio_tungstenite::tungstenite::Message::Text(frame.to_string().into()))
                    .await
                    .is_err()
                {
                    return WsStop::Disconnected;
                }
            }
            _ = settings_ticker.tick() => {
                let Some(state) = app.try_state::<crate::state::AppState>() else { continue };
                let latest = state.settings_read().im_gateway.clone();
                if !latest.enabled
                    || latest.provider != "qq_official"
                    || latest.qq_official.app_id != cfg_snapshot.as_ref().map(|c| c.qq_official.app_id.clone()).unwrap_or_default()
                    || latest.qq_official.client_secret != cfg_snapshot.as_ref().map(|c| c.qq_official.client_secret.clone()).unwrap_or_default()
                {
                    return WsStop::SettingsChanged;
                }
            }
            frame = reader.next() => {
                let Some(frame) = frame else { return WsStop::Disconnected };
                let text = match frame {
                    Ok(tokio_tungstenite::tungstenite::Message::Text(t)) => t,
                    Ok(tokio_tungstenite::tungstenite::Message::Close(_)) => return WsStop::Disconnected,
                    Ok(_) => continue,
                    Err(err) => {
                        eprintln!("[im-gateway/qq-official] ws 错误: {err}");
                        return WsStop::Disconnected;
                    }
                };
                let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
                match v.get("op").and_then(Value::as_i64).unwrap_or(-1) {
                    0 => {
                        if let Some(s) = v.get("s").and_then(Value::as_u64) {
                            last_seq = s;
                            if let Some(sess) = session.as_mut() {
                                sess.1 = s;
                            }
                        }
                        let event_type = v.get("t").and_then(Value::as_str).unwrap_or("");
                        match event_type {
                            "READY" => {
                                let username = v
                                    .pointer("/d/user/username")
                                    .and_then(Value::as_str)
                                    .unwrap_or("?")
                                    .to_string();
                                if let Some(session_id) = v.pointer("/d/session_id").and_then(Value::as_str) {
                                    *session = Some((session_id.to_string(), last_seq));
                                }
                                eprintln!("[im-gateway/qq-official] 已就绪，机器人: {username}");
                                update_status(|s| s.bot_name = username);
                            }
                            "RESUMED" => {
                                eprintln!("[im-gateway/qq-official] 会话已恢复");
                            }
                            "C2C_MESSAGE_CREATE" => {
                                let Some(d) = v.get("d") else { continue };
                                let Some(inbound) = parse_c2c_event(d) else { continue };
                                if !dedup.push(&inbound.msg_id) {
                                    continue;
                                }
                                // 白名单：官方模式下空 = 允许所有（openid 事先无从得知）。
                                let allowed = {
                                    let Some(state) = app.try_state::<crate::state::AppState>() else { continue };
                                    let list = &state.settings_read().im_gateway.allow_users;
                                    list.is_empty() || list.iter().any(|u| u == &inbound.openid)
                                };
                                if !allowed {
                                    eprintln!(
                                        "[im-gateway/qq-official] 白名单外 openid={}，已忽略（可填入设置的白名单）",
                                        inbound.openid
                                    );
                                    continue;
                                }
                                outbound.note_inbound(&inbound.openid, &inbound.msg_id);
                                dispatch_inbound(
                                    gateway.clone(),
                                    UserKey::C2c(inbound.openid),
                                    inbound.content,
                                );
                            }
                            _ => {}
                        }
                    }
                    7 => {
                        // 服务端要求重连：保留 session 走 RESUME。
                        eprintln!("[im-gateway/qq-official] 服务端要求重连");
                        return WsStop::Disconnected;
                    }
                    9 => {
                        // 会话无效：丢弃 session，重新 IDENTIFY。
                        eprintln!("[im-gateway/qq-official] 会话失效，重新鉴权");
                        *session = None;
                        return WsStop::Disconnected;
                    }
                    _ => {}
                }
            }
        }
    }
}
