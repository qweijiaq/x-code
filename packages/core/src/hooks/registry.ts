// @x-code-cli/core — Hook 注册表
//
// 从事件名 → 有序 `RegisteredHook` 列表的内存映射。
// 由 [[buildHookRegistry]] 在 CLI 启动时构建一次，由
// HookBus 持有整个会话。与插件管线的其余部分一样受字节稳定约束：
// hook 不能在轮次之间变化（hook 列表变化应通过 `/plugin refresh` +
// systemPromptCache 失效进行，尽管 hook 本身并不出现在提示词里 ——
// 统一这条规则可避免特例）。
import type { HookConfig, HookEventName, RegisteredHook } from './types.js'

export class HookRegistry {
  private byEvent: Map<HookEventName, RegisteredHook[]>

  constructor(hooks: ReadonlyArray<RegisteredHook> = []) {
    this.byEvent = new Map()
    for (const h of hooks) {
      const list = this.byEvent.get(h.event) ?? []
      list.push(h)
      this.byEvent.set(h.event, list)
    }
  }

  /** 绑定到某个事件的 hook，按注册顺序。 */
  get(event: HookEventName): readonly RegisteredHook[] {
    return this.byEvent.get(event) ?? []
  }

  /** 总线用来在没有任何 hook 监听时跳过事件负载构造的廉价检查 ——
   *  每个发射点都在热路径上。 */
  has(event: HookEventName): boolean {
    return (this.byEvent.get(event)?.length ?? 0) > 0
  }

  /** 每个已注册的 hook。`/plugin doctor` 用它列出当前
   *  激活项及其贡献插件。 */
  list(): readonly RegisteredHook[] {
    const all: RegisteredHook[] = []
    for (const arr of this.byEvent.values()) all.push(...arr)
    return all
  }
}

/** 从各插件的 hook 配置构建注册表。输入数组的迭代顺序
 *  决定发射顺序 —— 调用方（integration.ts）负责
 *  以稳定顺序把插件交给我们。 */
export function buildHookRegistry(
  pluginHooks: ReadonlyArray<{ pluginId: string; pluginDir: string; config: HookConfig }>,
): HookRegistry {
  const all: RegisteredHook[] = []
  for (const { pluginId, pluginDir, config } of pluginHooks) {
    for (const eventName of Object.keys(config) as HookEventName[]) {
      const entries = config[eventName]
      if (!entries) continue
      for (const entry of entries) {
        all.push({ pluginId, pluginDir, event: eventName, entry })
      }
    }
  }
  return new HookRegistry(all)
}

export function emptyHookRegistry(): HookRegistry {
  return new HookRegistry([])
}
