// 权限系统的测试
import { describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { checkPermission, getPermissionLevel, isPathWithinProject } from '../src/permissions/index.js'
import {
  addSessionAllowRule,
  buildAllowRule,
  clearSessionRules,
  extractCommandPrefix,
  extractCompoundRules,
  sessionRulesMatch,
  suggestRuleLabel,
} from '../src/permissions/session-store.js'

describe('getPermissionLevel', () => {
  it('returns always-allow for read-only tools', () => {
    expect(getPermissionLevel('readFile', {})).toBe('always-allow')
    expect(getPermissionLevel('glob', {})).toBe('always-allow')
    expect(getPermissionLevel('grep', {})).toBe('always-allow')
    expect(getPermissionLevel('listDir', {})).toBe('always-allow')
    expect(getPermissionLevel('webSearch', {})).toBe('always-allow')
    expect(getPermissionLevel('webFetch', {})).toBe('always-allow')
  })

  it('returns ask for write tools', () => {
    expect(getPermissionLevel('edit', {})).toBe('ask')
    expect(getPermissionLevel('writeFile', {})).toBe('ask')
  })

  it('returns always-allow for read-only shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'pwd' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'cat file.txt' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'where tsc' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'pnpm exec tsc --noEmit -p packages/core/tsconfig.json' })).toBe(
      'always-allow',
    )
    expect(getPermissionLevel('shell', { command: 'tsc -b' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'git status' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git log --oneline' })).toBe('always-allow')
  })

  it('returns ask for write shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'npm install' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'mkdir test' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'touch file.txt' })).toBe('ask')
  })

  it('returns deny for destructive shell commands', () => {
    expect(getPermissionLevel('shell', { command: 'rm -rf /' })).toBe('deny')
    expect(getPermissionLevel('shell', { command: 'sudo rm file' })).toBe('deny')
  })

  it('handles compound commands — all read-only', () => {
    expect(getPermissionLevel('shell', { command: 'ls -la | wc -l' })).toBe('always-allow')
    expect(getPermissionLevel('shell', { command: 'git status && git log' })).toBe('always-allow')
  })

  it('handles compound commands — mixed', () => {
    expect(getPermissionLevel('shell', { command: 'ls && npm install' })).toBe('ask')
  })

  it('handles compound commands — destructive', () => {
    expect(getPermissionLevel('shell', { command: 'ls && rm -rf /' })).toBe('deny')
  })

  // 藏在白名单开头 token 之后的写入/执行必须回退为 ask ——
  // 绝不能 always-allow。单元级用例在 shell-utils.test.ts；
  // 这里守护的是端到端接线。
  it('asks for writes hidden behind read-only leading tokens', () => {
    expect(getPermissionLevel('shell', { command: 'echo x > ~/.zshrc' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'ls\nrm file' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'ls & rm file' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'find . -delete' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'echo $(rm file)' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'env rm file' })).toBe('ask')
    expect(getPermissionLevel('shell', { command: 'Get-ChildItem | ForEach-Object { Remove-Item $_ }' })).toBe('ask')
  })

  // 端到端验证用户提出的三个真实抱怨：
  // 本不该询问的 PS 管道，以及至少应能推导为 `npx tsc:*`
  // 规则的 `cd && build` 链。
  it('auto-allows real PowerShell read-only pipelines', () => {
    expect(
      getPermissionLevel('shell', {
        command:
          "cd D:\\res\\x-code-cli\\packages\\core\\src; Get-ChildItem -Recurse -Filter *.ts | Group-Object Directory | Sort-Object Name | Select-Object @{N='Directory';E={$_.Name}},Count",
      }),
    ).toBe('always-allow')
    expect(
      getPermissionLevel('shell', {
        command:
          "Get-ChildItem -Recurse -Filter *.ts -Path D:\\res\\x-code-cli\\packages\\core\\src | Group-Object Directory | Sort-Object Name | Select-Object @{Name='Directory';Expression={$_.Name}},Count",
      }),
    ).toBe('always-allow')
  })

  it('asks for `cd && build | head` but derives a stable prefix', () => {
    const cmd = 'cd d:\\isoform\\something\\wails-gui\\frontend && npx tsc --noEmit --pretty 2>&1 | head -40'
    expect(getPermissionLevel('shell', { command: cmd })).toBe('ask')
    // 关键是我们要保存的规则是 `npx tsc:*`，而不是 `cd:*` 或
    // 精确匹配 —— 这样后续的 `cd <other-dir> && npx tsc <other-args>`
    // 调用就不会再反复询问。
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('npx tsc:*')
  })

  it('auto-allows `ls X; if (Test-Path X) { Get-Content X }` end-to-end', () => {
    // 控制流识别会进入现有的逐分段 isReadOnly 检查，因此
    // `ls` 后接条件 Get-Content 的复合命令（用户的诊断命令）
    // 会降为 always-allow，无需询问。
    expect(
      getPermissionLevel('shell', {
        command:
          'ls -Force D:\\res\\x-code-cli\\.x-code\\local\\permissions.json 2>&1; if (Test-Path D:\\res\\x-code-cli\\.x-code\\local\\permissions.json) { Get-Content D:\\res\\x-code-cli\\.x-code\\local\\permissions.json }',
      }),
    ).toBe('always-allow')
  })
})

describe('checkPermission', () => {
  it('returns true for always-allow tools without asking', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '1', toolName: 'readFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('prompts user for destructive shell commands (deny level)', async () => {
    const askFn = vi.fn().mockResolvedValue('yes')
    const result = await checkPermission(
      { toolCallId: '2', toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('user can reject destructive shell commands', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const result = await checkPermission(
      { toolCallId: '2b', toolName: 'shell', input: { command: 'rm -rf /' } },
      false,
      askFn,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('trust mode auto-approves destructive shell commands', async () => {
    const askFn = vi.fn()
    const result = await checkPermission(
      { toolCallId: '2c', toolName: 'shell', input: { command: 'rm -rf /' } },
      true,
      askFn,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('asks user for ask-level tools', async () => {
    const askFn = vi.fn().mockResolvedValue('yes')
    const result = await checkPermission({ toolCallId: '3', toolName: 'writeFile', input: {} }, false, askFn)
    expect(result).toBe(true)
    expect(askFn).toHaveBeenCalled()
  })

  it('auto-approves ask-level tools in trust mode', async () => {
    const askFn = vi.fn()
    const result = await checkPermission({ toolCallId: '4', toolName: 'writeFile', input: {} }, true, askFn)
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('user can deny an ask-level tool', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const result = await checkPermission({ toolCallId: '5', toolName: 'edit', input: {} }, false, askFn)
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits auto-approves writes inside project dir', async () => {
    const askFn = vi.fn()
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '10', toolName: 'writeFile', input: { filePath: `${cwd}/src/foo.ts` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(true)
    expect(askFn).not.toHaveBeenCalled()
  })

  it('acceptEdits blocks writes outside project dir — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '11', toolName: 'writeFile', input: { filePath: '/etc/passwd' } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to sensitive dotfiles — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '12', toolName: 'edit', input: { filePath: `${cwd}/.env` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks writes to .git directory — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '13', toolName: 'writeFile', input: { filePath: `${cwd}/.git/config` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })

  it('acceptEdits blocks path traversal via ../ — falls to ask', async () => {
    const askFn = vi.fn().mockResolvedValue('no')
    const cwd = process.cwd()
    const result = await checkPermission(
      { toolCallId: '14', toolName: 'writeFile', input: { filePath: `${cwd}/../../etc/passwd` } },
      false,
      askFn,
      'acceptEdits',
      cwd,
    )
    expect(result).toBe(false)
    expect(askFn).toHaveBeenCalled()
  })
})

describe('extractCommandPrefix', () => {
  it('extracts two-token prefix for plain commands', () => {
    expect(extractCommandPrefix('git commit -m "fix"')).toBe('git commit')
    expect(extractCommandPrefix('pnpm run build')).toBe('pnpm run')
    expect(extractCommandPrefix('npm install lodash')).toBe('npm install')
  })

  it('strips whitelisted env-var prefixes', () => {
    expect(extractCommandPrefix('NODE_ENV=prod npm run dev')).toBe('npm run')
    expect(extractCommandPrefix('CI=1 DEBUG=foo npm test')).toBe('npm test')
    expect(extractCommandPrefix('LANG=en_US.UTF-8 NODE_ENV=prod git status')).toBe('git status')
  })

  it('returns null for unsafe env-var prefixes', () => {
    // 非白名单的赋值必须阻断前缀提取 —— 否则一条曾获批准的
    // `npm run dev` 规则也会自动批准 `BACKDOOR=1 npm run dev`。
    // 强制走精确匹配回退。
    expect(extractCommandPrefix('FOO=1 git status')).toBeNull()
    expect(extractCommandPrefix('PATH=/evil:$PATH npm run dev')).toBeNull()
    expect(extractCommandPrefix('NODE_OPTIONS="--require ./evil.js" npm test')).toBeNull()
    expect(extractCommandPrefix('http_proxy=http://attacker curl example.com')).toBeNull()
  })

  it('returns null for single-token or unprefixable commands', () => {
    expect(extractCommandPrefix('')).toBeNull()
    expect(extractCommandPrefix('ls')).toBeNull()
    expect(extractCommandPrefix('ls -la')).toBeNull()
  })

  it('skips global flags before the subcommand', () => {
    // 真实失败案例：`git -C /tmp commit -m fix` 什么都没提取出来，
    // 因为 token[1] 是 `-C`，不是子命令形状的字符串。
    expect(extractCommandPrefix('git -C /tmp commit -m fix')).toBe('git commit')
    expect(extractCommandPrefix('git --no-pager log --oneline')).toBe('git log')
    expect(extractCommandPrefix('git -c user.name=foo commit')).toBe('git commit')
    expect(extractCommandPrefix('git --git-dir=/tmp/.git status')).toBe('git status')
    expect(extractCommandPrefix('docker -H tcp://host:2375 ps')).toBe('docker ps')
    expect(extractCommandPrefix('docker --context default ps -a')).toBe('docker ps')
    expect(extractCommandPrefix('kubectl -n production get pods')).toBe('kubectl get')
    expect(extractCommandPrefix('kubectl --context prod --namespace foo apply -f k.yaml')).toBe('kubectl apply')
    expect(extractCommandPrefix('cargo +nightly build --release')).toBe('cargo build')
    expect(extractCommandPrefix('cargo +stable test')).toBe('cargo test')
  })

  it('returns null for wrapper commands too broad to anchor a rule on', () => {
    // 批准 `sudo ls` 绝不能自动批准 `sudo <anything>`。env/time/
    // xargs/bash -c 同理。这些都会强制走精确匹配回退。
    expect(extractCommandPrefix('sudo npm install')).toBeNull()
    expect(extractCommandPrefix('sudo apt-get update')).toBeNull()
    expect(extractCommandPrefix('bash -c "git push"')).toBeNull()
    expect(extractCommandPrefix('sh -c "rm foo"')).toBeNull()
    expect(extractCommandPrefix('env FOO=bar npm test')).toBeNull()
    expect(extractCommandPrefix('time npm run build')).toBeNull()
    expect(extractCommandPrefix('xargs git add')).toBeNull()
    expect(extractCommandPrefix('timeout 30 npm test')).toBeNull()
    expect(extractCommandPrefix('nohup node server.js')).toBeNull()
  })

  it('extracts cmdlet from quoted powershell -Command form', () => {
    expect(extractCommandPrefix('powershell -Command "Get-CimInstance Win32_LogicalDisk"')).toBe('Get-CimInstance')
    expect(extractCommandPrefix('powershell -c "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell.exe -Command "Get-Date"')).toBe('Get-Date')
  })

  it('handles powershell with leading flags before -Command', () => {
    // 来自 a.log 的真实失败案例：launcher 和 `-Command` 之间的 `-NoProfile`
    // 让每个子代理 shell 调用的“不再询问”选项消失。
    expect(extractCommandPrefix('powershell -NoProfile -Command "Get-CimInstance Win32_LogicalDisk"')).toBe(
      'Get-CimInstance',
    )
    expect(extractCommandPrefix('powershell -ExecutionPolicy Bypass -Command "git status"')).toBe('git')
    expect(extractCommandPrefix('powershell -NoLogo -NonInteractive -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass -c "Get-CimInstance"')).toBe(
      'Get-CimInstance',
    )
  })

  it('handles unquoted powershell command argument', () => {
    expect(extractCommandPrefix('powershell -Command Get-Date')).toBe('Get-Date')
    expect(extractCommandPrefix('powershell -NoProfile -Command Get-Process')).toBe('Get-Process')
  })

  it('handles powershell call-operator wrapping', () => {
    expect(extractCommandPrefix('powershell -Command "& { Get-Process }"')).toBe('Get-Process')
    expect(extractCommandPrefix('powershell -NoProfile -Command "& { Get-CimInstance Win32_LogicalDisk }"')).toBe(
      'Get-CimInstance',
    )
  })

  it('handles pwsh launcher', () => {
    expect(extractCommandPrefix('pwsh -Command "Get-Process"')).toBe('Get-Process')
    expect(extractCommandPrefix('pwsh.exe -NoProfile -Command "git status"')).toBe('git')
  })

  it('returns null for powershell -File (no derivable command name)', () => {
    expect(extractCommandPrefix('powershell -File ./script.ps1')).toBeNull()
    expect(extractCommandPrefix('powershell -NoProfile -File foo.ps1 arg1')).toBeNull()
  })

  it('returns null when powershell has only flags (no command)', () => {
    expect(extractCommandPrefix('powershell -NoProfile -ExecutionPolicy Bypass')).toBeNull()
  })

  // Verb-Noun cmdlet 形状 —— 之前的提取器漏掉的场景。
  // `Get-ChildItem -Recurse …` 过去返回 null，因为 `-Recurse`
  // 无法匹配小写的 SUBCOMMAND_RE，用户只剩下精确匹配可用
  // （所以任何 `-Path` / `-Filter` 改动都会永远反复询问）。
  it('recognises bare PowerShell cmdlets as their own prefix', () => {
    expect(extractCommandPrefix('Get-ChildItem -Recurse -Filter *.ts')).toBe('Get-ChildItem')
    expect(extractCommandPrefix('Get-ChildItem -Recurse -Filter *.ts -Path D:\\res\\x-code-cli')).toBe('Get-ChildItem')
    expect(extractCommandPrefix('Sort-Object Name')).toBe('Sort-Object')
    expect(extractCommandPrefix('Invoke-WebRequest -Uri http://example.com')).toBe('Invoke-WebRequest')
    expect(extractCommandPrefix('Set-Content -Path foo.txt -Value bar')).toBe('Set-Content')
  })

  it('does not mis-classify Unix commands with dashes as cmdlets', () => {
    // `apt-get` 看起来有点像 cmdlet，但动词是小写。
    // 必须仍走 POSIX 路径（没有子命令 → null）。
    expect(extractCommandPrefix('apt-get update')).toBe('apt-get update')
    expect(extractCommandPrefix('docker-compose up')).toBe('docker-compose up')
  })

  // 复合命令：前缀必须在每个非只读、非 cd 的分段上一致。
  // 不一致（`A && B` 且 B 不同）返回 null，以免某条 `A:*`
  // 规则意外批准 B。
  //
  // 注：全只读复合命令（`cd D:\… ; Get-ChildItem | Sort-Object`）
  // 不在此出现，因为 evaluateShellPermission 在上游就把它们短路为
  // `always-allow` —— extractCommandPrefix 根本不会被调用。
  // 我们只测试至少有一个非只读、非 cd 类分段可作规则锚点的场景。
  it('strips leading cd/Set-Location segments before deriving the prefix', () => {
    expect(extractCommandPrefix('cd /tmp && npm test')).toBe('npm test')
    expect(extractCommandPrefix('Set-Location D:\\foo; Set-Content -Path x.txt -Value bar')).toBe('Set-Content')
    expect(extractCommandPrefix('pushd /tmp && cargo build && popd')).toBe('cargo build')
  })

  it('strips read-only pipeline tails before deriving the prefix', () => {
    // 用户报告的示例：只有 `npx tsc` 是非只读；`cd` 和 `head`
    // 都是只读的准备/展示，因此我们保存的规则是 `npx tsc:*`，
    // 而不是 `cd:*` 或过于具体的精确匹配。
    expect(extractCommandPrefix('cd d:\\isoform\\foo && npx tsc --noEmit --pretty 2>&1 | head -40')).toBe('npx tsc')
    expect(extractCommandPrefix('npm run lint 2>&1 | tail -20')).toBe('npm run')
  })

  it('returns null when compound segments disagree on prefix', () => {
    // 安全闸门：`git commit:*` 绝不能自动批准尾部的 `git push`。
    // 分段不同 → 无共享前缀 → 精确匹配。
    expect(extractCommandPrefix('git commit -m fix && git push')).toBeNull()
    // npm install + 任意 curl：即便在旧逻辑下只会推导出 `npm install`，
    // 第二段仍是一条不同的命令，必须强制精确匹配。
    expect(extractCommandPrefix('npm install && curl example.com')).toBeNull()
  })

  it('still derives a prefix when only one non-readonly segment exists', () => {
    // 两条只读 + 一条真实命令：以真实命令为锚点。
    expect(extractCommandPrefix('cd /tmp && pnpm run build | head -20')).toBe('pnpm run')
  })
})

// extractCompoundRules 的直接测试。该函数是复合 shell 场景下
// suggestRuleLabel + buildAllowRule 背后的引擎，因此这里的回归会
// 暴露在用户可见的“不再询问”标签上，以及最终写进
// .x-code/local/permissions.json 的内容上。下面的 buildAllowRule
// 测试已有间接覆盖；直接写出规则形状是值得的冗余。
describe('extractCompoundRules', () => {
  const ruleShape = (r: { type: string; pattern: string }) => `${r.type}:${r.pattern}`

  it('single derivable command → one prefix rule', () => {
    const rules = extractCompoundRules('git commit -m fix')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit'])
  })

  it('single Verb-Noun cmdlet → one prefix rule (cmdlet name on its own)', () => {
    // 必须选一个不在只读集合里的 cmdlet，否则分段会在到达前缀
    // 步骤之前就被过滤掉（只读复合命令在上游短路为 always-allow，
    // 不需要规则）。Set-Content 会写文件，所以是干净的示例。
    const rules = extractCompoundRules('Set-Content -Path foo.txt -Value bar')
    expect(rules?.map(ruleShape)).toEqual(['prefix:Set-Content'])
  })

  it('single command without a derivable prefix → one segment-exact rule', () => {
    const rules = extractCompoundRules('findstr /n "any" file.txt')
    expect(rules?.map(ruleShape)).toEqual(['exact:findstr /n "any" file.txt'])
  })

  it('compound with all distinct prefixes → one prefix rule per segment, order preserved', () => {
    const rules = extractCompoundRules('git commit -m a && git push origin main')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'prefix:git push'])
  })

  it('compound mixing prefix-able and not → prefix + segment-exact, order preserved', () => {
    const rules = extractCompoundRules('git commit -m a && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  it('skips leading cd / Set-Location segments', () => {
    expect(extractCompoundRules('cd /tmp && npm test')?.map(ruleShape)).toEqual(['prefix:npm test'])
    expect(extractCompoundRules('Set-Location D:\\foo; Set-Content -Path x.txt -Value bar')?.map(ruleShape)).toEqual([
      'prefix:Set-Content',
    ])
    expect(extractCompoundRules('pushd /tmp && cargo build && popd')?.map(ruleShape)).toEqual(['prefix:cargo build'])
  })

  it('skips read-only segments (pipeline tails, leading setup)', () => {
    expect(extractCompoundRules('npm run lint 2>&1 | tail -20')?.map(ruleShape)).toEqual(['prefix:npm run'])
    expect(extractCompoundRules('cd /foo && pnpm run build | head -20')?.map(ruleShape)).toEqual(['prefix:pnpm run'])
  })

  it('deduplicates repeated prefixes across segments', () => {
    const rules = extractCompoundRules('git commit -m a && git commit --amend')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit'])
  })

  it('deduplicates repeated segment-exact patterns across segments', () => {
    const rules = extractCompoundRules('curl evil.com && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['exact:curl evil.com'])
  })

  it('keeps both forms separately when prefix-able and non-prefix-able overlap by name', () => {
    const rules = extractCompoundRules('git commit -m a && curl evil.com && git commit --amend && curl evil.com')
    expect(rules?.map(ruleShape)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  it('handles the PowerShell launcher path by returning a single inner-cmdlet prefix', () => {
    // POWERSHELL_LAUNCHER_RE 会短路到 extractPowershellPrefix。
    // 无论引号内脚本里是什么复合形状，整个 `powershell -Command "..."`
    // 都算一条规则。
    expect(extractCompoundRules('powershell -Command "Get-CimInstance Win32_LogicalDisk"')?.map(ruleShape)).toEqual([
      'prefix:Get-CimInstance',
    ])
    expect(extractCompoundRules('powershell -NoProfile -Command "& { Get-Process }"')?.map(ruleShape)).toEqual([
      'prefix:Get-Process',
    ])
    expect(extractCompoundRules('powershell -File ./script.ps1')).toBeNull()
  })

  it('returns null when a non-whitelisted env-var prefixes a segment', () => {
    // 与 extractSingleCommandPrefix 相同的防御：`BACKDOOR=1 …` 前缀
    // 会污染分段，使我们无法安全地把它变成规则。调用方通过
    // buildAllowRule 的 stripSafeEnvVars 分支回退到单条全命令精确匹配。
    expect(extractCompoundRules('BACKDOOR=1 git status')).toBeNull()
    expect(extractCompoundRules('git commit -m a && PATH=/evil:$PATH something')).toBeNull()
  })

  it('strips whitelisted env-var prefixes inside a segment-exact rule', () => {
    // `NODE_ENV=prod` 在 SAFE_ENV_VARS 里 —— 保存前会先被剥离，
    // 这样匹配器键（同样会剥离）保持规范。
    const rules = extractCompoundRules('NODE_ENV=prod findstr /v foo bar.txt')
    expect(rules?.map(ruleShape)).toEqual(['exact:findstr /v foo bar.txt'])
  })

  it('returns null for empty / whitespace-only input', () => {
    expect(extractCompoundRules('')).toBeNull()
    expect(extractCompoundRules('   ')).toBeNull()
  })

  it('returns null for all-readonly compounds (auto-allowed upstream)', () => {
    // `cd /tmp && ls -la` 是全只读。每个分段都作为只读被过滤掉，
    // 没剩任何可推导的东西。实际中 evaluateShellPermission 会在到达
    // 这个分支前就短路为 always-allow —— 返回 null 是防御性的
    // “无需规则”信号。
    expect(extractCompoundRules('cd /tmp && ls -la')).toBeNull()
    expect(extractCompoundRules('Get-ChildItem -Recurse | Sort-Object Name | Select-Object Name')).toBeNull()
  })

  it('tags each rule with tool="shell"', () => {
    // 磁盘上存储的 AllowRule 形状的成败就取决于此 —— tool 字段缺失
    // 或错误意味着匹配器找不到这条规则。
    const rules = extractCompoundRules('git commit -m a && curl evil.com')
    expect(rules?.every((r) => r.tool === 'shell')).toBe(true)
  })
})

describe('isPathWithinProject', () => {
  const cwd = process.cwd()

  it('returns true for paths inside the project', () => {
    expect(isPathWithinProject(`${cwd}/src/index.ts`, cwd)).toBe(true)
    expect(isPathWithinProject(`${cwd}/deep/nested/file.ts`, cwd)).toBe(true)
  })

  it('returns true when file path equals project dir', () => {
    expect(isPathWithinProject(cwd, cwd)).toBe(true)
  })

  it('returns false for paths outside the project', () => {
    expect(isPathWithinProject('/etc/passwd', cwd)).toBe(false)
    expect(isPathWithinProject('/tmp/evil.ts', cwd)).toBe(false)
  })

  it('returns false for traversal attacks', () => {
    expect(isPathWithinProject(`${cwd}/../../etc/passwd`, cwd)).toBe(false)
    expect(isPathWithinProject(`${cwd}/../secret`, cwd)).toBe(false)
  })

  it('returns false when an in-project directory link resolves outside', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'x-code-path-boundary-'))
    try {
      const project = path.join(root, 'project')
      const outside = path.join(root, 'outside')
      await fs.mkdir(project)
      await fs.mkdir(outside)
      await fs.symlink(outside, path.join(project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

      expect(isPathWithinProject(path.join(project, 'linked', 'file.txt'), project)).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe('suggestRuleLabel + buildAllowRule fallback for unrecognised shell commands', () => {
  it('offers an exact-match label for Windows commands with /flag second token', () => {
    // 真实失败案例：`findstr /n "any\b" "..." 2>nul` 只得到 Yes/No 而没有
    // “不再询问”，因为 `/n` 无法匹配前缀正则。精确匹配回退给了用户一条出路。
    const input = { command: 'findstr /n "any\\b" "D:\\res\\file.ts" 2>nul' }
    expect(suggestRuleLabel('shell', input)).toBe('this exact command')
    const built = buildAllowRule('shell', input)
    expect(built).not.toBeNull()
    expect(built!.persist).toBe(true)
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('exact')
    expect(built!.rules[0]!.pattern).toBe(input.command)
  })

  it('still prefers the prefix rule when one is derivable', () => {
    expect(suggestRuleLabel('shell', { command: 'git commit -m fix' })).toBe('git commit:*')
    const built = buildAllowRule('shell', { command: 'git commit -m fix' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('prefix')
    expect(built!.rules[0]!.pattern).toBe('git commit')
  })

  it('strips env-var prefixes before storing the exact-match pattern', () => {
    // `NODE_ENV=prod` 是 SAFE 环境变量前缀；匹配器会比较
    // `stripEnvVars(cmd)`，因此我们必须在规则模式里存同样的剥离后形状。
    const built = buildAllowRule('shell', { command: 'NODE_ENV=prod findstr /v foo bar.txt' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('exact')
    expect(built!.rules[0]!.pattern).toBe('findstr /v foo bar.txt')
  })

  it('returns null label/rule for empty shell command', () => {
    expect(suggestRuleLabel('shell', { command: '' })).toBe('this exact command')
    // 剥离后完全为空的命令，buildAllowRule 仍会放弃。
    expect(buildAllowRule('shell', { command: '' })).toBeNull()
  })

  it('keeps writeFile/edit on session-only tool-wide rules', () => {
    expect(suggestRuleLabel('writeFile', {})).toBe('all edits this session')
    const built = buildAllowRule('writeFile', {})
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.type).toBe('tool')
    expect(built!.persist).toBe(false)
  })

  it('saves a rule per distinct prefix for compound shell commands', () => {
    // 来自实际 CLI 的抱怨案例：`git commit && git push` 过去显示
    // “this exact command”，因为两段的前缀不一致。我们现在在标签里
    // 展示两个前缀，一次点击保存两条规则，使后续的
    // `git commit -m foo && git push origin main` 调用不再询问。
    const cmd = 'git commit && git push'
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('git commit:*, git push:*')
    const built = buildAllowRule('shell', { command: cmd })
    expect(built!.persist).toBe(true)
    expect(built!.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual(['prefix:git commit', 'prefix:git push'])
  })

  it('deduplicates repeated prefixes in a compound', () => {
    // `git commit -m a && git commit --amend` 是同一个前缀出现两次
    // —— 保存一次就够。
    const built = buildAllowRule('shell', { command: 'git commit -m a && git commit --amend' })
    expect(built!.rules).toHaveLength(1)
    expect(built!.rules[0]!.pattern).toBe('git commit')
  })

  it('mixes prefix + segment-exact when only some segments have prefixes', () => {
    // `git commit -m a && curl evil.com` —— 第一段有干净的前缀，
    // 第二段没有（`evil.com` 无法匹配 SUBCOMMAND_RE）。早期设计会把
    // 它坍缩成一条全命令精确规则，丢弃可推导的 `git commit:*`。
    // 我们现在两者都保存（git commit 用前缀、curl 用分段精确），
    // 标签也同时展示两者，让用户知道批准了什么。
    const cmd = 'git commit -m a && curl evil.com'
    expect(suggestRuleLabel('shell', { command: cmd })).toBe('git commit:*, curl evil.com')
    const built = buildAllowRule('shell', { command: cmd })
    expect(built!.persist).toBe(true)
    expect(built!.rules.map((r) => `${r.type}:${r.pattern}`)).toEqual(['prefix:git commit', 'exact:curl evil.com'])
  })

  // 端到端：对复合命令的一次点击保存多条规则；匹配器随后自动批准
  // 未来的复合变体以及每条规则单独使用，但仍拒绝任何包含未批准
  // 命令的复合命令。
  it('compound approval covers future variants but not unrelated additions', () => {
    clearSessionRules()
    const built = buildAllowRule('shell', { command: 'git commit && git push' })!
    for (const r of built.rules) addSessionAllowRule(r)

    expect(sessionRulesMatch('shell', { command: 'git commit -m foo && git push' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'cd /tmp && git commit -m a && git push origin main' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git commit --amend' })).toBe(true)
    expect(sessionRulesMatch('shell', { command: 'git push -u origin main' })).toBe(true)

    // `npm test` 从未获批 → 整个复合命令重新询问。
    // （`git tag` 本是不那么意外的选择，但它的裸形式在只读 git
    // 子命令列表里，所以会从待检查分段中过滤掉。）
    expect(sessionRulesMatch('shell', { command: 'git commit -m a && git push && npm test' })).toBe(false)
    // 纵深防御：第二段没有可推导前缀的半批准复合命令绝不能自动允许。
    expect(sessionRulesMatch('shell', { command: 'git commit -m a && curl evil.com' })).toBe(false)
    clearSessionRules()
  })

  it('returns null for enterPlanMode (no recurring action to remember)', () => {
    expect(suggestRuleLabel('enterPlanMode', {})).toBeNull()
  })

  it('returns "this MCP tool" when isMcp is true regardless of tool name', () => {
    // MCP 工具过去会落到 writeFile 分支并显示为 “all edits this session”
    // —— 文本错误、持久化姿态也错误（MCP 的 always-allow 通过
    // McpPermissionStore 写盘，而非仅会话级）。显式的 isMcp 标志会
    // 绕过 shell / write 回退，返回 MCP 风格的标签。
    expect(suggestRuleLabel('filesystem__read_file', { path: '/tmp' }, true)).toBe('this MCP tool')
    expect(suggestRuleLabel('any_name_at_all', {}, true)).toBe('this MCP tool')
  })
})
