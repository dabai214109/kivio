export interface PendingSettingsAction {
  action: () => void
  /** 目标动作会自行写路由时，不要先恢复旧会话路由。 */
  restoreCurrentRoute: boolean
}

/** 设置页退场结束后恢复路由并执行用户排队的动作。 */
export function completeSettingsExit(
  currentConversationId: string | null,
  pending: PendingSettingsAction | null,
  syncConversationRoute: (conversationId: string | null) => void,
): void {
  if (!pending || pending.restoreCurrentRoute) {
    syncConversationRoute(currentConversationId)
  }
  pending?.action()
}
