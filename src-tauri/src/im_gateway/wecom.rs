//! 企业微信（WeCom）自建应用适配器。
//!
//! 拓扑：微信服务器 ──HTTPS 回调──▶ 自建中继 `/wecom/callback` ──WS 透传密文──▶ 本模块。
//! 中继**不解密不落内容**（立即 200 应答企微以满足 5s 限制，密文原样转发）；
//! 加解密、签名校验、msg_id 去重、access_token 管理、回发 API 全部在本端完成。
//!
//! 协议要点（WXBizMsgCrypt / 应用消息）：
//! - EncodingAESKey（43 字符）+ `=` base64 解码 → 32 字节 AES-256 key；IV = key 前 16 字节。
//! - 密文 = base64(AES-CBC(PKCS7(16B random + 4B msg_len 大端 + msg + receiveid)))。
//! - 签名 = sha1(lex_sort(token, timestamp, nonce, encrypt) 拼接)。
//! - 回发：`GET /cgi-bin/gettoken`（corpid+corpsecret，2h）→
//!   `POST /cgi-bin/message/send`（text，touser=成员 UserID；42001/40014 过期重试一次）。
//! - 应用消息无被动窗口/条数限制；单条 text ≤ 2048 字节（本端按 ~600 字分段）。

use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::im_gateway::urlencoding_minimal;

const WECOM_API_BASE: &str = "https://qyapi.weixin.qq.com/cgi-bin";
/// 应用消息 text 上限 2048 字节；中文按 3 字节/字，600 字 ≈ 1800 字节，留足余量。
pub const WECOM_MAX_TEXT_CHARS: usize = 600;

/* ========================================================================== */
/* 加解密（纯函数，tests/im_gateway.rs 覆盖）                                   */
/* ========================================================================== */

/// EncodingAESKey（43 字符）→ 32 字节 AES key。
pub fn aes_key_from_encoding_key(encoding_aes_key: &str) -> Result<[u8; 32], String> {
    let key = encoding_aes_key.trim();
    if key.len() != 43 {
        return Err(format!("EncodingAESKey 应为 43 字符，当前 {} 字符", key.len()));
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(format!("{key}="))
        .map_err(|e| format!("EncodingAESKey base64 解码失败: {e}"))?;
    bytes
        .try_into()
        .map_err(|_| "EncodingAESKey 解码后不是 32 字节".to_string())
}

/// 官方签名算法：sha1(lexicographic sort(token, timestamp, nonce, encrypt) 拼接)。
pub fn wecom_signature(token: &str, timestamp: &str, nonce: &str, encrypt: &str) -> String {
    let mut parts = [token, timestamp, nonce, encrypt];
    parts.sort_unstable();
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    for p in parts {
        hasher.update(p.as_bytes());
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(40);
    for b in digest {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// 解密密文 → 原始明文（16B random + 4B len + msg + receiveid），并校验 receiveid。
/// AES-256-CBC 手动链式解密：P_i = D(C_i) XOR C_{i-1}（不依赖 cbc crate 的 feature 矩阵）。
pub fn decrypt_message(aes_key: &[u8; 32], encrypt_b64: &str, receive_id: &str) -> Result<String, String> {
    use aes::cipher::{generic_array::GenericArray, BlockDecrypt, KeyInit};
    use base64::Engine;

    let cipher_b64 = encrypt_b64.trim();
    if cipher_b64.is_empty() {
        return Err("Encrypt 字段为空".into());
    }
    let data = base64::engine::general_purpose::STANDARD
        .decode(cipher_b64)
        .map_err(|e| format!("密文 base64 解码失败: {e}"))?;
    if data.is_empty() || data.len() % 16 != 0 {
        return Err("密文长度不是 16 的倍数".into());
    }

    let cipher = aes::Aes256::new(GenericArray::from_slice(aes_key));
    let mut buf = data;
    let mut prev: [u8; 16] = aes_key[..16].try_into().map_err(|_| "IV 转换失败".to_string())?;
    for block in buf.chunks_exact_mut(16) {
        let cipher_block: [u8; 16] = block.try_into().map_err(|_| "块拷贝失败".to_string())?;
        cipher.decrypt_block(GenericArray::from_mut_slice(block));
        for (b, p) in block.iter_mut().zip(prev.iter()) {
            *b ^= p;
        }
        prev = cipher_block;
    }

    let plain: &[u8] = &buf;
    if plain.len() < 20 {
        return Err("解密结果过短".into());
    }
    // 去 PKCS7 padding（官方实现：以末字节为准，且为 1..=32）。
    let pad = plain[plain.len() - 1] as usize;
    let content_end = if (1..=32).contains(&pad) && pad <= plain.len() {
        plain.len() - pad
    } else {
        plain.len()
    };
    if content_end < 20 {
        return Err("padding 后内容过短".into());
    }
    let body = &plain[..content_end];
    let msg_len = u32::from_be_bytes([body[16], body[17], body[18], body[19]]) as usize;
    if body.len() < 20 + msg_len {
        return Err("明文长度字段越界".into());
    }
    let msg = &body[20..20 + msg_len];
    let rid = &body[20 + msg_len..];
    if !receive_id.is_empty() && String::from_utf8_lossy(rid).trim() != receive_id {
        return Err(format!(
            "receiveid 校验失败：期望 {receive_id}，实际 {}",
            String::from_utf8_lossy(rid).trim()
        ));
    }
    String::from_utf8(msg.to_vec()).map_err(|e| format!("明文不是 UTF-8: {e}"))
}

/// 提取 XML 中单个字段：支持 `<![CDATA[...]]>` 与普通文本节点。
pub fn xml_extract(xml: &str, tag: &str) -> Option<String> {
    // 宽松提取：定位 <Tag ...> 与 </Tag>，避免引入 XML 解析器依赖。
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let start = xml.find(&open)?;
    let gt = xml[start..].find('>')? + start;
    if xml[start..gt + 1].ends_with("/>") {
        return Some(String::new());
    }
    let rest = &xml[gt + 1..];
    let end = rest.find(&close)?;
    let inner = &rest[..end];
    let cdata = inner
        .strip_prefix("<![CDATA[")
        .map(|s| s.strip_suffix("]]>").unwrap_or(s));
    Some(
        cdata
            .map(|s| s.to_string())
            .unwrap_or_else(|| inner_text(inner)),
    )
}

fn inner_text(s: &str) -> String {
    s.trim().to_string()
}

/// 回调密文 XML → Encrypt 字段。
pub fn parse_encrypt_from_xml(xml: &str) -> Option<String> {
    xml_extract(xml, "Encrypt").filter(|s| !s.is_empty())
}

/// 解密后的明文 XML → 消息结构。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WecomMessage {
    pub from: String,
    pub content: String,
    pub msg_id: String,
    pub msg_type: String,
}

pub fn parse_plain_message(xml: &str) -> WecomMessage {
    WecomMessage {
        from: xml_extract(xml, "FromUserName").unwrap_or_default(),
        content: xml_extract(xml, "Content").unwrap_or_default(),
        msg_id: xml_extract(xml, "MsgId").unwrap_or_default(),
        msg_type: xml_extract(xml, "MsgType").unwrap_or_default(),
    }
}

/* ========================================================================== */
/* msg_id 去重（企微对未及时应答会重推）                                        */
/* ========================================================================== */

/// 简单 LRU 去重集合（容量下限 16）。
pub struct MsgIdDedup {
    ids: std::collections::VecDeque<String>,
    cap: usize,
}

impl MsgIdDedup {
    pub fn new(cap: usize) -> Self {
        Self {
            ids: std::collections::VecDeque::new(),
            cap: cap.max(16),
        }
    }

    /// 返回 true = 首次出现（放行）；false = 重复。
    pub fn push(&mut self, id: &str) -> bool {
        if id.is_empty() {
            return true;
        }
        if self.ids.iter().any(|x| x == id) {
            return false;
        }
        self.ids.push_back(id.to_string());
        while self.ids.len() > self.cap {
            self.ids.pop_front();
        }
        true
    }
}

/* ========================================================================== */
/* Outbound：token 缓存 + 应用消息发送                                          */
/* ========================================================================== */

#[derive(Debug)]
pub struct WecomOutbound {
    http: reqwest::Client,
    corp_id: String,
    corp_secret: String,
    pub agent_id: i64,
    token: Mutex<TokenState>,
}

#[derive(Debug)]
struct TokenState {
    access_token: String,
    refresh_at: std::time::Instant,
}

impl Default for TokenState {
    fn default() -> Self {
        Self {
            access_token: String::new(),
            refresh_at: std::time::Instant::now(),
        }
    }
}

impl WecomOutbound {
    pub fn new(corp_id: &str, corp_secret: &str, agent_id: i64) -> Self {
        Self {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .unwrap_or_default(),
            corp_id: corp_id.to_string(),
            corp_secret: corp_secret.to_string(),
            agent_id,
            token: Mutex::new(TokenState::default()),
        }
    }

    async fn get_token(&self) -> Result<String, String> {
        {
            let state = self.token.lock().unwrap_or_else(|e| e.into_inner());
            if !state.access_token.is_empty() && state.refresh_at.elapsed().as_secs() < 7000 {
                return Ok(state.access_token.clone());
            }
        }
        let resp = self
            .http
            .get(format!(
                "{WECOM_API_BASE}/gettoken?corpid={}&corpsecret={}",
                urlencoding_minimal(&self.corp_id),
                urlencoding_minimal(&self.corp_secret),
            ))
            .send()
            .await
            .map_err(|e| format!("请求 access_token 失败: {e}"))?;
        let value: Value = resp.json().await.map_err(|e| format!("解析 token 响应失败: {e}"))?;
        let errcode = value.get("errcode").and_then(Value::as_i64).unwrap_or(0);
        if errcode != 0 {
            return Err(format!(
                "获取 access_token 失败: errcode={errcode} errmsg={}",
                value.get("errmsg").and_then(Value::as_str).unwrap_or("?")
            ));
        }
        let token = value
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or("token 响应缺少 access_token")?
            .to_string();
        {
            let mut state = self.token.lock().unwrap_or_else(|e| e.into_inner());
            state.access_token = token.clone();
            state.refresh_at = std::time::Instant::now();
        }
        Ok(token)
    }

    /// 发送文本；token 过期（42001/40014）自动刷新重试一次。
    pub async fn send_text(&self, user: &str, content: &str) -> Result<(), String> {
        let send = |token: String, content: &str| {
            let http = &self.http;
            let agent_id = self.agent_id;
            async move {
                http.post(format!(
                    "{WECOM_API_BASE}/message/send?access_token={}",
                    urlencoding_minimal(&token)
                ))
                .json(&json!({
                    "touser": user,
                    "msgtype": "text",
                    "agentid": agent_id,
                    "text": { "content": content },
                }))
                .send()
                .await
            }
        };

        let mut token = self.get_token().await?;
        let resp = send(token.clone(), content)
            .await
            .map_err(|e| format!("发送企微消息失败: {e}"))?;
        let value: Value = resp.json().await.map_err(|e| format!("解析发送响应失败: {e}"))?;
        let errcode = value.get("errcode").and_then(Value::as_i64).unwrap_or(0);
        if errcode == 42001 || errcode == 40014 {
            // token 失效：强制刷新重试一次。
            {
                let mut state = self.token.lock().unwrap_or_else(|e| e.into_inner());
                state.access_token.clear();
            }
            token = self.get_token().await?;
            let resp = send(token, content)
                .await
                .map_err(|e| format!("重试发送企微消息失败: {e}"))?;
            let value: Value = resp
                .json()
                .await
                .map_err(|e| format!("解析重试响应失败: {e}"))?;
            return wecom_send_result(value);
        }
        wecom_send_result(value)
    }
}

fn wecom_send_result(value: Value) -> Result<(), String> {
    let errcode = value.get("errcode").and_then(Value::as_i64).unwrap_or(0);
    if errcode == 0 {
        Ok(())
    } else {
        Err(format!(
            "企微发送失败: errcode={errcode} errmsg={}",
            value.get("errmsg").and_then(Value::as_str).unwrap_or("?")
        ))
    }
}

/* ========================================================================== */
/* serve：连中继 wecom 通道，处理 verify/msg 两类帧                             */
/* ========================================================================== */

use tauri::{AppHandle, Manager};

use super::{dispatch_inbound, update_status, Gateway, ServeStop, UserKey};
use crate::state::AppState;

#[derive(Debug, Clone, PartialEq, Eq)]
struct WecomConfigSnapshot {
    enabled: bool,
    relay_url: String,
    relay_token: String,
    corp_id: String,
    corp_secret: String,
    agent_id: i64,
    callback_token: String,
    encoding_aes_key: String,
    allow_users: Vec<String>,
}

fn wecom_cfg_snapshot(app: &AppHandle) -> Option<WecomConfigSnapshot> {
    let state = app.try_state::<AppState>()?;
    let w = &state.settings_read().im_gateway.wecom;
    Some(WecomConfigSnapshot {
        enabled: w.enabled,
        relay_url: w.relay_url.trim().trim_end_matches('/').to_string(),
        relay_token: w.relay_token.clone(),
        corp_id: w.corp_id.clone(),
        corp_secret: w.corp_secret.clone(),
        agent_id: w.agent_id,
        callback_token: w.callback_token.clone(),
        encoding_aes_key: w.encoding_aes_key.clone(),
        allow_users: w.allow_users.clone(),
    })
}

pub async fn serve_wecom(
    app: &AppHandle,
    gateway: &std::sync::Arc<Gateway>,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> ServeStop {
    let Some(snapshot) = wecom_cfg_snapshot(app) else {
        return ServeStop::Disabled;
    };
    if !snapshot.enabled {
        return ServeStop::Disabled;
    }
    let aes_key = match aes_key_from_encoding_key(&snapshot.encoding_aes_key) {
        Ok(k) => k,
        Err(err) => {
            eprintln!("[im-gateway/wecom] {err}");
            return ServeStop::Disabled;
        }
    };
    let relay_url = snapshot.relay_url.clone();
    let relay_token = snapshot.relay_token.clone();
    let allow_users = snapshot.allow_users.clone();
    let corp_id = snapshot.corp_id.clone();
    let corp_secret = snapshot.corp_secret.clone();
    let agent_id = snapshot.agent_id;
    let callback_token = snapshot.callback_token.clone();

    let ws_url = format!(
        "{}/ws?mode=device&token={}",
        crate::remote_bridge::ws_url_from_server(&relay_url),
        urlencoding_minimal(&relay_token)
    );
    let (ws, _) = match tokio_tungstenite::connect_async(&ws_url).await {
        Ok(v) => v,
        Err(err) => {
            eprintln!("[im-gateway/wecom] 连接中继失败: {err}");
            return ServeStop::Disconnected;
        }
    };
    eprintln!("[im-gateway/wecom] 中继已连接");

    let crypto = WecomCrypto {
        callback_token,
        aes_key,
        receive_id: corp_id.clone(),
    };
    let outbound = std::sync::Arc::new(WecomOutbound::new(&corp_id, &corp_secret, agent_id));
    *gateway.wecom_outbound.lock().unwrap_or_else(|e| e.into_inner()) =
        Some(std::sync::Arc::clone(&outbound));
    store_crypto(Some(crypto));
    gateway
        .wecom_allow_users
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .replace(allow_users);
    update_status(|s| s.wecom_connected = true);

    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (mut writer, mut reader) = ws.split();
    let mut dedup = MsgIdDedup::new(512);

    let stop = loop {
        tokio::select! {
            _ = shutdown.changed() => break ServeStop::Shutdown,
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
                // 运行中配置变化（含关闭开关）→ 断开重连，由 supervisor 重读。
                if wecom_cfg_snapshot(app) != Some(snapshot.clone()) {
                    break ServeStop::SettingsChanged;
                }
            }
            frame = reader.next() => {
                match frame {
                    Some(Ok(Message::Text(text))) => {
                        let Ok(frame) = serde_json::from_str::<Value>(&text) else { continue };
                        match frame.get("type").and_then(Value::as_str) {
                            Some("hello") => eprintln!("[im-gateway/wecom] ready"),
                            Some("wecom_verify") => {
                                let reply = handle_verify(&frame);
                                let _ = writer.send(Message::Text(reply.to_string().into())).await;
                            }
                            Some("wecom_msg") => {
                                handle_msg(gateway, &mut dedup, &frame);
                            }
                            _ => {}
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = writer.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => break ServeStop::Disconnected,
                    Some(Ok(_)) => {}
                    Some(Err(err)) => {
                        eprintln!("[im-gateway/wecom] ws error: {err}");
                        break ServeStop::Disconnected;
                    }
                }
            }
        }
    };

    *gateway.wecom_outbound.lock().unwrap_or_else(|e| e.into_inner()) = None;
    store_crypto(None);
    gateway
        .wecom_allow_users
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    update_status(|s| s.wecom_connected = false);
    stop
}

/// 验证回调（GET echostr）：签名校验 + 解密回显。任何失败都不回明文。
fn handle_verify(frame: &Value) -> Value {
    let wid = frame.get("wid").cloned().unwrap_or(Value::Null);
    let result = (|| -> Result<String, String> {
        let q = frame.get("query").cloned().unwrap_or(Value::Null);
        let signature = str_of(&q, "msg_signature");
        let timestamp = str_of(&q, "timestamp");
        let nonce = str_of(&q, "nonce");
        let echostr = str_of(&q, "echostr");
        let Some(crypto) = current_crypto() else {
            return Err("crypto 未就绪".into());
        };
        if !crypto.verify_signature(&signature, &timestamp, &nonce, &echostr) {
            return Err("签名校验失败".into());
        }
        crypto.decrypt_echostr(&echostr)
    })();
    match result {
        Ok(plain) => json!({"type":"wecom_verify_result","wid":wid,"echostr":plain}),
        Err(err) => {
            eprintln!("[im-gateway/wecom] verify 失败: {err}");
            json!({"type":"wecom_verify_result","wid":wid,"error":err})
        }
    }
}

/// 消息回调（POST）：解密 → 去重 → 白名单 → 进入既有会话管线。
fn handle_msg(
    gateway: &std::sync::Arc<Gateway>,
    dedup: &mut MsgIdDedup,
    frame: &Value,
) {
    let result = (|| -> Result<Option<(String, String)>, String> {
        let q = frame.get("query").cloned().unwrap_or(Value::Null);
        let body = frame.get("body").and_then(Value::as_str).unwrap_or_default();
        let signature = str_of(&q, "msg_signature");
        let timestamp = str_of(&q, "timestamp");
        let nonce = str_of(&q, "nonce");
        let encrypt = parse_encrypt_from_xml(body).ok_or("回调 XML 缺少 Encrypt")?;
        let Some(crypto) = current_crypto() else {
            return Err("crypto 未就绪".into());
        };
        if !crypto.verify_signature(&signature, &timestamp, &nonce, &encrypt) {
            return Err("签名校验失败".into());
        }
        let plain = crypto.decrypt(&encrypt)?;
        let msg = parse_plain_message(&plain);
        if msg.msg_type != "text" {
            return Ok(None); // v1 只处理文本
        }
        if !dedup.push(&msg.msg_id) {
            return Ok(None); // 重推
        }
        let allowed = {
            let allow = gateway
                .wecom_allow_users
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match allow.as_ref() {
                Some(list) => list.iter().any(|u| u == &msg.from),
                None => true, // 空白名单 = 允许所有成员
            }
        };
        if !allowed {
            eprintln!("[im-gateway/wecom] 白名单外 userid={}，已忽略", msg.from);
            return Ok(None);
        }
        Ok(Some((msg.from, msg.content)))
    })();

    match result {
        Ok(Some((userid, content))) => {
            dispatch_inbound(
                std::sync::Arc::clone(gateway),
                UserKey::Wecom(userid),
                content,
            );
        }
        Ok(None) => {}
        Err(err) => eprintln!("[im-gateway/wecom] {err}"),
    }
}

fn str_of(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/* ========================================================================== */
/* WecomCrypto 与运行时共享                                                     */
/* ========================================================================== */

#[derive(Clone)]
pub struct WecomCrypto {
    callback_token: String,
    aes_key: [u8; 32],
    receive_id: String,
}

impl WecomCrypto {
    pub fn signature(&self, timestamp: &str, nonce: &str, encrypt: &str) -> String {
        wecom_signature(&self.callback_token, timestamp, nonce, encrypt)
    }

    pub fn verify_signature(&self, signature: &str, timestamp: &str, nonce: &str, encrypt: &str) -> bool {
        !signature.is_empty() && signature == self.signature(timestamp, nonce, encrypt)
    }

    pub fn decrypt(&self, encrypt_b64: &str) -> Result<String, String> {
        decrypt_message(&self.aes_key, encrypt_b64, &self.receive_id)
    }

    /// 验证阶段：echostr 本身就是密文，解出明文原样返回。
    pub fn decrypt_echostr(&self, echostr: &str) -> Result<String, String> {
        self.decrypt(echostr)
    }
}

static CURRENT_CRYPTO: Mutex<Option<WecomCrypto>> = Mutex::new(None);

fn current_crypto() -> Option<WecomCrypto> {
    CURRENT_CRYPTO
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
}

pub(super) fn store_crypto(crypto: Option<WecomCrypto>) {
    *CURRENT_CRYPTO.lock().unwrap_or_else(|e| e.into_inner()) = crypto;
}
