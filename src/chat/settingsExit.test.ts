import { describe, expect, it, vi } from 'vitest'
import { completeSettingsExit, type PendingSettingsAction } from './settingsExit'

describe('completeSettingsExit', () => {
  it('does not restore the old conversation route before a queued conversation navigation', () => {
    const routes: Array<string | null> = []
    const syncConversationRoute = vi.fn((id: string | null) => routes.push(id))
    const pending: PendingSettingsAction = {
      restoreCurrentRoute: false,
      action: () => syncConversationRoute('target-conversation'),
    }

    completeSettingsExit('old-conversation', pending, syncConversationRoute)

    expect(routes).toEqual(['target-conversation'])
  })

  it('restores the current conversation route for actions that do not navigate', () => {
    const syncConversationRoute = vi.fn()
    const action = vi.fn()

    completeSettingsExit('current-conversation', { action, restoreCurrentRoute: true }, syncConversationRoute)

    expect(syncConversationRoute).toHaveBeenCalledWith('current-conversation')
    expect(action).toHaveBeenCalledOnce()
  })
})
