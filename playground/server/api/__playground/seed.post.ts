import { randomUUID } from 'node:crypto'
import { createError, defineEventHandler } from 'h3'
import type { IdentitySubject } from '../../../../contracts'
import { playground } from '../../plugins/composition'

/**
 * Test mode only: builds a fresh scenario for a browser test, through the
 * layer's own server functions, and returns its identifiers. A tenant whose
 * root group `Company` is owned by `rootOwner`; a child group `Team` founded
 * by `owner`, with `member`; a guest invitation to `Team` (its token); and an
 * owner change for `member`, waiting for `rootOwner` to approve; and an
 * `outsider`, whom the playground's Authorisation stand-in refuses everything.
 */
export default defineEventHandler(async () => {
  if (process.env.IDENTITY_PLAYGROUND_TEST !== '1' || !playground.operator) throw createError({ statusCode: 404 })
  await playground.ready
  const correlationId = randomUUID()
  const subject = (principalId: string): IdentitySubject => ({ principalId, authenticatedAt: new Date().toISOString(), assurance: { level: 'aal2', phishingResistant: true } })
  const { tenantId } = await provisionIdentityTenant({ pool: playground.operator, jurisdiction: 'uk-gdpr', dataRegion: 'uk', correlationId })
  provideIdentityPolicy({ defaultHomeTenantId: tenantId })
  const provisioning = getIdentityProvisioning()
  const person = async () => {
    const { identityId } = await provisioning.reserve({ requestId: randomUUID().replace(/^(.{14})./, '$17'), kind: 'person', correlationId })
    await provisioning.confirm({ identityId, correlationId })
    return identityId
  }
  const [rootOwner, owner, member, invitee, outsider] = [await person(), await person(), await person(), await person(), await person()]
  playground.outsiders.add(outsider)
  const { groupId: root } = await bootstrapIdentityRootGroup({ pool: playground.operator, tenantId, name: 'Company', firstOwnerId: rootOwner, correlationId })
  const { groupId: team } = await getIdentityGovernance().createGroup({ subject: subject(owner), parentGroupId: root, name: 'Team', correlationId })
  const joining = getIdentityJoining()
  const memberInvitation = await joining.invite({ subject: subject(owner), groupId: team, kind: 'member', inviteeIdentityId: member, correlationId })
  await joining.accept({ subject: subject(member), token: memberInvitation.token, correlationId })
  const guestInvitation = await joining.invite({ subject: subject(owner), groupId: team, kind: 'guest', correlationId })
  const members = await getIdentityQueries().members({ subject: subject(owner), groupId: team, correlationId })
  const membershipId = members.members.find(entry => entry.membership.identityId === member)!.membership.membershipId
  const change = await getIdentityApprovals().request({
    subject: subject(owner),
    request: { type: 'group.add-owner', target: { membershipId }, justification: { reasonCode: 'succession', reference: null } },
    correlationId,
  })
  return { tenantId, root, team, rootOwner, owner, member, invitee, outsider, guestToken: guestInvitation.token, changeId: change.changeId }
})
