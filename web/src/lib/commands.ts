// lib/commands.ts — the Cmd+K command registry (ENG-136 "Ranin" palette actions).
//
// The palette is no longer just a channel quick-switcher: alongside stream
// navigation it offers a "Commands" group of ACTIONS. Every command here wires
// to an EXISTING shell seam (dialog-open flags, theme cycling, the logout flow —
// all injected by `useShellController`); the registry never invents behavior and
// never touches a store, HTTP, or the worker itself. Pure + synchronous, so it
// is trivially unit-testable with spy seams.
//
// A command with no live seam does NOT belong in this list — no dead actions.
// (`Invite member` / `Install app` are deliberately absent: no web seam exists.)

/**
 * The `ui/Icon` names this registry uses — a literal SUBSET of `IconName`,
 * declared here (not imported from Icon.vue) so this stays a plain .ts module
 * with fully-resolvable types. vue-tsc verifies the subset at the palette
 * boundary: an entry outside Icon's map would fail `<Icon :name>` type-checking.
 */
export type CommandIcon =
  'plus' | 'message-square' | 'hash' | 'search' | 'mail' | 'bell' | 'moon' | 'log-out'

/** One palette action: an id (stable, test-id-bearing), display bits, and a seam. */
export interface PaletteCommand {
  /** Stable identifier — surfaces as `data-testid="palette-command-<id>"`. */
  id: string
  /** Display title, the primary fuzzy-match target. */
  title: string
  /** Leading glyph (a `ui/Icon` name). */
  icon: CommandIcon
  /** Extra fuzzy-match text (synonyms — e.g. "logout" for Sign out). */
  keywords?: string | undefined
  /** Execute the action (the palette closes first; the seam owns the rest). */
  run: () => void
  /** Context gate: `false` hides the command (e.g. needs an active channel). */
  available?: (() => boolean) | undefined
}

/**
 * The shell seams a command may run — implemented by `useShellController`
 * (dialog-open flags, view flips, theme, logout). Injected so the registry
 * stays pure and the controller stays the single owner of shell behavior.
 */
export interface CommandSeams {
  /** Open the existing CreateChannelDialog (the `open-create-channel` flow). */
  openCreateChannel: () => void
  /** Open the existing NewDmDialog (the `open-new-dm` flow). */
  openNewDm: () => void
  /** Open the existing ChannelBrowser (the `open-channel-browser` flow). */
  openChannelBrowser: () => void
  /** Open the ONE unified search modal (SearchOverlay — every entry point). */
  openSearch: () => void
  /** Cycle the theme preference light → dark → system (useTheme). */
  cycleTheme: () => void
  /** Flip the main panel to the Inbox triage view. */
  goToInbox: () => void
  /** Open the Details drawer (its Notifications area) for the active channel. */
  openChannelNotifications: () => void
  /** True while a CHANNEL is the active conversation (gates the command above). */
  hasActiveChannel: () => boolean
  /** The existing logout flow (auth store + redirect to /login). */
  signOut: () => void
}

/** Build the ordered command list over the injected seams. */
export function buildCommands(seams: CommandSeams): PaletteCommand[] {
  return [
    {
      id: 'create-channel',
      title: 'Create channel',
      icon: 'plus',
      keywords: 'new add',
      run: seams.openCreateChannel,
    },
    {
      id: 'start-dm',
      title: 'Start a direct message',
      icon: 'message-square',
      keywords: 'dm compose chat new',
      run: seams.openNewDm,
    },
    {
      id: 'browse-channels',
      title: 'Browse channels',
      icon: 'hash',
      keywords: 'join directory explore',
      run: seams.openChannelBrowser,
    },
    {
      // The id stays 'search-messages' (stable, test-id-bearing); the title is
      // the unified modal's "Search" identity (ENG-152 nav cleanup).
      id: 'search-messages',
      title: 'Search',
      icon: 'search',
      keywords: 'find messages anything',
      run: seams.openSearch,
    },
    {
      id: 'go-inbox',
      title: 'Go to Inbox',
      icon: 'mail',
      keywords: 'unread activity triage',
      run: seams.goToInbox,
    },
    {
      id: 'channel-notifications',
      title: 'Channel notification settings',
      icon: 'bell',
      keywords: 'mute alerts preferences',
      run: seams.openChannelNotifications,
      available: seams.hasActiveChannel,
    },
    {
      id: 'toggle-theme',
      title: 'Toggle theme',
      icon: 'moon',
      keywords: 'dark light system mode appearance',
      run: seams.cycleTheme,
    },
    {
      id: 'sign-out',
      title: 'Sign out',
      icon: 'log-out',
      keywords: 'logout log out',
      run: seams.signOut,
    },
  ]
}
