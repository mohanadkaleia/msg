// composables/useUserDetails.ts — the shell seam for "open this user in the right
// drawer" (ENG-152 user hovercard + details). An interactive avatar/name lives far
// down the tree (message rows, sidebar DM rows), so instead of drilling a callback
// through every intermediate component the shell PROVIDES an opener and the
// interactive wrapper (UserPopover) INJECTS it. This is a pure in-tab function
// seam — it never touches HTTP or the worker (the drawer reads the already-in-
// memory directory record + presence store), so `no-http-in-ui` stays green.
import { inject, provide, type InjectionKey } from 'vue'

/** Open the right drawer's user-details panel for `userId`. */
export type OpenUserDetails = (userId: string) => void

const KEY: InjectionKey<OpenUserDetails> = Symbol('openUserDetails')

/** Shell side: expose the opener to every descendant interactive avatar/name. */
export function provideOpenUserDetails(open: OpenUserDetails): void {
  provide(KEY, open)
}

/**
 * Consumer side: the opener, or `undefined` when no shell provided one (e.g. the
 * tiptap mention popup renders in a detached portal — hover still works there,
 * click just no-ops rather than throwing).
 */
export function injectOpenUserDetails(): OpenUserDetails | undefined {
  return inject(KEY, undefined)
}
