// @x-code-cli/desktop — composer footer 的上下文/用量指示
//
// 从 App.tsx 的输入区底部拆出：沙箱提示、上下文占用条、累计 token/成本和
// 排队数量。全部数据来自 props，不读取 App 的 ref。
import { useTranslation } from 'react-i18next'

import type { UsageView } from '../shared/protocol.js'
import { formatContextTokens } from './transcript-model.js'

export interface UsageFooterProps {
  shellSandbox?: { supported: boolean; enabled: boolean; allowNetwork: boolean }
  contextPercent: number | null
  usedContextTokens: number
  contextWindow: number | null
  usage: UsageView | null
  queued: number
  onOpenToolsSettings: () => void | Promise<void>
}

export function UsageFooter({
  shellSandbox,
  contextPercent,
  usedContextTokens,
  contextWindow,
  usage,
  queued,
  onOpenToolsSettings,
}: UsageFooterProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      {shellSandbox?.supported && shellSandbox.enabled && !shellSandbox.allowNetwork ? (
        <button
          type="button"
          className="sandbox-hint"
          data-testid="sandbox-network-hint"
          title={t(
            'Agent 的 Shell 正在沙箱中运行，网络访问已关闭：npm install、git clone、curl 等联网命令会失败。点击调整。',
          )}
          onClick={() => void onOpenToolsSettings()}
        >
          {t('沙箱 · 网络关闭')}
        </button>
      ) : null}
      {contextPercent !== null ? (
        <span
          className={`context-meter ${contextPercent >= 85 ? 'danger' : contextPercent >= 65 ? 'warn' : ''}`}
          title={t('上下文 {{used}} / {{total}} tokens', {
            used: usedContextTokens,
            total: contextWindow ?? 0,
          })}
        >
          <span className="context-track">
            <span className="context-fill" style={{ width: `${contextPercent}%` }} />
          </span>
          <span className="context-numbers">
            {formatContextTokens(usedContextTokens)} / {formatContextTokens(contextWindow ?? 0)}
          </span>
          <span className="context-percent">{contextPercent}%</span>
        </span>
      ) : null}
      {usage ? (
        <span className="usage" title={t('累计 token 与估算成本（列表价，缓存输入未打折；未定价模型不计入）')}>
          ↑{usage.inputTokens} ↓{usage.outputTokens}
          {usage.costUsd !== undefined
            ? ` · $${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(2)}`
            : ''}
        </span>
      ) : null}
      {queued > 0 ? <span className="queued">{t('已排队 {{count}}', { count: queued })}</span> : null}
    </>
  )
}
