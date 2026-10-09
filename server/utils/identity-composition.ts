import type {
  IdentityAccessDecision,
  IdentityApprovalPolicy,
  IdentityDatabase,
  IdentityEventPublisher,
  IdentityPolicy,
  IdentityPolicyInput,
} from '../../contracts'
import { IdentityCompositionError, resolveIdentityPolicy } from '../../contracts'

/**
 * Composition registry. The host application calls the `provide*` functions
 * from a Nitro plugin; the layer's server code calls the `use*` functions.
 *
 * Required ports fail closed: using one before it is supplied throws
 * `IdentityCompositionError` instead of falling back to an implicit store,
 * an implicit "allow" or a dropped event.
 */

let database: (IdentityDatabase & { schema: string }) | null = null
let accessDecision: IdentityAccessDecision | null = null
let approvalPolicy: IdentityApprovalPolicy | null = null
let eventPublisher: IdentityEventPublisher | null = null
let policy: IdentityPolicy | null = null

export function provideIdentityDatabase(next: IdentityDatabase): void {
  if (next?.dialect !== 'postgres' || typeof next.pool?.query !== 'function') {
    throw new TypeError('provideIdentityDatabase expects { dialect: \'postgres\', pool } with a pg-compatible pool.')
  }
  const schema = next.schema ?? 'identity'
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new TypeError(`Invalid identity schema name '${schema}'.`)
  }
  database = { ...next, schema }
}

export function provideIdentityAccessDecision(next: IdentityAccessDecision): void {
  if (typeof next?.decide !== 'function') {
    throw new TypeError('provideIdentityAccessDecision expects an object with a decide(input) function.')
  }
  accessDecision = next
}

export function provideIdentityApprovalPolicy(next: IdentityApprovalPolicy): void {
  if (typeof next?.riskOf !== 'function' || typeof next.qualifies !== 'function' || typeof next.countQualifying !== 'function') {
    throw new TypeError('provideIdentityApprovalPolicy expects riskOf(permission), qualifies(input) and countQualifying(input) functions.')
  }
  approvalPolicy = next
}

export function provideIdentityEventPublisher(next: IdentityEventPublisher): void {
  if (typeof next?.publish !== 'function') {
    throw new TypeError('provideIdentityEventPublisher expects an object with a publish(event) function.')
  }
  eventPublisher = next
}

/** Validates and stores the host's policy. Invalid policy, or a loosening without a risk treatment, throws at startup. */
export function provideIdentityPolicy(input: IdentityPolicyInput): void {
  policy = resolveIdentityPolicy(input)
}

export function useIdentityDatabase(): IdentityDatabase & { schema: string } {
  if (!database) throw new IdentityCompositionError('IdentityDatabase')
  return database
}

export function useIdentityAccessDecision(): IdentityAccessDecision {
  if (!accessDecision) throw new IdentityCompositionError('IdentityAccessDecision')
  return accessDecision
}

export function useIdentityApprovalPolicy(): IdentityApprovalPolicy {
  if (!approvalPolicy) throw new IdentityCompositionError('IdentityApprovalPolicy')
  return approvalPolicy
}

export function useIdentityEventPublisher(): IdentityEventPublisher {
  if (!eventPublisher) throw new IdentityCompositionError('IdentityEventPublisher')
  return eventPublisher
}

/** The effective policy: host overrides when supplied, otherwise the secure defaults. */
export function useIdentityPolicy(): IdentityPolicy {
  if (!policy) policy = resolveIdentityPolicy()
  return policy
}

/** Test helper: removes every supplied port. */
export function clearIdentityComposition(): void {
  database = null
  accessDecision = null
  approvalPolicy = null
  eventPublisher = null
  policy = null
}
