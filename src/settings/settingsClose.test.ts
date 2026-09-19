import { describe, expect, it, vi } from 'vitest'
import { persistThenClose } from './settingsClose'

describe('persistThenClose', () => {
  it('does not make conversation navigation wait for the settings save response', () => {
    const persist = vi.fn(() => new Promise<void>(() => {}))
    const onClose = vi.fn()

    persistThenClose(persist, onClose, { waitForSave: false })

    expect(persist).toHaveBeenCalledOnce()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('keeps ordinary settings close waiting for the save to settle', async () => {
    let resolveSave!: () => void
    const persist = vi.fn(() => new Promise<void>((resolve) => {
      resolveSave = resolve
    }))
    const onClose = vi.fn()

    persistThenClose(persist, onClose)
    expect(onClose).not.toHaveBeenCalled()

    resolveSave()
    await Promise.resolve()
    await Promise.resolve()
    expect(onClose).toHaveBeenCalledOnce()
  })
})
