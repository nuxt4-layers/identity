/**
 * Identity's permissions. The host adds them to Authorisation's catalogue
 * (`provideAuthorisationPermissions(IDENTITY_PERMISSIONS)`); Identity asks
 * Authorisation for every decision through its access-decision port.
 *
 * Names follow Authorisation's grammar, `<resource>:<action>`. Risk levels
 * follow iam-integration's processes; where a process names one, it is used
 * here unchanged.
 *
 * Acting on oneself needs no permission and is never delegated: pausing or
 * resuming, leaving a group, accepting an invitation, requesting or
 * cancelling closure. Nobody can do those for another person.
 */

export const IDENTITY_RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const
export type IdentityRiskLevel = typeof IDENTITY_RISK_LEVELS[number]

export interface IdentityPermissionDefinition {
  name: string
  description: string
  risk: IdentityRiskLevel
}

export const IDENTITY_PERMISSIONS = Object.freeze([
  { name: 'identity.groups:view', description: 'See a group, its lineage and its settings', risk: 'low' },
  { name: 'identity.groups:create', description: 'Create a child group', risk: 'medium' },
  { name: 'identity.root-groups:create', description: 'Create a root group in a tenant', risk: 'high' },
  { name: 'identity.groups:rename', description: 'Rename a group', risk: 'medium' },
  { name: 'identity.groups:reparent', description: 'Move a group under another parent in the same tenant', risk: 'critical' },
  { name: 'identity.groups:archive', description: 'Archive a group', risk: 'high' },
  { name: 'identity.group-settings:manage', description: 'Change joining, guest, archive and departure data settings', risk: 'high' },
  { name: 'identity.group-approvals:manage', description: 'Raise or restore a group\'s approval requirements', risk: 'critical' },
  { name: 'identity.group-owners:manage', description: 'Add, remove, suspend or demote an owner', risk: 'critical' },
  { name: 'identity.memberships:view', description: 'See a group\'s members and their states', risk: 'low' },
  { name: 'identity.invitations:manage', description: 'Invite to a group, or revoke an invitation', risk: 'medium' },
  { name: 'identity.join-requests:decide', description: 'Approve or refuse a request to join', risk: 'medium' },
  { name: 'identity.memberships:remove', description: 'Remove a member who is not an owner, with a reason code', risk: 'medium' },
  { name: 'identity.memberships:suspend', description: 'Suspend or reinstate a member who is not an owner, with a reason code', risk: 'medium' },
  { name: 'identity.memberships:schedule', description: 'Set or change a membership\'s start and end dates, or renew a guest', risk: 'medium' },
  { name: 'identity.service-identities:create', description: 'Create a service identity owned by the group', risk: 'high' },
  { name: 'identity.service-identities:manage', description: 'Suspend, reinstate or close a service identity owned by the group', risk: 'high' },
  { name: 'identity.identities:suspend', description: 'Suspend or reinstate an identity, for platform-wide reasons only', risk: 'high' },
  { name: 'identity.orphaned-groups:recover', description: 'Propose an owner for an orphaned group', risk: 'critical' },
  { name: 'identity.tenants:view', description: 'See a tenant and its jurisdiction and data region', risk: 'low' },
  { name: 'identity.tenants:manage', description: 'Provision a tenant or start its closure', risk: 'critical' },
  { name: 'identity.break-glass-reviews:close', description: 'Close the review that follows a break-glass action', risk: 'high' },
] as const satisfies readonly IdentityPermissionDefinition[])

export type IdentityPermissionName = typeof IDENTITY_PERMISSIONS[number]['name']

export function identityPermissionRisk(name: IdentityPermissionName): IdentityRiskLevel {
  return IDENTITY_PERMISSIONS.find(permission => permission.name === name)!.risk
}
