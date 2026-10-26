// @x-code-cli/core — 共享的注册表重载差异计算辅助
//
// 在具名注册表被热替换时计算 added/removed/changed/unchanged 明细。
// 每个注册表带来自己的变更检测谓词，同时共享这一结构性算法。

export interface ReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

/** 对比两个具名条目映射。当同键条目在领域相关的维度上不同时，
 *  `isChanged(prev, next)` 返回 true。 */
export function diffNamedEntries<T>(
  previous: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
  isChanged: (prev: T, next: T) => boolean,
): ReloadSummary {
  const summary: ReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
  for (const [name, entry] of next) {
    const prev = previous.get(name)
    if (!prev) summary.added.push(name)
    else if (isChanged(prev, entry)) summary.changed.push(name)
    else summary.unchanged.push(name)
  }
  for (const name of previous.keys()) {
    if (!next.has(name)) summary.removed.push(name)
  }
  return summary
}
