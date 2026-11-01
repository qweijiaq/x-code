# Security Policy

X-Code is a local-first coding agent that can read files, run shell commands, call
model providers, and load MCP servers, plugins and skills. Security reports about
the permission model, sandbox boundaries, credential handling and the desktop IPC
surface are especially welcome.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.0.x   | Yes       |
| < 1.0   | No        |

Only the latest published `@x-code-cli/cli` and desktop release receive fixes.
Pre-release tags, local builds and unreleased branches are supported on a
best-effort basis only.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a security problem.**

Use GitHub's private vulnerability reporting:

<https://github.com/qweijiaq/x-code/security/advisories/new>

If that form is unavailable, contact the maintainer through the GitHub profile
linked from the repository and ask for a private channel before sharing details.

Please include:

- affected version (`xc --version` or the desktop About panel) and platform;
- the provider/model and whether the desktop app, the CLI or both are involved;
- a minimal reproduction: exact commands or prompts, files, and configuration;
- the impact you believe is possible (for example credential disclosure, command
  execution outside the workspace, permission bypass, or cross-session access);
- whether any secret, token or personal data may already have been exposed.

Redact API keys, session transcripts and private paths. If a secret may have
leaked, revoke it at the provider first.

## Scope

In scope:

- the permission and authority model (`packages/core/src/permissions/`), including
  shell classification and the peer-influence path;
- the macOS shell sandbox and its handling of sensitive paths and environment
  variables;
- path containment for file tools, document extraction and workspace boundaries;
- credential storage and the renderer/main/utility-process IPC boundary;
- SSRF protections in `webFetch`, redirect handling and response limits;
- MCP trust/OAuth handling, plugin consent, and skill/plugin installation;
- the local peer transport (Unix sockets and the Windows Named Pipe broker);
- Electron settings that weaken the renderer isolation (`nodeIntegration`,
  `contextIsolation`, `sandbox`, CSP, navigation and window-open handlers).

Out of scope or documented design boundaries:

- **The shell sandbox is macOS-only.** On Linux and Windows the agent's shell runs
  with the user's privileges; workspace-write confinement is not enforced there.
  Reports that require an unsandboxed shell on those platforms are known behavior,
  not a vulnerability, unless the sandbox was expected to be on.
- Plugins, skills, hooks and MCP servers are user-installed code. They run with the
  user's privileges after the consent step; a malicious extension the user chose to
  install is not by itself a product vulnerability.
- Model output quality, prompt-injection content that only changes the model's
  answer without crossing a permission boundary, and provider-side incidents.
- Denial of service that requires control of the local machine or the user's own
  provider key.

## Disclosure

We aim to acknowledge a report within 5 business days, agree on a fix and
disclosure timeline, and credit reporters who want credit. Please give us a
reasonable window (normally 90 days) before publishing details. There is no bug
bounty.
