//! IM 网关纯函数集成测试。
//!
//! 放在 tests/（而不是 src 内嵌 #[cfg(test)]）的原因：lib 单测二进制在 Windows 上
//! 因缺少 Common Controls v6 manifest 无法启动（0xC0000139，见 build.rs），而
//! `cargo:rustc-link-arg-tests` 只作用于 tests/ 目标——所以网关的可测函数都以 pub
//! 暴露、测试集中在这里，Windows/macOS 都能跑。

use kivio::im_gateway::{last_assistant_content, onebot_message_to_text, split_reply, urlencoding_minimal};
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
