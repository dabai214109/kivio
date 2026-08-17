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
