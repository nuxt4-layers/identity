import type { BreakGlassAction, BreakGlassReview, GroupMembersPage, GroupView, InvitationRecord, JoinRequestRecord, PendingChange, SelfView } from '../../contracts'
import { IDENTITY_API_PREFIX } from '../../contracts'

/**
 * The client side of Identity's administration API (docs/contracts.md §19).
 *
 * For the user experience only: what to show, which buttons to offer. It
 * decides nothing. Every request is decided again on the server, which
 * answers with a contract error (`IdentityErrorBody`) when it refuses.
 * Uses `useRequestFetch()` so that the session cookie is forwarded during
 * server-side rendering.
 */
export function useIdentity() {
  const request = useRequestFetch()
  const at = (path: string) => `${IDENTITY_API_PREFIX}${path}`
  const get = <T>(path: string, query?: Record<string, string>) => request(at(path), { query }) as Promise<T>
  const send = <T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: object) => request(at(path), { method, body }) as Promise<T>

  return {
    me: () => get<SelfView>('/me'),
    pauseIdentity: () => send<{ state: 'paused', orphanedGroupIds: string[] }>('POST', '/me/pause'),
    resumeIdentity: () => send<{ state: 'active' }>('POST', '/me/resume'),
    requestClosure: (leaveGroupsOrphaned = false) => send<{ state: 'closure-pending', closesAt: string }>('POST', '/me/closure', { leaveGroupsOrphaned }),
    cancelClosure: () => send<{ state: string }>('DELETE', '/me/closure'),

    group: (groupId: string) => get<GroupView>(`/groups/${groupId}`),
    createGroup: (parentGroupId: string, name: string) => send<{ groupId: string }>('POST', '/groups', { parentGroupId, name }),
    renameGroup: (groupId: string, name: string) => send<{ groupId: string, status: 'renamed' }>('PATCH', `/groups/${groupId}`, { name }),
    members: (groupId: string, after?: string) => get<GroupMembersPage>(`/groups/${groupId}/members`, after ? { after } : undefined),
    changes: (groupId: string) => get<PendingChange[]>(`/groups/${groupId}/changes`),

    pauseMembership: (membershipId: string) => send<{ membershipId: string, status: 'paused' }>('POST', `/memberships/${membershipId}/pause`),
    resumeMembership: (membershipId: string) => send<{ membershipId: string, status: 'active' }>('POST', `/memberships/${membershipId}/resume`),
    leaveGroup: (membershipId: string) => send<{ membershipId: string, status: 'ended' }>('POST', `/memberships/${membershipId}/leave`),
    suspendMember: (membershipId: string, reasonCode: string) => send<{ membershipId: string, status: 'suspended' }>('POST', `/memberships/${membershipId}/suspend`, { reasonCode }),
    removeMember: (membershipId: string, reasonCode: string) => send<{ membershipId: string, status: 'ended' }>('POST', `/memberships/${membershipId}/remove`, { reasonCode }),

    invitations: (groupId: string) => get<InvitationRecord[]>(`/groups/${groupId}/invitations`),
    acceptInvitation: (token: string) => send<{ status: 'accepted' }>('POST', '/invitations/accept', { token }),
    declineInvitation: (token: string) => send<{ status: 'accepted' }>('POST', '/invitations/decline', { token }),
    revokeInvitation: (invitationId: string) => send<InvitationRecord>('POST', `/invitations/${invitationId}/revoke`),
    decideAcceptance: (invitationId: string, decision: 'confirm' | 'refuse') => send<InvitationRecord>('POST', `/invitations/${invitationId}/decision`, { decision }),

    joinGroup: (groupId: string) => send<{ outcome: 'joined' | 'requested', joinRequestId: string | null }>('POST', `/groups/${groupId}/join`),
    joinRequests: (groupId: string) => get<JoinRequestRecord[]>(`/groups/${groupId}/join-requests`),
    withdrawJoinRequest: (joinRequestId: string) => send<JoinRequestRecord>('POST', `/join-requests/${joinRequestId}/withdraw`),
    decideJoinRequest: (joinRequestId: string, decision: 'approve' | 'refuse') => send<JoinRequestRecord>('POST', `/join-requests/${joinRequestId}/decision`, { decision }),

    requestChange: (change: object) => send<PendingChange>('POST', '/changes', { request: change }),
    change: (changeId: string) => get<PendingChange>(`/changes/${changeId}`),
    decideChange: (change: Pick<PendingChange, 'changeId' | 'changeDigest'>, decision: 'approve' | 'reject') =>
      send<PendingChange>('POST', `/changes/${change.changeId}/decision`, { decision, changeDigest: change.changeDigest }),
    cancelChange: (changeId: string) => send<PendingChange>('POST', `/changes/${changeId}/cancel`),
    objectToChange: (changeId: string) => send<PendingChange>('POST', `/changes/${changeId}/objection`),

    breakGlass: (action: BreakGlassAction, targetId: string, reasonCode: string) => send<BreakGlassReview>('POST', '/break-glass/actions', { action, targetId, reasonCode }),
  }
}
