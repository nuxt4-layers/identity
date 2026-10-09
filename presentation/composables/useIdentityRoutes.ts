import { useRuntimeConfig } from '#imports'

/**
 * PUBLIC. Links between the layer's pages, and to the host's sign-in page,
 * from the paths the presentation module was given.
 */
export function useIdentityRoutes() {
  const routes = useRuntimeConfig().public.identity.routes
  const fill = (path: string, params: Record<string, string>) =>
    path.replace(/:(\w+)/g, (match, name: string) => (name in params ? encodeURIComponent(params[name]!) : match))
  return {
    account: () => routes.account,
    group: (groupId: string) => fill(routes.group, { groupId }),
    change: (changeId: string) => fill(routes.change, { changeId }),
    invitation: () => routes.invitation,
    signIn: () => routes.signIn,
  }
}
