import { defineConfig } from 'vitepress'

const repo = 'https://github.com/qweijiaq/x-code'

const english = [
  { text: 'Overview', link: '/' },
  { text: 'Desktop guide', link: '/desktop.en' },
  { text: 'User manual', link: '/desktop-manual.en' },
  { text: 'Install (unsigned)', link: '/desktop-install-unsigned.en' },
  { text: 'Skills', link: '/skills.en' },
  { text: 'Sub-agents', link: '/sub-agents.en' },
  { text: 'MCP', link: '/mcp.en' },
  { text: 'Knowledge and memory', link: '/knowledge.en' },
  { text: 'Plugins', link: '/plugins.en' },
  { text: 'Plugin authoring', link: '/plugin-authoring.en' },
  { text: 'Marketplace', link: '/marketplace.en' },
  { text: 'Hooks', link: '/hooks.en' },
  { text: 'Shell sessions', link: '/shell-sessions.en' },
  { text: 'Peer messaging', link: '/peer-messaging.en' },
  { text: 'Goals', link: '/goal.en' },
  { text: 'Semantic code navigation', link: '/lsp.en' },
]

const chinese = [
  { text: '总览', link: '/zh' },
  { text: '桌面端指南', link: '/desktop' },
  { text: '用户手册', link: '/desktop-manual' },
  { text: '未签名安装', link: '/desktop-install-unsigned' },
  { text: 'Skills', link: '/skills' },
  { text: '子代理', link: '/sub-agents' },
  { text: 'MCP', link: '/mcp' },
  { text: '知识与记忆', link: '/knowledge' },
  { text: '插件', link: '/plugins' },
  { text: '插件开发', link: '/plugin-authoring' },
  { text: '市场', link: '/marketplace' },
  { text: 'Hooks', link: '/hooks' },
  { text: 'Shell 会话', link: '/shell-sessions' },
  { text: '会话互通', link: '/peer-messaging' },
  { text: '目标模式', link: '/goal' },
  { text: '语义代码导航', link: '/lsp' },
]

export default defineConfig({
  lang: 'en-US',
  title: 'X-Code',
  description: 'A local-first, model-agnostic AI coding agent for the desktop and the terminal.',
  base: process.env.DOCS_BASE || '/',
  cleanUrls: true,
  lastUpdated: true,
  // Release-note pages link to repository files outside docs/ (CHANGELOG and
  // the e2e harness README). They exist on GitHub but not in the VitePress
  // source tree.
  ignoreDeadLinks: [/CHANGELOG/, /e2e\/README/],
  head: [
    ['meta', { name: 'theme-color', content: '#181410' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'X-Code documentation' }],
  ],
  themeConfig: {
    siteTitle: 'X-Code',
    nav: [
      { text: 'English', items: english.slice(1, 9) },
      { text: '简体中文', items: chinese.slice(1, 9) },
      { text: 'GitHub', link: repo },
    ],
    sidebar: [
      { text: 'English', items: english },
      { text: '简体中文', items: chinese },
    ],
    search: { provider: 'local' },
    outline: { level: [2, 3] },
    socialLinks: [{ icon: 'github', link: repo }],
    footer: {
      message: 'Released under the MIT License.',
      copyright: 'X-Code contributors',
    },
    editLink: {
      pattern: 'https://github.com/qweijiaq/x-code/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
  },
})
