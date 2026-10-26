import { createHash } from 'node:crypto'

/** 二进制缓存条目的完整内容身份标识。需要按模型或按提供商划分命名空间的
 *  调用方应给返回的摘要加上前缀。 */
export function bufferFingerprint(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 以 Map（按插入顺序迭代）支撑的最小通用 LRU 缓存。支持可选的 TTL。
 *  非线程安全（Node 是单线程的，因此用于进程内缓存没有问题）。 */
export class LruCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>()
  private readonly maxEntries: number
  private readonly ttlMs: number

  constructor(opts: { maxEntries: number; ttlMs?: number }) {
    this.maxEntries = opts.maxEntries
    this.ttlMs = opts.ttlMs ?? Infinity
  }

  get(key: string): V | null {
    const entry = this.map.get(key)
    if (!entry) return null
    if (Date.now() - entry.at > this.ttlMs) {
      this.map.delete(key)
      return null
    }
    // 移到尾部（最近使用）
    this.map.delete(key)
    this.map.set(key, entry)
    return entry.value
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(key, { value, at: Date.now() })
  }

  has(key: string): boolean {
    return this.get(key) !== null
  }

  get size(): number {
    return this.map.size
  }
}
