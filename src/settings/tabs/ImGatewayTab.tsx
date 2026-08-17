import { MessageCircle } from 'lucide-react'
import type { ImGatewayConfig } from '../../api/tauri'
import type { Lang } from '../i18n'
import { Input, Select, SettingsGroup, SettingRow, TextArea, Toggle } from '../components'

/**
 * IM 网关设置：IM 私聊 ↔ Kivio 会话。两种接入方式：
 * - QQ 官方机器人（q.qq.com 开放平台，WebSocket）：填 AppID/Secret，无需本机任何额外程序；
 * - OneBot11（本机 NapCat/Lagrange 正向 WebSocket）。
 * 改动无需重启——后端监督循环每 2s 重读设置。
 */
export function ImGatewayTab({ lang, config, onChange }: {
  lang: Lang
  config: ImGatewayConfig
  onChange: (config: ImGatewayConfig) => void
}) {
  const zh = lang === 'zh'
  const official = config.provider === 'qq_official'

  return (
    <>
      <SettingsGroup title={zh ? '启用' : 'Enable'}>
        <SettingRow
          label={zh ? 'IM 网关' : 'IM Gateway'}
          description={zh
            ? '开启后，白名单内的 IM 用户私聊机器人，消息会进入 Kivio 会话执行，结果自动回发。'
            : 'Whitelisted IM users chat with the bot; messages run in Kivio conversations and results are sent back.'}
        >
          <Toggle checked={config.enabled} onChange={(enabled) => onChange({ ...config, enabled })} />
        </SettingRow>
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
    </>
  )
}
