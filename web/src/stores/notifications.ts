// stores/notifications.ts — notification behavior for new inbound messages
// (ENG-129). CONSUMES the per-channel prefs (ENG-124/126, `all|mentions|mute`,
// set in the Details drawer) + the projection-derived stream state (head_seq /
// unread badges) to decide, per new message, whether to surface an in-app toast
// and — only when the user granted permission — a browser Notification.
//
// New-message detection REUSES the existing signals (no new worker RPCs): the
// workspace store already re-queries `streams.list` on every `{kind:'stream'}` /
// `{kind:'sync'}` push, so this store simply WATCHES `workspace.streams` and, when
// a tracked stream's `head_seq` advances past its high-water mark, reads the new
// rows off the LOCAL `messages.list` projection (zero network). Pending rows
// (`state` set — own optimistic sends with a ms-epoch sentinel seq) and deleted
// rows never notify; the high-water mark only advances off settled seqs/head_seq.
//
// The decision matrix lives in the PURE `shouldNotify` (unit-testable, no DOM):
//   - my own message → never;
//   - the message's stream is the active conversation AND the document is
//     visible (the user is already looking at it) → never;
//   - pref `mute` → never; `mentions` → only an @me mention or a DM;
//     `all` (the default) → any message. DMs + mentions are the high-signal
//     cases: they notify unless the stream is explicitly muted.
//
// SECURITY: toast fields are OPAQUE user content rendered ONLY via Vue text
// interpolation (Toast.vue), and the Notification body is a plain string — no
// HTML is ever built from message text. The store talks exclusively through the
// worker client (never HTTP; the browser Notification API is a UI surface).

import { defineStore, storeToRefs } from 'pinia'
import { computed, ref, watch, type WatchStopHandle } from 'vue'

import { resolveWorkerClient } from '../composables/useWorkerClient'
import { useWorkspaceStore, type SidebarStream } from './workspace'
import type { MessageRow, PrefLevel, PrefsRow, Unsubscribe } from '../worker'

/** One in-app notification toast (text-only fields — rendered via `{{ }}` only). */
export interface ToastItem {
  id: number
  stream_id: string
  /** Where it happened: `# channel` or the DM peer's name. */
  title: string
  /** Who sent it (directory display name, falling back to the user id). */
  author: string
  /** Short text-only preview of the message (truncated, whitespace-collapsed). */
  preview: string
}

/** Browser-permission state, with `unsupported` when `Notification` is absent. */
export type PermissionState = NotificationPermission | 'unsupported'

/** At most this many toasts stack on screen; older ones drop first. */
const MAX_TOASTS = 4
/** How far back one scan reads the head page (a catch-up burst caps here). */
const SCAN_LIMIT = 30
/** Fallback tab title when the document has none at start. */
const FALLBACK_TITLE = 'msg'

/** The inputs of one notify decision — plain data so the matrix is pure. */
export interface NotifyInput {
  streamId: string
  streamKind: string
  authorUserId: string
  mentionsMe: boolean
  level: PrefLevel
  myUserId: string
  activeStreamId: string | null
  documentVisible: boolean
}

/**
 * The ENG-129 decision matrix (pure). Suppress own messages and the
 * conversation the user is actively looking at (active AND visible — an active
 * stream in a HIDDEN tab still notifies); then gate by the stream's pref level.
 */
export function shouldNotify(input: NotifyInput): boolean {
  if (input.authorUserId === input.myUserId) return false
  if (input.streamId === input.activeStreamId && input.documentVisible) return false
  if (input.level === 'mute') return false
  if (input.level === 'mentions') return input.streamKind === 'dm' || input.mentionsMe
  return true
}

/** Text-only preview: collapse whitespace + truncate (never HTML). */
export function previewText(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const useNotificationsStore = defineStore('notifications', () => {
  const workspace = useWorkspaceStore()
  const { streams, directory } = storeToRefs(workspace)

  const toasts = ref<ToastItem[]>([])
  /** Browser Notification permission (`unsupported` when the API is absent). */
  const permission = ref<PermissionState>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )

  const myUserId = ref('')
  /** The stream shown in the conversation panel (null = none / non-conversation view). */
  const activeStreamId = ref<string | null>(null)
  /** Per-stream pref level mirror (`prefs.get` + the `{kind:'prefs'}` push). */
  const prefLevels = ref<Map<string, PrefLevel>>(new Map())

  /** Per-stream high-water mark: the newest seq already seen (never re-notified). */
  const highWater = new Map<string, number>()
  /** False until the first non-empty streams snapshot — that snapshot is baseline. */
  let primed = false
  let started = false
  let nextToastId = 1
  let prefsUnsub: Unsubscribe | undefined
  let stopStreamsWatch: WatchStopHandle | undefined
  let stopTitleWatch: WatchStopHandle | undefined
  /** Shell-registered jump (select stream + flip to the conversation view). */
  let jumpHandler: ((streamId: string) => void) | undefined
  let baseTitle = FALLBACK_TITLE

  /** Total unread across the sidebar's channels + DMs (the tab-title count). */
  const totalUnread = computed(() =>
    [...workspace.channels, ...workspace.dms].reduce((sum, s) => sum + s.unread, 0),
  )

  function applyPrefs(rows: readonly PrefsRow[]): void {
    prefLevels.value = new Map(rows.map((p) => [p.stream_id, p.level]))
  }

  /** The effective level for a stream (absent pref ⇒ `all`, the server default). */
  function levelFor(streamId: string): PrefLevel {
    return prefLevels.value.get(streamId) ?? 'all'
  }

  /** Directory display name for an author (falls back to the raw user id). */
  function authorName(userId: string): string {
    return directory.value.users.find((u) => u.user_id === userId)?.display_name ?? userId
  }

  /**
   * React to a workspace streams snapshot: baseline unseen streams, then scan any
   * tracked stream whose head advanced. A stream DISCOVERED after priming that is
   * a DM with unreads scans from `head − unread` — the first-ever message of a
   * brand-new DM must still notify (the high-signal case).
   */
  async function onStreams(list: readonly SidebarStream[]): Promise<void> {
    const wasPrimed = primed
    if (list.length > 0) primed = true
    const pending: Array<{ stream: SidebarStream; since: number }> = []
    for (const s of list) {
      const prev = highWater.get(s.stream_id)
      if (prev === undefined) {
        const since =
          wasPrimed && s.kind === 'dm' && s.unread > 0
            ? Math.max(0, s.head_seq - s.unread)
            : s.head_seq
        highWater.set(s.stream_id, Math.max(since, s.head_seq))
        if (since < s.head_seq) pending.push({ stream: s, since })
      } else if (s.head_seq > prev) {
        highWater.set(s.stream_id, s.head_seq)
        pending.push({ stream: s, since: prev })
      }
    }
    for (const p of pending) await scan(p.stream, p.since)
  }

  /** Read the stream's head page and notify for settled inbound rows past `since`. */
  async function scan(stream: SidebarStream, since: number): Promise<void> {
    const client = await resolveWorkerClient()
    const res = await client.query({
      q: 'messages.list',
      stream_id: stream.stream_id,
      limit: SCAN_LIMIT,
    })
    const fresh = res.messages
      .filter((m) => m.created_seq > since && m.state === undefined && m.deleted !== true)
      .sort((a, b) => a.created_seq - b.created_seq)
    for (const m of fresh) notifyFor(stream, m)
  }

  /** Run the decision matrix for one new message; toast + (gated) Notification. */
  function notifyFor(stream: SidebarStream, message: MessageRow): void {
    const ok = shouldNotify({
      streamId: stream.stream_id,
      streamKind: stream.kind,
      authorUserId: message.author_user_id,
      mentionsMe: message.mention_user_ids.includes(myUserId.value),
      level: levelFor(stream.stream_id),
      myUserId: myUserId.value,
      activeStreamId: activeStreamId.value,
      documentVisible: typeof document !== 'undefined' && document.visibilityState === 'visible',
    })
    if (!ok) return

    const author = authorName(message.author_user_id)
    const name = stream.name ?? stream.stream_id
    const title = stream.kind === 'dm' ? name : `# ${name}`
    const preview = previewText(message.text)

    toasts.value = [
      ...toasts.value,
      { id: nextToastId++, stream_id: stream.stream_id, title, author, preview },
    ].slice(-MAX_TOASTS)

    fireBrowserNotification(title, `${author}: ${preview}`, stream.stream_id)
  }

  /**
   * Fire a browser Notification ONLY when the API exists and permission is
   * `granted` (never request here — the ask is an explicit user gesture). The
   * body is a plain string; `tag` = stream id so a burst coalesces per stream.
   */
  function fireBrowserNotification(title: string, body: string, streamId: string): void {
    if (typeof Notification === 'undefined') return
    if (Notification.permission !== 'granted') return
    try {
      const n = new Notification(title, { body, tag: streamId })
      n.onclick = () => {
        window.focus()
        jumpTo(streamId)
      }
    } catch {
      // Constructing can throw (e.g. some mobile browsers) — the toast already showed.
    }
  }

  /** Click-to-jump: route through the shell's open-stream (select + conversation). */
  function jumpTo(streamId: string): void {
    if (jumpHandler) jumpHandler(streamId)
    else workspace.selectStream(streamId)
  }

  /** The shell registers its open-stream handler here (toast/Notification click). */
  function setJumpHandler(handler: ((streamId: string) => void) | undefined): void {
    jumpHandler = handler
  }

  /** The shell reports the active conversation (null while on Inbox/scaffolds). */
  function setActiveStream(streamId: string | null): void {
    activeStreamId.value = streamId
  }

  function dismissToast(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id)
  }

  /**
   * The one-time opt-in (a user gesture — never called on load). Updates the
   * mirrored permission state; a no-op when the API is unsupported.
   */
  async function requestPermission(): Promise<void> {
    if (typeof Notification === 'undefined') return
    try {
      permission.value = await Notification.requestPermission()
    } catch {
      permission.value = Notification.permission
    }
  }

  /** Wire prefs + the streams watch + the tab-title count. Idempotent. */
  async function start(userId: string): Promise<void> {
    if (started) return
    started = true
    myUserId.value = userId
    permission.value = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

    // Tab title: `(n) msg` while any unread exists, the plain base title at zero.
    baseTitle = document.title.replace(/^\(\d+\)\s*/, '') || FALLBACK_TITLE
    stopTitleWatch = watch(
      totalUnread,
      (n) => {
        document.title = n > 0 ? `(${n}) ${baseTitle}` : baseTitle
      },
      { immediate: true },
    )

    const client = await resolveWorkerClient()
    // Any prefs change (this tab's set, a cross-device echo) refreshes the gate.
    prefsUnsub = client.subscribe({ kind: 'prefs' }, (payload) => {
      applyPrefs(payload.prefs)
    })
    const res = await client.prefs.get()
    applyPrefs(res.prefs)

    // The existing signal: the workspace store re-queries streams (head_seq +
    // badges) on every stream/sync push — watch it instead of new worker RPCs.
    stopStreamsWatch = watch(streams, (list) => void onStreams(list), { immediate: true })
  }

  function stop(): void {
    prefsUnsub?.()
    prefsUnsub = undefined
    stopStreamsWatch?.()
    stopStreamsWatch = undefined
    if (stopTitleWatch) {
      stopTitleWatch()
      stopTitleWatch = undefined
      document.title = baseTitle
    }
    highWater.clear()
    toasts.value = []
    primed = false
    started = false
    jumpHandler = undefined
  }

  return {
    toasts,
    permission,
    totalUnread,
    activeStreamId,
    start,
    stop,
    setActiveStream,
    setJumpHandler,
    jumpTo,
    dismissToast,
    requestPermission,
  }
})
