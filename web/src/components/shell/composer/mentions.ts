// composer/mentions.ts — the @mention / #channel autocomplete source + wiring.
//
// The candidate list is a ZERO-NETWORK projection read: ShellView loads it from
// the workspace store (`directory.list` over the worker RPC — users folded from
// the workspace-meta event cache, channels from the streams projection) and hands
// it down as a prop. This module never touches the network, the http client, or
// the token — it only FILTERS an in-memory list, which is exactly what keeps the
// autocomplete instant (no round trip per keystroke) and keeps the composer inside
// the no-http-in-ui token boundary.

import { VueRenderer } from '@tiptap/vue-3'
import { PluginKey } from '@tiptap/pm/state'
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'

import MentionList from './MentionList.vue'

/** One autocomplete candidate — a workspace user or a channel. */
export interface MentionItem {
  /** `u_` id for a user; `s_` stream id for a channel. */
  id: string
  /** Display text (the chip label and what the query matches against). */
  label: string
  kind: 'user' | 'channel'
}

/** Case-insensitive prefix-preferring filter over the in-memory candidate list. */
export function filterMentions(
  items: readonly MentionItem[],
  query: string,
  kind: MentionItem['kind'],
  limit = 8,
): MentionItem[] {
  const q = query.trim().toLowerCase()
  const pool = items.filter((i) => i.kind === kind)
  const matches = q.length === 0 ? pool : pool.filter((i) => i.label.toLowerCase().includes(q))
  // Prefix matches first (feels right when typing), then the rest, stable within.
  return [...matches].sort((a, b) => rank(a.label, q) - rank(b.label, q)).slice(0, limit)
}

function rank(label: string, q: string): number {
  if (q.length === 0) return 0
  return label.toLowerCase().startsWith(q) ? 0 : 1
}

/** Lifecycle hooks the suggestion popup toggles so Enter-to-send can defer to it. */
export interface SuggestionLifecycle {
  onOpen: () => void
  onClose: () => void
}

/**
 * Build the @tiptap/suggestion config for one trigger char. Rendering uses
 * `VueRenderer` + a plain floating `<div>` positioned from the caret rect — NO
 * tippy.js (one fewer dependency, smaller bundle, and no external positioning
 * lib to audit). The popup is a controlled Vue component whose keyboard nav
 * (arrow/Enter/Esc) is delegated here via `onKeyDown`.
 */
export function buildSuggestion(
  char: string,
  kind: MentionItem['kind'],
  getItems: () => readonly MentionItem[],
  lifecycle: SuggestionLifecycle,
): Omit<SuggestionOptions<MentionItem>, 'editor'> {
  return {
    char,
    // Distinct plugin key per trigger — two Mention instances (@ and #) share the
    // default `MentionPluginKey` otherwise and collide.
    pluginKey: new PluginKey(`mention-${kind}`),
    items: ({ query }): MentionItem[] => filterMentions(getItems(), query, kind),
    render: () => {
      let component: VueRenderer | undefined
      let popup: HTMLDivElement | undefined

      const place = (rect: DOMRect | null): void => {
        if (!popup || !rect) return
        popup.style.position = 'fixed'
        popup.style.left = `${rect.left}px`
        popup.style.top = `${rect.bottom + 4}px`
        popup.style.zIndex = '50'
      }

      return {
        onStart: (props: SuggestionProps<MentionItem>): void => {
          lifecycle.onOpen()
          component = new VueRenderer(MentionList, { props, editor: props.editor })
          popup = document.createElement('div')
          popup.setAttribute('data-testid', 'mention-popup')
          popup.appendChild(component.element as Node)
          document.body.appendChild(popup)
          place(props.clientRect?.() ?? null)
        },
        onUpdate: (props: SuggestionProps<MentionItem>): void => {
          component?.updateProps(props)
          place(props.clientRect?.() ?? null)
        },
        onKeyDown: (props: { event: KeyboardEvent }): boolean => {
          if (props.event.key === 'Escape') {
            return true // let the plugin close; onExit tears down + flips lifecycle
          }
          const ref = component?.ref as { onKeyDown?: (e: KeyboardEvent) => boolean } | undefined
          return ref?.onKeyDown?.(props.event) ?? false
        },
        onExit: (): void => {
          lifecycle.onClose()
          popup?.remove()
          popup = undefined
          component?.destroy()
          component = undefined
        },
      }
    },
  }
}
