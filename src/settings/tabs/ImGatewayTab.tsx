import { useEffect, useRef, useState } from 'react'
import { MessageCircle } from 'lucide-react'
import type { ImGatewayConfig, ImGatewayStatusInfo, RemotePairingStatus } from '../../api/tauri'
import { api } from '../../api/tauri'
import type { Lang } from '../i18n'
import { Input, Select, SettingsGroup, SettingRow, TextArea, Toggle } from '../components'

/**
 * IM 网关设置：IM 私聊 ↔ Kivio 会话。通道构成：
 * - QQ 侧（provider 二选一）：QQ 官方机器人（q.qq.com，WebSocket）/ OneBot11（NapCat）；
 * - 企业微信自建应用（独立开关，可与 QQ 同时启用）：回调 → 自建中继 → 桌面端。
 * 改动无需重启——后端监督循环按设置热生效。
 */
export function ImGatewayTab({ lang, config, onChange }: {
  lang: Lang
  config: ImGatewayConfig
  onChange: (config: ImGatewayConfig) => void
}) {
  const zh = lang === 'zh'
  const official = config.provider === 'qq_official'
  const wecom = config.wecom

  const [wecomPairing, setWecomPairing] = useState(false)
  const [wecomPairError, setWecomPairError] = useState('')
  const [gatewayStatus, setGatewayStatus] = useState<ImGatewayStatusInfo | null>(null)
  const pollRef = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const s = await api.imGatewayStatus()
        if (alive) setGatewayStatus(s)
      } catch { /* 旧版本无此命令时静默 */ }
    }
    tick()
    const id = window.setInterval(tick, 3000)
    return () => { alive = false; window.clearInterval(id) }
  }, [])

  useEffect(() => {
    if (!wecomPairing) return
    let alive = true
    const poll = async () => {
      try {
        const s: RemotePairingStatus = await api.remoteBridgePairingStatus()
        if (!alive) return
        if (s.status === 'paired' && s.device_token) {
          setWecomPairing(false)
          setWecomPairError('')
          onChange({ ...config, wecom: { ...wecom, relayToken: s.device_token } })
        } else if (s.status === 'failed') {
          setWecomPairing(false)
          setWecomPairError(s.error || (zh ? '配对失败' : 'Pairing failed'))
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
  }, [wecomPairing])

  const startWecomPairing = async () => {
    const relayUrl = wecom.relayUrl.trim()
    if (!relayUrl) {
      setWecomPairError(zh ? '请先填写中继服务器地址' : 'Enter the relay server URL first')
      return
    }
    setWecomPairError('')
    try {
      await api.remoteBridgeStartPairing(relayUrl)
      setWecomPairing(true)
    } catch (err) {
      setWecomPairError(String(err))
    }
  }

  const updateWecom = (wecom: ImGatewayConfig['wecom']) => onChange({ ...config, wecom })

  return (
    <>
      <SettingsGroup title={zh ? '启用' : 'Enable'}>
        <SettingRow
          label={zh ? 'IM 网关（QQ）' : 'IM Gateway (QQ)'}
          description={zh
            ? '开启后，白名单内的 IM 用户私聊机器人，消息会进入 Kivio 会话执行，结果自动回发。'
            : 'Whitelisted IM users chat with the bot; messages run in Kivio conversations and results are sent back.'}
        >
          <Toggle checked={config.enabled} onChange={(enabled) => onChange({ ...config, enabled })} />
        </SettingRow>
        {gatewayStatus && (
          <SettingRow
            label={zh ? 'QQ 通道状态' : 'QQ channel'}
            description={
              connectedLabel(zh, gatewayStatus.connected) +
              (config.enabled ? '' : zh ? '（QQ 通道未启用）' : ' (QQ disabled)')
            }
          >
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${gatewayStatus.connected ? 'bg-emerald-500' : config.enabled ? 'bg-amber-500' : 'bg-neutral-400'}`} />
          </SettingRow>
        )}
      </SettingsGroup>

      <SettingsGroup title={zh ? '接入方式' : 'Provider'}>
        <SettingRow
          label={zh ? '机器人类型' : 'Bot type'}
          description={zh
            ? 'QQ 官方机器人：开放平台注册的机器人（WebSocket 接入，无需本机程序）。OneBot11：本机 NapCat/Lagrange 挂普通 QQ 号。'
            : 'QQ Official: bot registered on the open platform (WebSocket, no local program). OneBot11: NapCat/Lagrange with a normal QQ account.'}
        >
          <Select
            value={config.provider}
            onChange={(provider) => onChange({ ...config, provider })}
            options={[
              { value: 'qq_official', label: zh ? 'QQ 官方机器人' : 'QQ Official Bot' },
              { value: 'onebot', label: zh ? 'OneBot11（NapCat）' : 'OneBot11 (NapCat)' },
            ]}
            className="w-[220px]"
          />
        </SettingRow>
      </SettingsGroup>

      {official ? (
        <>
          <SettingsGroup title={zh ? 'QQ 官方机器人凭据' : 'QQ Official credentials'}>
            <SettingRow
              label="AppID"
              description={zh ? '开放平台「开发设置」页的 AppID。' : 'AppID from the platform dev settings page.'}
              stack
            >
              <Input
                value={config.qqOfficial.appId}
                onChange={(appId) => onChange({ ...config, qqOfficial: { ...config.qqOfficial, appId } })}
                placeholder="102000000"
                mono
              />
            </SettingRow>
            <SettingRow
              label={zh ? 'ClientSecret（AppSecret）' : 'ClientSecret (AppSecret)'}
              description={zh
                ? '开放平台「开发设置」页的 ClientSecret；与获取 access_token 用的是同一对凭据。'
                : 'ClientSecret from the dev settings page; the same pair used to obtain access_token.'}
              stack
            >
              <Input
                value={config.qqOfficial.clientSecret}
                onChange={(clientSecret) => onChange({ ...config, qqOfficial: { ...config.qqOfficial, clientSecret } })}
                placeholder=""
                mono
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title={zh ? '白名单' : 'Whitelist'}>
            <SettingRow
              label={zh ? '允许的用户 OpenID' : 'Allowed user OpenIDs'}
              description={zh
                ? '官方机器人模式下留空 = 允许所有私聊用户（机器人私有，对方需先加好友）。要收紧时填 OpenID：每行一个；未命中的 OpenID 会打印到应用日志，可回填到这里。'
                : 'Empty = allow all direct-chat users for the official bot (it is private — contacts must add it first). To restrict, fill OpenIDs one per line; unmatched OpenIDs are logged for copy-back.'}
              stack
            >
              <TextArea
                value={config.allowUsers.join('\n')}
                onChange={(raw) => onChange({
                  ...config,
                  allowUsers: raw.split('\n').map((line) => line.trim()).filter(Boolean),
                })}
                placeholder="openid..."
                rows={4}
                mono
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title={zh ? '说明' : 'Notes'}>
            <div className="flex items-start gap-2.5 px-1 py-2">
              <MessageCircle size={15} className="mt-0.5 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
              <p className="kv-row-desc max-w-[560px]">
                {zh
                  ? '沙箱：未发布上线的机器人处于沙箱状态，需在开放平台「沙箱配置」添加你的 QQ 为测试用户，并在手机 QQ 搜索添加机器人为好友后才能单聊。平台限制：被动回复在收到消息 60 分钟内、每条消息最多 4 条（长回复会自动合并分段，且不发送"已提交"回执）。'
                  : 'Sandbox: an unpublished bot is sandboxed — add your QQ as a sandbox test user on the platform, then add the bot as a contact to chat. Platform limits: passive replies within 60 min, max 4 per received message (long replies merge segments; no "submitted" ack).'}
              </p>
            </div>
          </SettingsGroup>
        </>
      ) : (
        <>
          <SettingsGroup title={zh ? '连接' : 'Connection'}>
            <SettingRow
              label={zh ? 'WebSocket 地址' : 'WebSocket URL'}
              description={zh ? 'NapCat 的 OneBot11 正向 WS 服务端地址。' : 'NapCat OneBot11 forward WebSocket endpoint.'}
              stack
            >
              <Input
                value={config.wsUrl}
                onChange={(wsUrl) => onChange({ ...config, wsUrl })}
                placeholder="ws://127.0.0.1:3001"
                mono
              />
            </SettingRow>
            <SettingRow
              label="Access Token"
              description={zh
                ? '与 NapCat 网络配置一致；未设置鉴权则留空。'
                : 'Must match the NapCat network config; leave empty when unused.'}
              stack
            >
              <Input
                value={config.accessToken}
                onChange={(accessToken) => onChange({ ...config, accessToken })}
                placeholder=""
                mono
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title={zh ? '白名单' : 'Whitelist'}>
            <SettingRow
              label={zh ? '允许的 QQ 号' : 'Allowed QQ numbers'}
              description={zh
                ? '每行一个 QQ 号（你自己的 QQ，不是机器人的）。白名单外的私聊会被静默忽略；为空时忽略所有私聊。'
                : 'One QQ number per line (yours, not the bot account). Private messages outside this list are dropped; empty drops all.'}
              stack
            >
              <TextArea
                value={config.allowUsers.join('\n')}
                onChange={(raw) => onChange({
                  ...config,
                  allowUsers: raw.split('\n').map((line) => line.trim()).filter(Boolean),
                })}
                placeholder={'123456789\n987654321'}
                rows={4}
                mono
              />
            </SettingRow>
          </SettingsGroup>

          <SettingsGroup title={zh ? '说明' : 'Notes'}>
            <div className="flex items-start gap-2.5 px-1 py-2">
              <MessageCircle size={15} className="mt-0.5 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
              <p className="kv-row-desc max-w-[560px]">
                {zh
                  ? '机器人侧只做无状态转发：每个 QQ 号固定映射一个 Kivio 会话（/new 新建），历史与上下文都在 Kivio 里。注意：当「权限」策略不是「完全访问」时，网关触发的工具审批会在 60 秒超时后被自动拒绝——建议配合完全访问策略使用。'
                  : 'The bot side is a stateless bridge: each QQ number maps to one Kivio conversation (/new starts another); history lives in Kivio. Note: unless the permission policy is "Full access", tool approvals triggered headlessly are auto-denied after a 60s timeout.'}
              </p>
            </div>
          </SettingsGroup>
        </>
      )}

      {/* ===== 企业微信（独立通道，可与 QQ 同时启用） ===== */}
      <SettingsGroup title={zh ? '企业微信（WeCom 自建应用）' : 'WeCom (self-built app)'}>
        <SettingRow
          label={zh ? '启用企业微信' : 'Enable WeCom'}
          description={zh
            ? '与 QQ 通道互相独立、可同时开启。微信里通过「微工作台」与 Kivio 对话。'
            : 'Independent of the QQ channel; both can run at once. Chat with Kivio via the WeCom micro-workbench inside WeChat.'}
        >
          <Toggle checked={wecom.enabled} onChange={(enabled) => updateWecom({ ...wecom, enabled })} />
        </SettingRow>
        {gatewayStatus && config.wecom.enabled && (
          <SettingRow
            label={zh ? '企微通道状态' : 'WeCom channel'}
            description={connectedLabel(zh, gatewayStatus.wecomConnected ?? false)}
          >
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${gatewayStatus.wecomConnected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          </SettingRow>
        )}
        <SettingRow
          label={zh ? '中继服务器地址' : 'Relay server URL'}
          description={zh
            ? '你的自建中继（remote-bridge），需已更新到含 /wecom/callback 的版本。企微凭据只保存在本机，中继仅透传密文。'
            : 'Your self-hosted relay (remote-bridge), updated to a build with /wecom/callback. WeCom credentials stay local; the relay only forwards ciphertext.'}
          stack
        >
          <Input
            value={wecom.relayUrl}
            onChange={(relayUrl) => updateWecom({ ...wecom, relayUrl })}
            placeholder="https://relay.example.com"
            mono
          />
        </SettingRow>
        <SettingRow
          label={zh ? '中继凭据' : 'Relay credentials'}
          description={zh
            ? wecom.relayToken
              ? '已连接过中继（凭据已保存）。更换中继或重置 data.json 后需重新连接。'
              : '点击「连接中继」自动获取（无需手机扫码）。'
            : wecom.relayToken
              ? 'Saved from a previous pairing. Re-pair after switching relays or resetting data.json.'
              : 'Click "Connect relay" to obtain automatically (no phone scan needed).'}
          stack
        >
          {wecomPairing ? (
            <button
              type="button"
              onClick={async () => { try { await api.remoteBridgeCancelPairing() } catch { /* ignore */ } setWecomPairing(false) }}
              className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
            >
              {zh ? '取消' : 'Cancel'}
            </button>
          ) : (
            <button
              type="button"
              onClick={startWecomPairing}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
            >
              {zh ? '连接中继' : 'Connect relay'}
            </button>
          )}
        </SettingRow>
        {wecomPairError && (
          <p className="kv-row-desc px-1 text-red-500">{wecomPairError}</p>
        )}
        <SettingRow
          label="CorpID"
          description={zh ? '企业微信管理后台「我的企业 → 企业信息」的 企业ID。' : 'CorpID from the admin console (My Company → Company Info).'}
          stack
        >
          <Input value={wecom.corpId} onChange={(corpId) => updateWecom({ ...wecom, corpId })} placeholder="ww…" mono />
        </SettingRow>
        <SettingRow
          label={zh ? '应用 Secret' : 'App Secret'}
          description={zh ? '自建应用详情页的 Secret。' : 'Secret from the self-built app detail page.'}
          stack
        >
          <Input value={wecom.corpSecret} onChange={(corpSecret) => updateWecom({ ...wecom, corpSecret })} mono />
        </SettingRow>
        <SettingRow
          label="AgentId"
          description={zh ? '自建应用详情页的 AgentId（纯数字）。' : 'Numeric AgentId from the app detail page.'}
          stack
        >
          <Input
            value={wecom.agentId ? String(wecom.agentId) : ''}
            onChange={(raw) => updateWecom({ ...wecom, agentId: Number.parseInt(raw, 10) || 0 })}
            placeholder="1000002"
            mono
          />
        </SettingRow>
        <SettingRow
          label={zh ? '回调 Token' : 'Callback Token'}
          description={zh ? '企微后台「接收消息 → 设置API接收」页生成的 Token。' : 'Token generated in the admin console (Receive Messages → API).'}
          stack
        >
          <Input value={wecom.callbackToken} onChange={(callbackToken) => updateWecom({ ...wecom, callbackToken })} mono />
        </SettingRow>
        <SettingRow
          label="EncodingAESKey"
          description={zh ? '同一页生成的 EncodingAESKey（43 字符）。' : 'EncodingAESKey from the same page (43 chars).'}
          stack
        >
          <Input value={wecom.encodingAesKey} onChange={(encodingAesKey) => updateWecom({ ...wecom, encodingAesKey })} mono />
        </SettingRow>
        <SettingRow
          label={zh ? '允许的成员 UserID' : 'Allowed member UserIDs'}
          description={zh
            ? '留空 = 允许应用可见范围内所有成员。收到的成员 UserID 会打印到应用日志，可回填到这里。'
            : 'Empty = allow all members in the app scope. Received UserIDs are logged for copy-back.'}
          stack
        >
          <TextArea
            value={wecom.allowUsers.join('\n')}
            onChange={(raw) => updateWecom({
              ...wecom,
              allowUsers: raw.split('\n').map((line) => line.trim()).filter(Boolean),
            })}
            placeholder="userid..."
            rows={3}
            mono
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title={zh ? '企业微信说明' : 'WeCom notes'}>
        <div className="flex items-start gap-2.5 px-1 py-2">
          <MessageCircle size={15} className="mt-0.5 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
          <p className="kv-row-desc max-w-[560px]">
            {zh
              ? `配置顺序：注册企业微信并创建自建应用 → 填上方凭据 → 点「连接中继」→ 把企微后台「接收消息」的 URL 设为 ${'https://你的中继'}/wecom/callback?t=<中继凭据>（Token/AESKey 与上方一致）。应用消息无 4 条/60 分钟限制；长回复按 ~600 字自动分段。微信端使用「微工作台」收发。`
              : 'Setup: register WeCom and create a self-built app → fill credentials above → click "Connect relay" → set the callback URL to https://your-relay/wecom/callback?t=<token> (Token/AESKey must match). No 4-message/60-min passive limits; long replies split at ~600 chars. Use the WeCom micro-workbench inside WeChat.'}
          </p>
        </div>
      </SettingsGroup>
    </>
  )
}

function connectedLabel(zh: boolean, connected: boolean): string {
  return zh
    ? (connected ? '已连接' : '未连接')
    : (connected ? 'connected' : 'disconnected')
}
