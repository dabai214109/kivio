//! Kivio Remote 纯函数集成测试。
//!
//! 与 tests/im_gateway.rs 同理：放 tests/ 以套用 Windows manifest 链接参数
//! （见 build.rs），被测函数以 pub 暴露在 remote_bridge 模块。

use kivio::remote_bridge::{conv_list_item, qr_svg, slim_messages, ws_url_from_server};
use serde_json::json;

#[test]
fn ws_url_converts_scheme() {
    assert_eq!(
        ws_url_from_server("https://relay.example.com"),
        "wss://relay.example.com"
    );
    assert_eq!(
        ws_url_from_server("http://192.168.1.5:8787/"),
        "ws://192.168.1.5:8787"
    );
    assert_eq!(ws_url_from_server("relay.example.com"), "wss://relay.example.com");
    assert_eq!(ws_url_from_server(""), "");
}

#[test]
fn slim_messages_keeps_roles_and_reasoning() {
    let input = vec![
        json!({"role":"system","content":"you are a helpful assistant"}),
        json!({"role":"user","content":"hi","attachments":[{"path":"a.png"}]}),
        json!({"role":"assistant","content":"hello","reasoning":"thinking...","attachments":[]}),
        json!({"role":"tool","content":"result"}),
    ];
    let out = slim_messages(&input);
    assert_eq!(out.len(), 2);
    assert_eq!(out[0]["role"], "user");
    assert_eq!(out[0]["content"], "hi");
    assert!(out[0].get("attachments").is_none());
    assert_eq!(out[1]["reasoning"], "thinking...");
    assert!(out[1].get("attachments").is_none());
}

#[test]
fn conv_list_item_exposes_minimal_fields() {
    let item = serde_json::from_str::<kivio_chat_types_stub::ConversationListItemStub>(
        r#"{
            "id": "c1",
            "title": "测试",
            "preview": "预览",
            "provider_id": "p",
            "model": "m",
            "message_count": 3,
            "created_at": 1,
            "updated_at": 2
        }"#,
    )
    .expect("stub parse");
    let value = conv_list_item(&item.into_inner());
    assert_eq!(value["id"], "c1");
    assert_eq!(value["title"], "测试");
    assert_eq!(value["preview"], "预览");
    assert_eq!(value["updated_at"], 2);
    assert_eq!(value["message_count"], 3);
    assert!(value.get("provider_id").is_none());
}

/// 避免在测试里直接依赖 crate::chat::types（结构体字段多、后续可能演进）：
/// 这里用一个「序列化再反序列化」的同构替身走 JSON 边界。
mod kivio_chat_types_stub {
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct ConversationListItemStub {
        pub id: String,
        pub title: String,
        pub preview: String,
        pub updated_at: i64,
        pub message_count: usize,
    }

    impl ConversationListItemStub {
        pub fn into_inner(self) -> kivio::chat::types::ConversationListItem {
            serde_json::from_str(
                &serde_json::json!({
                    "id": self.id,
                    "title": self.title,
                    "preview": self.preview,
                    "provider_id": "p",
                    "model": "m",
                    "message_count": self.message_count,
                    "created_at": 1i64,
                    "updated_at": self.updated_at,
                })
                .to_string(),
            )
            .expect("stub -> real")
        }
    }
}

#[test]
fn qr_svg_renders_matrix() {
    let svg = qr_svg("https://relay.example.com/?code=AB23CD45").expect("qr svg");
    assert!(svg.starts_with("<svg"));
    assert!(svg.contains("viewBox=\"0 0 "));
    // 矩阵里必然有暗模块
    assert!(svg.contains("<path d=\"M"));
    // M 坐标带 4 模块留白
    assert!(svg.contains("M4,4") || svg.contains("M4,"));
}
