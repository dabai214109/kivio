export interface SettingsCloseOptions {
  /** 普通关闭等待保存；导航离开时保存可在后台完成。 */
  waitForSave?: boolean
}

export function persistThenClose(
  persist: () => Promise<unknown>,
  onClose: () => void,
  options?: SettingsCloseOptions,
): void {
  const pending = persist()
  if (options?.waitForSave === false) {
    onClose()
    return
  }
  void pending.finally(onClose)
}
