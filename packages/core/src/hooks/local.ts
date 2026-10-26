// @x-code-cli/core — user/project hooks.json 加载
//
// 插件 hook 来自插件 manifest。用户也可以直接在
// `~/.x-code/hooks.json`（user 作用域）或
// `<workspace>/.x-code/hooks.json`（project 作用域）编写 hook。
// 两者使用与插件 hook 相同的模式，并在插件 hook 之前注册，
// 这样项目能确定性地围绕它们进行观察 / 注入。
import fs from 'node:fs'
import path from 'node:path'

import { userXcodeDir } from '../utils.js'
import { parseHookConfig } from './config-schema.js'
import { buildHookRegistry } from './registry.js'
import type { HookConfig, RegisteredHook } from './types.js'

export type HookScope = 'user' | 'project'

export interface LocalHookSource {
  scope: HookScope
  path: string
  exists: boolean
  config: HookConfig
}

export interface LocalHooksResult {
  sources: LocalHookSource[]
  registered: RegisteredHook[]
  errors: string[]
}

export function localHookPaths(workspace: string): Record<HookScope, string> {
  return {
    user: path.join(userXcodeDir(), 'hooks.json'),
    project: path.join(path.resolve(workspace), '.x-code', 'hooks.json'),
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface LoadLocalHooksOptions {
  /** 项目 hook 是以用户权限执行的代码；调用方必须在
   *  用户信任该工作区之后显式选择加入。默认 false。 */
  allowProjectHooks?: boolean
}

/** 不抛异常地读取两个作用域。格式损坏的文件会贡献一条错误
 *  字符串和一个空配置，这样一个损坏的作用域不会禁用另一个。
 *  只有当 `allowProjectHooks` 为 true 时才注册项目 hook，但
 *  其配置仍会返回，以便 UI 预览 / 信任它们。 */
export function loadLocalHookConfigs(workspace: string, options: LoadLocalHooksOptions = {}): LocalHooksResult {
  const paths = localHookPaths(workspace)
  const sources: LocalHookSource[] = []
  const errors: string[] = []
  const registered: RegisteredHook[] = []
  const allowProjectHooks = options.allowProjectHooks === true

  for (const scope of ['user', 'project'] as const) {
    const file = paths[scope]
    const exists = fs.existsSync(file)
    let config: HookConfig = {}
    if (exists) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown
        config = parseHookConfig(raw, file)
      } catch (error) {
        errors.push(`${scope} hooks: ${errorMessage(error)}`)
      }
    }
    sources.push({ scope, path: file, exists, config })
    if (scope === 'project' && !allowProjectHooks) continue
    registered.push(...buildHookRegistry([{ pluginId: scope, pluginDir: path.dirname(file), config }]).list())
  }

  return { sources, registered, errors }
}
