import type { JSX } from 'react'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

export function SidebarIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9.5 4v16" />
    </svg>
  )
}

export function BranchIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="8" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 10.2c0 3.1-2.6 4.4-6 4.4H8.2" />
    </svg>
  )
}

export function TerminalIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m7.5 9 3 3-3 3" />
      <path d="M13.5 15h4" />
    </svg>
  )
}

export function SettingsIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.2 13.4a7.4 7.4 0 0 0 .05-2.8l2-1.5-2-3.4-2.35 1a7.5 7.5 0 0 0-2.4-1.4L14.1 3h-4.2l-.4 2.3a7.5 7.5 0 0 0-2.4 1.4l-2.35-1-2 3.4 2 1.5a7.4 7.4 0 0 0 0 2.8l-2 1.5 2 3.4 2.35-1a7.5 7.5 0 0 0 2.4 1.4l.4 2.3h4.2l.4-2.3a7.5 7.5 0 0 0 2.4-1.4l2.35 1 2-3.4-2-1.5Z" />
    </svg>
  )
}

export function HelpIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.1 1-1.1 1.7" />
      <path d="M12 16.5h.01" />
    </svg>
  )
}

export function MoreIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="18.5" cy="12" r="1.6" />
    </svg>
  )
}

export function ChevronIcon(): JSX.Element {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

export function CaptureIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  )
}

export function RegionIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8" />
      <path d="M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8" />
      <path d="M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16" />
      <path d="M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16" />
      <path d="M9 9h6v6H9z" strokeDasharray="2 2" />
    </svg>
  )
}

export function MicIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
    </svg>
  )
}

export function StopIcon(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  )
}

export function AttachIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M20 11.5 12.3 19.2a5 5 0 0 1-7.1-7.1l8-8a3.4 3.4 0 0 1 4.8 4.8l-8 8a1.8 1.8 0 0 1-2.5-2.5l7-7" />
    </svg>
  )
}

export function DocumentIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </svg>
  )
}

export function SendIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M4 12h15" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  )
}
