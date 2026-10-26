import { describe, expect, it } from 'vitest'

import { detectExternalWorkspacePaths } from '../src/renderer/workspace-guard.js'

const workspace = '/Users/me/Desktop/project-a'

describe('detectExternalWorkspacePaths', () => {
  it('flags paths outside the workspace', () => {
    expect(
      detectExternalWorkspacePaths('把 /Users/me/Desktop/project-b/src/app.ts 里的 bug 修一下', workspace),
    ).toEqual(['/Users/me/Desktop/project-b/src/app.ts'])
    expect(detectExternalWorkspacePaths('看看 ~/notes/todo.md', workspace)).toEqual(['~/notes/todo.md'])
  })

  it('ignores paths inside the workspace and URL/system paths', () => {
    expect(detectExternalWorkspacePaths('改一下 /Users/me/Desktop/project-a/src/app.ts', workspace)).toEqual([])
    expect(
      detectExternalWorkspacePaths('打开 https://example.com/a/b 和 /usr/bin/python3 和 /tmp/x.log', workspace),
    ).toEqual([])
  })

  it('deduplicates and trims trailing punctuation', () => {
    expect(
      detectExternalWorkspacePaths(
        '对比 /Users/me/Desktop/project-b/a.ts，以及 /Users/me/Desktop/project-b/a.ts。',
        workspace,
      ),
    ).toEqual(['/Users/me/Desktop/project-b/a.ts'])
  })
})
