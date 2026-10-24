// @x-code-cli/core — user/project hooks.json loading
//
// Plugin hooks come from plugin manifests. Users can also author hooks
// directly in `~/.x-code/hooks.json` (user scope) or
// `<workspace>/.x-code/hooks.json` (project scope). Both use the same schema
// as plugin hooks and are registered before plugin hooks so a project can
// observe/inject around them deterministically.
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
  /** Project hooks are code execution with the user's privileges; callers
   *  must opt in after the user trusts the workspace. Defaults to false. */
  allowProjectHooks?: boolean
}

/** Read both scopes without throwing. A malformed file contributes an error
 *  string and an empty config so one broken scope cannot disable the other.
 *  Project hooks are only registered when `allowProjectHooks` is true, but
 *  their config is still returned so the UI can preview/trust them. */
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
