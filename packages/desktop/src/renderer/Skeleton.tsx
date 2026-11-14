import { useTranslation } from 'react-i18next'

function Line({ width = '100%', height = 10 }: { width?: string; height?: number }): React.JSX.Element {
  return <span className="sk sk-line" style={{ width, height }} />
}

export function SidebarSkeleton({ rows = 4 }: { rows?: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="sk-sidebar" aria-label={t('加载中')} aria-busy="true">
      {Array.from({ length: rows }, (_value, index) => (
        <div className="sk-sidebar-row" key={index}>
          <Line width={`${52 + ((index * 17) % 34)}%`} />
          <Line width="34px" height={8} />
        </div>
      ))}
    </div>
  )
}

export function ChatSkeleton({ turns = 2 }: { turns?: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="sk-chat" aria-label={t('加载中')} aria-busy="true">
      {Array.from({ length: turns }, (_value, index) => (
        <div className="sk-turn" key={index}>
          <div className="sk-bubble sk-bubble-user">
            <Line width="72%" />
          </div>
          <div className="sk-answer">
            <Line width="96%" />
            <Line width="88%" />
            <Line width="64%" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function PanelSkeleton({ rows = 5 }: { rows?: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="sk-panel" aria-label={t('加载中')} aria-busy="true">
      {Array.from({ length: rows }, (_value, index) => (
        <div className="sk-panel-row" key={index}>
          <Line width="28%" height={12} />
          <Line width={`${44 + ((index * 11) % 40)}%`} height={8} />
        </div>
      ))}
    </div>
  )
}

export function SettingsSkeleton(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <div className="drawer-scrim" aria-hidden="true" />
      <aside className="settings-drawer" data-testid="settings-skeleton" aria-label={t('加载中')} aria-busy="true">
        <header className="drawer-head">
          <span className="drawer-seal" aria-hidden="true">
            {t('设')}
          </span>
          <div className="drawer-titles">
            <div className="drawer-title">{t('设置')}</div>
            <div className="drawer-sub">
              <span className="sk sk-line" style={{ width: '180px', height: 8 }} />
            </div>
          </div>
        </header>
        <div className="settings-tabs sk-tabs">
          {Array.from({ length: 9 }, (_value, index) => (
            <span className="sk sk-tab" key={index} />
          ))}
        </div>
        <div className="settings-body">
          <PanelSkeleton rows={6} />
        </div>
      </aside>
    </>
  )
}
