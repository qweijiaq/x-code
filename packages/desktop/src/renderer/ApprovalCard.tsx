import { useTranslation } from 'react-i18next'

import type { ApprovalRequestEvent } from '../shared/protocol.js'
import { isImeEnter, isImeEvent } from './ime.js'

export type ApprovalDecision = 'yes' | 'always' | 'no' | boolean | string

interface ApprovalCardProps {
  approval: ApprovalRequestEvent
  queueCount: number
  backgroundRunning: boolean
  questionDraft: string
  onQuestionDraft(value: string): void
  onRespond(request: ApprovalRequestEvent, decision: ApprovalDecision): void
}

export function ApprovalCard({
  approval,
  queueCount,
  backgroundRunning,
  questionDraft,
  onQuestionDraft,
  onRespond,
}: ApprovalCardProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="modal-scrim">
      <div className="approval-card" data-testid="approval-modal">
        <div className="approval-head">
          <span className="drawer-seal" aria-hidden="true">
            {approval.kind === 'plan' ? '策' : approval.kind === 'question' ? '问' : '准'}
          </span>
          <div>
            <div className="approval-title">
              {approval.kind === 'plan'
                ? t('计划确认')
                : approval.kind === 'question'
                  ? t('需要你的选择')
                  : approval.kind === 'authority'
                    ? t('外部影响确认')
                    : t('权限请求')}
            </div>
            <div className="approval-sub">{approval.toolName ?? approval.kind}</div>
          </div>
        </div>

        {approval.kind === 'permission' ? (
          <>
            {approval.taint ? (
              <div className="approval-reason">
                {t('本轮读取过外部内容（{{sources}}），写操作需要重新确认。', {
                  sources: approval.taint.sources.join(', '),
                })}
              </div>
            ) : null}
            <pre className="approval-body">{JSON.stringify(approval.input ?? {}, null, 2)}</pre>
          </>
        ) : null}
        {approval.kind === 'authority' ? (
          <div className="approval-body text">
            <div>{approval.preview?.summary}</div>
            {approval.preview?.paths?.length ? (
              <div className="approval-paths">{approval.preview.paths.join('\n')}</div>
            ) : null}
            {approval.preview?.reason ? <div className="approval-reason">{approval.preview.reason}</div> : null}
          </div>
        ) : null}
        {queueCount > 1 ? (
          <div className="approval-reason">
            {t('还有 {{count}} 个请求在排队，处理完这个会继续。', { count: queueCount - 1 })}
          </div>
        ) : null}
        {backgroundRunning ? <div className="approval-reason">{t('该请求来自正在后台运行的会话。')}</div> : null}
        {approval.kind === 'question' ? <div className="approval-body text">{approval.question}</div> : null}
        {approval.kind === 'plan' ? <pre className="approval-body">{approval.planText ?? ''}</pre> : null}

        {approval.kind === 'question' ? (
          <div className="approval-answer">
            <input
              className="settings-input"
              data-testid="approval-answer-input"
              value={questionDraft}
              placeholder={t('选项都不合适？直接输入你的回答…')}
              onChange={(event) => onQuestionDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isImeEvent(event)) return
                if (event.key === 'Enter') {
                  if (isImeEnter(event)) return
                  event.preventDefault()
                  if (questionDraft.trim()) void onRespond(approval, questionDraft.trim())
                }
              }}
            />
            <button
              className="btn solid"
              data-testid="approval-answer-send"
              disabled={!questionDraft.trim()}
              onClick={() => void onRespond(approval, questionDraft.trim())}
            >
              {t('发送回答')}
            </button>
          </div>
        ) : null}

        <div className="approval-actions">
          {approval.kind === 'question' ? (
            <>
              <button className="btn" onClick={() => void onRespond(approval, '')}>
                {t('取消')}
              </button>
              {approval.options?.map((option) => (
                <button
                  key={option.label}
                  className="btn solid"
                  title={option.description}
                  onClick={() => void onRespond(approval, option.label)}
                >
                  {option.label}
                </button>
              ))}
            </>
          ) : approval.kind === 'plan' ? (
            <>
              <button className="btn" onClick={() => void onRespond(approval, false)}>
                {t('继续修改')}
              </button>
              <button className="btn solid" onClick={() => void onRespond(approval, true)}>
                {t('批准计划')}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => void onRespond(approval, 'no')}>
                {t('拒绝')}
              </button>
              {approval.kind === 'permission' ? (
                <button className="btn" onClick={() => void onRespond(approval, 'always')}>
                  {t('始终允许')}
                </button>
              ) : null}
              <button className="btn solid" onClick={() => void onRespond(approval, 'yes')}>
                {t('允许一次')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
