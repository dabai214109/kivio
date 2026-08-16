import { MessageCircle } from 'lucide-react'
import type { ImGatewayConfig } from '../../api/tauri'
import type { Lang } from '../i18n'
import { Input, SettingsGroup, SettingRow, TextArea, Toggle } from '../components'

/**
 * IM 网关设置：QQ（NapCat / OneBot11 正向 WebSocket）↔ Kivio 会话。
 * 开关/地址/token 改动无需重启——后端监督循环每 2s 重读设置。
 */
export function ImGatewayTab({ lang, config, onChange }: {
  lang: Lang
  config: ImGatewayConfig
  onChange: (config: ImGatewayConfig) => void
}) {
  const zh = lang === 'zh'

  return (
    <>
      <SettingsGroup title={zh ? '启用' : 'Enable'}>
        <SettingRow
          label={zh ? 'IM 网关' : 'IM Gateway'}
          description={zh
            ? '开启后，白名单内的 QQ 好友私聊机器人，消息会进入 Kivio 会话执行，结果自动回发到 QQ。需要本机运行 NapCat 并开启 OneBot11 正向 WebSocket。'
            : 'Whitelisted QQ friends chat with the bot; messages run in Kivio conversations and results are sent back over QQ. Requires NapCat with an OneBot11 forward WebSocket on this machine.'}
        >
          <Toggle checked={config.enabled} onChange={(enabled) => onChange({ ...config, enabled })} />
        </SettingRow>
      </SettingsGroup>

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
  )
}
