import type { PeerMessagingConfig } from '../config/index.js'
import type { InboundDisposition } from './inbox-types.js'

export interface InboundPolicyInput {
  policy: PeerMessagingConfig['inbound']
  receiverPermissionClass: 'prompted' | 'bypass'
  senderPermissionClass: 'prompted' | 'bypass'
  dialogExpiryMs: number
  now?: number
}

export function decideInboundDisposition(input: InboundPolicyInput): InboundDisposition {
  if (input.policy === 'accept') return { kind: 'accept' }
  if (input.policy === 'refuse') return { kind: 'refuse', reason: 'policy' }
  if (input.policy === 'hold') {
    return {
      kind: 'hold',
      expiresAt: new Date((input.now ?? Date.now()) + input.dialogExpiryMs).toISOString(),
      policySource: 'explicit',
    }
  }
  // 白名单校验后再比较：声明类型是非可选联合，但运行时（JSON 帧、未做断言
  // 校验的上游、后续扩展出的新类别）可能给出 undefined/null/未知字符串，此时
  // `undefined === undefined` 为真会直接 accept ——「两端都未设置 → 放行」，
  // 与本模块「缺省必须 fail-closed」的约定相反。
  const known = (value: unknown): value is 'prompted' | 'bypass' => value === 'prompted' || value === 'bypass'
  if (
    known(input.receiverPermissionClass) &&
    known(input.senderPermissionClass) &&
    input.receiverPermissionClass === input.senderPermissionClass
  ) {
    return { kind: 'accept' }
  }
  return {
    kind: 'hold',
    expiresAt: new Date((input.now ?? Date.now()) + input.dialogExpiryMs).toISOString(),
    policySource: 'auto',
  }
}
