import { useEffect, useRef, useState } from 'react'
import { MonitorSmartphone, QrCode } from 'lucide-react'
import type { RemoteBridgeConfig, RemoteBridgeStatus, RemotePairingStatus } from '../../api/tauri'
import { api } from '../../api/tauri'
import type { Lang } from '../i18n'
import { Input, SettingsGroup, SettingRow, Toggle } from '../components'

/**
 * Kivio Remote（远程连接）：手机浏览器 ↔ 自建中继服务器 ↔ 桌面端。
 * 配对流程：填服务器地址 → 点「配对新设备」→ 桌面显示二维码/配对码 →
 * 手机浏览器打开 client_url → 双方拿到长效 token，之后自动重连。
 */
export function RemoteTab({ lang, config, onChange }: {
  lang: Lang
  config: RemoteBridgeConfig
  onChange: (config: RemoteBridgeConfig) => void
}) {
  const zh = lang === 'zh'
  const [pairing, setPairing] = useState(false)
  const [qrSvg, setQrSvg] = useState('')
  const [pairCode, setPairCode] = useState('')
  const [pairError, setPairError] = useState('')
  const [status, setStatus] = useState<RemoteBridgeStatus | null>(null)
  const pollRef = useRef<number | null>(null)

  // 轮询网关连接状态（2s）
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const s = await api.remoteBridgeStatus()
        if (alive) setStatus(s)
      } catch { /* 命令不存在（旧版本）时静默 */ }
    }
    tick()
    const id = window.setInterval(tick, 2000)
    return () => { alive = false; window.clearInterval(id) }
  }, [])

  // 配对进行中：轮询配对状态
  useEffect(() => {
    if (!pairing) return
    let alive = true
    const poll = async () => {
      try {
        const s: RemotePairingStatus = await api.remoteBridgePairingStatus()
        if (!alive) return
        if (s.status === 'paired' && s.device_token) {
          setPairing(false)
          setPairError('')
          onChange({ ...config, enabled: true, deviceToken: s.device_token })
        } else if (s.status === 'failed') {
          setPairing(false)
          setPairError(s.error || (zh ? '配对失败' : 'Pairing failed'))
        }
      } catch { /* ignore */ }
    }
    poll()
    pollRef.current = window.setInterval(poll, 1000)
    return () => {
      alive = false
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairing])

  const startPairing = async () => {
    const serverUrl = config.serverUrl.trim()
    if (!serverUrl) {
      setPairError(zh ? '请先填写中继服务器地址' : 'Enter the relay server URL first')
      return
    }
    setPairError('')
    try {
      const result = await api.remoteBridgeStartPairing(serverUrl)
      setQrSvg(result.qr_svg)
      setPairCode(result.code)
      setPairing(true)
    } catch (err) {
      setPairError(String(err))
    }
  }

  const cancelPairing = async () => {
    try { await api.remoteBridgeCancelPairing() } catch { /* ignore */ }
    setPairing(false)
  }

  const connected = status?.connected ?? false
  const tokenSet = Boolean(config.deviceToken)

  return (
    <>
      <SettingsGroup title={zh ? '启用' : 'Enable'}>
        <SettingRow
          label={zh ? '远程连接' : 'Remote access'}
          description={zh
            ? '开启后，配对过的手机浏览器可以远程查看会话、发消息、收回复。桌面端主动出站连接中继，无需公网 IP。'
            : 'Paired phone browsers can browse conversations, send messages and receive replies. The desktop dials out to the relay — no public IP needed.'}
        >
          <Toggle checked={config.enabled} onChange={(enabled) => onChange({ ...config, enabled })} />
        </SettingRow>
        <SettingRow
          label={zh ? '状态' : 'Status'}
          description={zh
            ? `中继：${status?.server_url || '未配置'}；连接：${connected ? '已连接' : '未连接'}；配对凭据：${tokenSet ? '已保存' : '未配对'}。`
            : `Relay: ${status?.server_url || 'not set'}; connection: ${connected ? 'connected' : 'disconnected'}; credentials: ${tokenSet ? 'saved' : 'not paired'}.`}
        >
          <span
            className={`inline-block h-2.5 w-2.5 rounded-full ${connected ? 'bg-emerald-500' : tokenSet && config.enabled ? 'bg-amber-500' : 'bg-neutral-400'}`}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={zh ? '中继服务器' : 'Relay server'}>
        <SettingRow
          label={zh ? '服务器地址' : 'Server URL'}
          description={zh
            ? '你部署的中继服务器，如 https://relay.example.com。中继只转发加密流量之外的 JSON 帧，不解析消息内容。'
            : 'Your deployed relay, e.g. https://relay.example.com. It only relays JSON frames and never inspects message content.'}
          stack
        >
          <Input
            value={config.serverUrl}
            onChange={(serverUrl) => onChange({ ...config, serverUrl })}
            placeholder="https://relay.example.com"
            mono
          />
        </SettingRow>
        <SettingRow
          label={zh ? '配对新设备' : 'Pair a device'}
          description={zh
            ? tokenSet
              ? '已有一台设备配对。再次配对会生成新凭据（旧凭据在服务器端失效需手动清理）。'
              : '生成一次性配对码，手机浏览器打开二维码里的链接完成绑定。'
            : tokenSet
              ? 'A device is already paired. Pairing again issues new credentials (the old ones must be cleaned on the server).'
              : 'Generate a one-time pairing code and open the QR link on your phone to bind.'}
          stack
        >
          {pairing ? (
            <button
              type="button"
              onClick={cancelPairing}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              {zh ? '取消配对' : 'Cancel pairing'}
            </button>
          ) : (
            <button
              type="button"
              onClick={startPairing}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              {zh ? '开始配对' : 'Start pairing'}
            </button>
          )}
        </SettingRow>
      </SettingsGroup>

      {pairing && qrSvg && (
        <SettingsGroup title={zh ? '扫码配对' : 'Scan to pair'}>
          <div className="flex flex-col items-center gap-3 px-1 py-3">
            <div
              className="overflow-hidden rounded-lg [&_svg]:block"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
            <p className="kv-row-desc text-center">
              {zh
                ? <>在手机浏览器打开链接，或输入配对码 <span className="font-mono font-semibold">{pairCode}</span></>
                : <>Open the link on your phone, or enter code <span className="font-mono font-semibold">{pairCode}</span></>}
            </p>
          </div>
        </SettingsGroup>
      )}

      {pairError && (
        <SettingsGroup title={zh ? '配对错误' : 'Pairing error'}>
          <div className="flex items-start gap-2.5 px-1 py-2">
            <QrCode size={15} className="mt-0.5 shrink-0 text-red-500" strokeWidth={1.8} />
            <p className="kv-row-desc max-w-[560px] text-red-500">{pairError}</p>
          </div>
        </SettingsGroup>
      )}

      <SettingsGroup title={zh ? '说明' : 'Notes'}>
        <div className="flex items-start gap-2.5 px-1 py-2">
          <MonitorSmartphone size={15} className="mt-0.5 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
          <p className="kv-row-desc max-w-[560px]">
            {zh
              ? '中继服务器部署见仓库 remote-bridge/ 目录（Node 单文件 + 手机网页，systemd/Docker 均可）。安全：请使用 HTTPS 反代（nginx/caddy）；配对码 10 分钟有效；所有流量走 TLS。注意：与 IM 网关相同，权限策略不是「完全访问」时，远程触发的工具审批会在 60 秒超时后自动拒绝。'
              : 'Deploy the relay from remote-bridge/ in the repo (single-file Node + mobile web page; systemd or Docker). Security: put it behind an HTTPS reverse proxy (nginx/caddy); pairing codes expire in 10 minutes; all traffic rides TLS. Note: like the IM gateway, tool approvals triggered remotely are auto-denied after 60s unless the permission policy is "Full access".'}
          </p>
        </div>
      </SettingsGroup>
    </>
  )
}
