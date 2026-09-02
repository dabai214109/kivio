//! IM 网关纯函数集成测试。
//!
//! 放在 tests/（而不是 src 内嵌 #[cfg(test)]）的原因：lib 单测二进制在 Windows 上
//! 因缺少 Common Controls v6 manifest 无法启动（0xC0000139，见 build.rs），而
//! `cargo:rustc-link-arg-tests` 只作用于 tests/ 目标——所以网关的可测函数都以 pub
//! 暴露、测试集中在这里，Windows/macOS 都能跑。

use kivio::im_gateway::{
    last_assistant_content, onebot_message_to_text, split_reply, urlencoding_minimal,
};
use kivio::im_gateway::qq_official::{
    clamp_passive_chunks, parse_c2c_event, token_refresh_after, MsgIdDedup, INTENT_GROUP_AND_C2C,
};
use serde_json::json;

#[test]
fn parses_segment_array_message() {
    let message = json!([
        { "type": "text", "data": { "text": "你好 " } },
        { "type": "at", "data": { "qq": 10001 } },
        { "type": "text", "data": { "text": " 帮看看" } },
        { "type": "image", "data": { "file": "a.jpg" } },
    ]);
    assert_eq!(onebot_message_to_text(&message), "你好 @10001 帮看看");
}

#[test]
fn parses_string_message_and_strips_cq() {
    let message = json!("[CQ:at,qq=10001] 帮我看看 [CQ:image,file=abc.jpg] 这个报错");
    assert_eq!(onebot_message_to_text(&message), "帮我看看  这个报错");
}

#[test]
fn ignores_non_text_shapes() {
    assert_eq!(onebot_message_to_text(&serde_json::Value::Null), "");
    assert_eq!(onebot_message_to_text(&json!(42)), "");
}

#[test]
fn splits_long_reply_with_index() {
    // split_reply 内部把 limit 下限钳到 50，用 120 字/50 上限验证三分块。
    let text = "x".repeat(120);
    let chunks = split_reply(&text, 50);
    assert_eq!(chunks.len(), 3);
    assert!(chunks[0].starts_with("（1/3）\n"));
    let joined: String = chunks
        .iter()
        .map(|c| c.split_once('\n').map(|(_, rest)| rest).unwrap_or(c))
        .collect();
    assert_eq!(joined, text);
}

#[test]
fn short_reply_is_single_chunk() {
    let chunks = split_reply("hello", 40);
    assert_eq!(chunks, vec!["hello".to_string()]);
}

#[test]
fn urlencodes_reserved_chars() {
    assert_eq!(urlencoding_minimal("a b/c+d"), "a%20b%2Fc%2Bd");
    assert_eq!(urlencoding_minimal("plain-1_2.3~4"), "plain-1_2.3~4");
}

#[test]
fn extracts_last_assistant_content() {
    let messages = vec![
        json!({ "role": "user", "content": "hi" }),
        json!({ "role": "assistant", "content": "first" }),
        json!({ "role": "assistant", "content": "second" }),
    ];
    assert_eq!(last_assistant_content(&messages), Some("second".to_string()));
}

/* ---------------- QQ 官方机器人 ---------------- */

#[test]
fn intent_bit_value() {
    // 单聊+群事件位（官方文档 GROUP_AND_C2C_EVENT = 1<<25）。
    assert_eq!(INTENT_GROUP_AND_C2C, 1 << 25);
    assert_eq!(INTENT_GROUP_AND_C2C, 33_554_432);
}

#[test]
fn parses_c2c_event_fields() {
    let d = json!({
        "id": "msg-001",
        "content": " 你好 Kivio ",
        "author": { "user_openid": "openid-abc", "id": "openid-abc" },
        "timestamp": "2026-08-17T12:00:00+08:00",
    });
    let inbound = parse_c2c_event(&d).expect("应解析成功");
    assert_eq!(inbound.msg_id, "msg-001");
    assert_eq!(inbound.openid, "openid-abc");
    assert_eq!(inbound.content, "你好 Kivio");
}

#[test]
fn parses_c2c_event_author_id_fallback() {
    let d = json!({ "id": "m2", "content": "hi", "author": { "id": "openid-xyz" } });
    let inbound = parse_c2c_event(&d).expect("author.id 兜底应生效");
    assert_eq!(inbound.openid, "openid-xyz");
}

#[test]
fn rejects_empty_content_or_missing_fields() {
    assert!(parse_c2c_event(&json!({ "id": "m3", "content": "   ", "author": { "user_openid": "o" } })).is_none());
    assert!(parse_c2c_event(&json!({ "content": "hi", "author": { "user_openid": "o" } })).is_none());
    assert!(parse_c2c_event(&json!({ "id": "m4", "content": "hi" })).is_none());
}

#[test]
fn clamps_chunks_into_passive_budget() {
    let chunks = vec!["a".to_string(), "b".to_string(), "c".to_string(), "d".to_string(), "e".to_string()];
    let out = clamp_passive_chunks(chunks, 4);
    assert_eq!(out.len(), 4);
    assert_eq!(out[3], "d\ne");
    // 不超限原样返回。
    let keep = clamp_passive_chunks(vec!["x".to_string(), "y".to_string()], 4);
    assert_eq!(keep, vec!["x".to_string(), "y".to_string()]);
    // max=1 时全部并成一段。
    let one = clamp_passive_chunks(vec!["a".into(), "b".into(), "c".into()], 1);
    assert_eq!(one, vec!["a\nb\nc".to_string()]);
}

#[test]
fn dedups_repeated_msg_ids() {
    let mut dedup = MsgIdDedup::new(16);
    assert!(dedup.push("m1"));
    assert!(!dedup.push("m1"), "重复推送应被去重");
    assert!(dedup.push("m2"));
    // 容量环形淘汰（实现把下限钳到 16）：挤满后最老的 id 被遗忘、再次出现视为新。
    let mut tiny = MsgIdDedup::new(1);
    for i in 0..17 {
        assert!(tiny.push(&format!("id-{i}")), "互不相同的 id 都应是首次");
    }
    assert!(tiny.push("id-0"), "超出容量后最老的 id 被淘汰，再次出现视为新");
    assert!(!tiny.push("id-16"), "仍在窗口内的重复 id 应被去重");
}

#[test]
fn token_refresh_leads_expiry_by_60s() {
    assert_eq!(token_refresh_after(7200).as_secs(), 7140);
    assert_eq!(token_refresh_after(120).as_secs(), 60);
    assert_eq!(token_refresh_after(10).as_secs(), 60, "过短的 expires_in 也保底 60s");
}

/* ========================================================================== */
/* 企业微信（wecom.rs）                                                        */
/* ========================================================================== */

use kivio::im_gateway::wecom::{
    aes_key_from_encoding_key, decrypt_message, parse_encrypt_from_xml, parse_plain_message,
    wecom_signature, MsgIdDedup as WecomMsgIdDedup, WECOM_MAX_TEXT_CHARS,
};

const TEST_ENCODING_KEY: &str = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";

fn test_aes_key() -> [u8; 32] {
    aes_key_from_encoding_key(TEST_ENCODING_KEY).expect("valid key")
}

/// 用与官方相同的构造方式生成密文（16B random + 4B len + msg + receiveid，PKCS7）。
fn encrypt_like_wecom(aes_key: &[u8; 32], msg: &str, receive_id: &str) -> String {
    use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
    use base64::Engine;

    let payload_len = msg.len() + receive_id.len();
    let mut buf = Vec::with_capacity(16 + 4 + payload_len + 16);
    buf.extend_from_slice(&[0u8; 16]); // random
    buf.extend_from_slice(&(msg.len() as u32).to_be_bytes());
    buf.extend_from_slice(msg.as_bytes());
    buf.extend_from_slice(receive_id.as_bytes());
    // PKCS7 padding
    let pad = 16 - (buf.len() % 16);
    buf.extend(std::iter::repeat(pad as u8).take(pad));

    let cipher = aes::Aes256::new(GenericArray::from_slice(aes_key));
    let mut prev = [7u8; 16]; // 测试用固定 IV
    for block in buf.chunks_exact_mut(16) {
        for (b, p) in block.iter_mut().zip(prev.iter()) {
            *b ^= p;
        }
        cipher.encrypt_block(GenericArray::from_mut_slice(block));
        prev.copy_from_slice(block);
    }
    base64::engine::general_purpose::STANDARD.encode(&buf)
}

#[test]
fn wecom_aes_key_requires_43_chars() {
    assert!(aes_key_from_encoding_key(TEST_ENCODING_KEY).is_ok());
    assert!(aes_key_from_encoding_key("short").is_err());
    assert!(aes_key_from_encoding_key(&"a".repeat(42)).is_err());
    assert!(aes_key_from_encoding_key(&"a".repeat(44)).is_err());
}

#[test]
fn wecom_signature_is_lexicographic_and_matches_vector() {
    // token=1, ts=2, nonce=3, encrypt=4 → sort → "1234" → sha1("1234")
    assert_eq!(
        wecom_signature("1", "2", "3", "4"),
        "7110eda4d09e062aa5e4a390b0a572ac0d2c0220"
    );
    // 传参顺序无关（内部按字典序排序）。
    assert_eq!(
        wecom_signature("4", "3", "2", "1"),
        wecom_signature("1", "2", "3", "4")
    );
    assert_eq!(wecom_signature("1", "2", "3", "4").len(), 40);
}

#[test]
fn wecom_decrypt_roundtrip() {
    let key = test_aes_key();
    let cipher = encrypt_like_wecom(&key, "<xml><Content><![CDATA[你好]]></Content></xml>", "ww_corp_id");
    let plain = decrypt_message(&key, &cipher, "ww_corp_id").expect("decrypt ok");
    assert!(plain.contains("你好"));

    // receiveid 不匹配 → 报错
    assert!(decrypt_message(&key, &cipher, "other_corp").is_err());
    // 非法 base64 → 报错
    assert!(decrypt_message(&key, "!!!not-base64!!!", "ww_corp_id").is_err());
    // 空串 → 报错
    assert!(decrypt_message(&key, "", "ww_corp_id").is_err());
}

#[test]
fn wecom_xml_helpers() {
    let callback = r#"<xml><ToUserName><![CDATA[ww_corp]]></ToUserName><Encrypt><![CDATA[ABC123xyz==]]></Encrypt><AgentID><![CDATA[1000002]]></AgentID></xml>"#;
    assert_eq!(parse_encrypt_from_xml(callback).as_deref(), Some("ABC123xyz=="));
    assert_eq!(parse_encrypt_from_xml("<xml><NoEncrypt/></xml>"), None);

    let plain = r#"<xml><ToUserName><![CDATA[ww_corp]]></ToUserName><FromUserName><![CDATA[userid_zhang]]></FromUserName><CreateTime>1756000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[帮我看看这个报错]]></Content><MsgId>7064511234567890123</MsgId><AgentID><![CDATA[1000002]]></AgentID></xml>"#;
    let msg = parse_plain_message(plain);
    assert_eq!(msg.from, "userid_zhang");
    assert_eq!(msg.content, "帮我看看这个报错");
    assert_eq!(msg.msg_type, "text");
    assert_eq!(msg.msg_id, "7064511234567890123");

    // 无 CDATA 的纯文本节点
    assert_eq!(
        parse_plain_message("<xml><MsgType>event</MsgType></xml>").msg_type,
        "event"
    );
}

#[test]
fn wecom_dedup_ignores_pushed_duplicates() {
    let mut dedup = WecomMsgIdDedup::new(512);
    assert!(dedup.push("7064511234567890123"));
    assert!(!dedup.push("7064511234567890123"), "企微重推的相同 MsgId 应去重");
    assert!(dedup.push("7064511234567890124"));
    assert!(dedup.push(""), "空 MsgId（部分事件）不参与去重");
}

#[test]
fn wecom_split_limit_is_conservative() {
    // 企微 text 上限 2048 字节：600 汉字 ≈ 1800 字节，必须低于上限。
    assert!(WECOM_MAX_TEXT_CHARS * 3 < 2048);
}
