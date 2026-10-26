// @x-code-cli/core — Hook 命令变量展开
//
// 替换 hook 命令字符串中的 `${name}` 与 `${env:NAME}` 模式。
// 未知变量保留为字面的 `${name}`，这样拼写错误会在最终 shell 命令的
// 报错信息里暴露出来，而不是静默展开成空字符串（那会产生令人困惑、
// 且不指向变量的 "command not found" 错误）。
//
// 支持的变量（参见 [[plugin-marketplace-design]] §8.4）：
//
//    ${pluginDir}      所属插件安装目录的绝对路径
//                      （带版本号的缓存目录；重装 / 升级时清空）
//    ${pluginDataDir}  插件持久化数据目录的绝对路径
//                      （~/.x-code/plugins/data/<sanitised-plugin-id>/）——
//                      卸载后重装及版本升级仍保留。
//                      由调用方在展开前按需创建；
//                      本模块只做字符串替换。
//    ${cwd}            当前工作目录
//    ${homedir}        用户主目录
//    ${sep}            操作系统相关的路径分隔符（Windows 为 `\`，其余为 `/`）
//    ${env:NAME}       进程环境变量 `NAME`（未设置时为空字符串）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pluginDataDir as pluginDataDirPath } from '../plugins/paths.js'

export interface VariableContext {
  pluginDir: string
  /** 插件持久化数据目录。提供 `pluginId` 时由
   *  [[buildVariableContext]] 预先创建。 */
  pluginDataDir?: string
  cwd: string
  homedir?: string
  sep?: string
}

/** 由当前进程 + 调用方上下文派生的默认变量。
 *  传入 `pluginId` 以启用 `${pluginDataDir}` —— 我们会解析
 *  每个插件的数据目录路径并 `mkdir -p` 它，这样插件可以立即
 *  写入。对已存在目录执行 mkdirSync 是廉价的空操作。 */
export function buildVariableContext(input: { pluginDir: string; cwd: string; pluginId?: string }): VariableContext {
  let dataDir: string | undefined
  if (input.pluginId) {
    dataDir = pluginDataDirPath(input.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // mkdir 失败（权限、磁盘满）会让目录缺失 ——
      // 插件脚本在尝试写入时会得到合理的 shell 错误。
      // 比在这里抛错并卡死 hook 更好。
    }
  }
  return {
    pluginDir: input.pluginDir,
    pluginDataDir: dataDir,
    cwd: input.cwd,
    homedir: os.homedir(),
    sep: path.sep,
  }
}

/** 展开 `${pluginDir}` / `${pluginDataDir}` / `${cwd}` / `${homedir}` /
 *  `${sep}` / `${env:NAME}` 引用。未知模式保持原样。 */
export function expandVariables(source: string, ctx: VariableContext): string {
  return source.replace(/\$\{([^}]+)\}/g, (whole, expr: string) => {
    const colonIdx = expr.indexOf(':')
    if (colonIdx > 0) {
      const ns = expr.slice(0, colonIdx)
      const key = expr.slice(colonIdx + 1)
      if (ns === 'env') return process.env[key] ?? ''
      // 未知命名空间 —— 保持原样
      return whole
    }
    switch (expr) {
      case 'pluginDir':
        return ctx.pluginDir
      case 'pluginDataDir':
        return ctx.pluginDataDir ?? whole
      case 'cwd':
        return ctx.cwd
      case 'homedir':
        return ctx.homedir ?? ''
      case 'sep':
        return ctx.sep ?? path.sep
      default:
        return whole
    }
  })
}
