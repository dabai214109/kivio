// 占位测试目标。存在意义：让 build.rs 里的 `cargo:rustc-link-arg-tests` 指令合法
// （cargo 要求包至少有一个显式 test target），从而给所有测试二进制——包括 lib 单测——
// 嵌入 Common Controls v6 的 manifest 依赖。没有它，Windows 上 lib 测试进程会因
// comctl32 v5 缺少 TaskDialogIndirect 等入口点而在启动时以 0xC0000139 崩溃。

#[test]
fn manifest_link_placeholder() {
    // 无断言：本文件只为链接参数而存在。
}
