import path from 'node:path'

/** 包管理器从包目录运行 workspace 脚本，同时把用户的调用目录保留在 INIT_CWD
 *  中。在 CLI 加载项目作用域状态之前把它恢复，这样 dev 运行能与已安装的
 *  二进制文件行为一致。 */
export function restoreInvocationCwd(
  initCwd: string | undefined = process.env.INIT_CWD,
  chdir: (directory: string) => void = process.chdir,
): boolean {
  if (!initCwd || !path.isAbsolute(initCwd)) return false
  try {
    chdir(initCwd)
    return true
  } catch {
    return false
  }
}
