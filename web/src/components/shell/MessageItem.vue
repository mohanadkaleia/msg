<script setup lang="ts">
// MessageItem — one rendered message (ENG-82, extended for M3 interactions ENG-102).
//
// SECURITY (critical): `text`, author names, reaction `emoji` and who-reacted
// display names are ALL other users' input — reaction `emoji` is OPAQUE BYTES that
// can carry control chars. Every one of them is rendered ONLY through Vue text
// interpolation ({{ }}), which HTML-escapes. There is NO v-html, no innerHTML, no
// dynamic template compilation, and no raw-HTML sink anywhere in this component.
//
// M3 additions (ENG-102): aggregated reaction chips (emoji + count + who-reacted
// tooltip) with an idempotent optimistic toggle; a hover toolbar with quick
// reactions + an emoji picker; inline EDIT and soft-DELETE affordances on your OWN
// messages (author-gated in-UI; the server enforces too); an "edited" marker; and
// a TOMBSTONE render for a deleted message. Delete is a SOFT delete (ENG-111) —
// the confirm is worded honestly ("removed for everyone"), never as a permanent
// cryptographic erasure.
import { computed, ref, watch } from 'vue'

import type { DisplayMessage } from '../../stores/messages'
import { useAttachments } from '../../composables/useAttachments'
import { formatTime } from '../../lib/time'
import type { FileRow } from '../../worker'
import EmojiPicker from '../ui/EmojiPicker.vue'
import Icon from '../ui/Icon.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import UserPopover from '../ui/UserPopover.vue'
import AttachmentFile from './AttachmentFile.vue'
import AttachmentImage from './AttachmentImage.vue'
import ReactionPill from './ReactionPill.vue'
import ThreadSummary from './ThreadSummary.vue'

const props = withDefaults(
  defineProps<{
    message: DisplayMessage
    /** True while this row is the active inline-edit target (owned by the parent). */
    editing?: boolean
    /**
     * Show the row's avatar + name + time header line (ENG-136). False when this
     * message is GROUPED under the previous row (same author, within ~5 min): the
     * avatar/name/time are hidden and the content aligns under the group's first row.
     */
    showHeader?: boolean
    /**
     * Directory `user_id → display_name` map for resolving the author's name +
     * avatar initial. Falls back to the raw id when a name is absent.
     */
    names?: ReadonlyMap<string, string> | undefined
    /**
     * Directory `user_id → avatar_sha256` map (ENG-152): when the author has an
     * avatar, the leading chip renders their IMAGE (fetched worker-side by
     * id + sha) instead of the initial. Absent → initials, as before.
     */
    avatars?: ReadonlyMap<string, string> | undefined
    /**
     * Briefly highlight this row (ENG-127 search jump-to-message): a tinted
     * background the parent clears after a moment. Purely visual.
     */
    flash?: boolean
    /**
     * Read-only rendering context (ENG-152 PR-c — the Inbox preview pane): the
     * hover action toolbar, the add-reaction pill, the thread affordance, and
     * retry/discard are NOT rendered, and reaction chips are non-interactive —
     * the preview wires none of their emits, so showing them would present dead
     * buttons. Message content (text, attachments, chips, markers) still renders.
     */
    readonly?: boolean
  }>(),
  {
    editing: false,
    showHeader: true,
    names: undefined,
    avatars: undefined,
    flash: false,
    readonly: false,
  },
)

const emit = defineEmits<{
  retry: [messageId: string]
  discard: [messageId: string]
  /** Toggle a reaction: `remove` is the caller's read of the current membership. */
  react: [messageId: string, emoji: string, remove: boolean]
  /** Request inline edit of this (own) message. */
  'edit-start': [messageId: string]
  /** Commit the inline edit. */
  'edit-submit': [messageId: string, text: string]
  /** Abandon the inline edit. */
  'edit-cancel': []
  /** Soft-delete this (own) message (already confirmed in-UI). */
  delete: [messageId: string]
  /**
   * Open the thread pane targeting `rootMessageId` (ENG-103). Fired by the
   * reply-count affordance (target = this root) and by "Reply in thread" (target =
   * this message when it is a non-reply root, else its `thread_root_id` — a
   * reply-of-reply is server-rejected, so a reply threads under its own root).
   */
  'open-thread': [rootMessageId: string]
}>()

/** Quick one-click reactions in the hover toolbar. Safe literal emoji. */
const QUICK_REACTIONS = ['👍', '❤️', '😂'] as const

const isPending = computed(() => props.message.state === 'pending')
const isFailed = computed(() => props.message.state === 'failed')
const isDeleted = computed(() => props.message.deleted === true)
const isSettled = computed(() => props.message.state === undefined)
const isEdited = computed(() => props.message.edited_seq !== undefined)
/** Author-or-admin is enforced server-side; in-UI we gate on ownership + a live row. */
const canModify = computed(() => props.message.mine && isSettled.value && !isDeleted.value)
/** Reactions are only meaningful on a live (non-deleted) row — and never in a
 * read-only context (the preview pane wires no reaction emits). */
const canReact = computed(() => isSettled.value && !isDeleted.value && !props.readonly)
/** Retry/Delete of a failed SEND are only actionable while we hold its outbox id
 * AND a parent that wires the emits (not the read-only preview). */
const canAct = computed(() => props.message.eventId !== undefined && !props.readonly)
const time = computed(() => formatTime(props.message.ts))
const reactions = computed(() => props.message.reactions ?? [])
/** Thread affordance (ENG-103): a root shows its reply count + participant avatars. */
const replyCount = computed(() => props.message.reply_count ?? 0)
const isThreadRoot = computed(() => replyCount.value > 0)
const participants = computed(() => props.message.threadParticipants ?? [])
/**
 * The root a "Reply in thread" from THIS message threads under: a non-reply
 * message is its own root; a reply threads under its `thread_root_id` (D7 rejects
 * a reply-of-reply). Keeps the client from ever composing an illegal root.
 */
const threadTarget = computed(() => props.message.thread_root_id ?? props.message.message_id)

/**
 * Attachments (ENG-121): resolve this message's `file_ids` against the LOCAL
 * `attachments.forMessage` projection (ZERO network). An empty `file_ids` never
 * touches the worker. Rendering branches image-vs-card on `mime_type` (a boolean
 * use) — the mime type is never itself rendered into a sink.
 */
const attachmentFileIds = computed(() => props.message.file_ids ?? [])
const { files: attachmentFiles, pendingFileIds } = useAttachments(
  props.message.message_id,
  attachmentFileIds,
)
const hasAttachments = computed(
  () => attachmentFiles.value.length > 0 || pendingFileIds.value.length > 0,
)
function isImage(file: FileRow): boolean {
  return file.mime_type.startsWith('image/')
}

/** Author's resolved display name (directory-backed; raw id fallback). */
const authorName = computed(
  () => props.names?.get(props.message.author_user_id) ?? props.message.author_user_id,
)
/** Author's avatar ref (ENG-152) — undefined = no avatar → initials chip. */
const authorAvatarSha = computed(() => props.avatars?.get(props.message.author_user_id))

const pickerOpen = ref(false)
/** The trailing "add reaction" ghost pill's picker (separate anchor; one open at a time). */
const addPickerOpen = ref(false)
const confirmingDelete = ref(false)
const draft = ref('')

// Seed the inline-edit draft with the current text whenever this row enters edit
// mode — covers BOTH entry paths (the toolbar Edit button and the composer's
// ArrowUp→edit-last, which flips `editing` without a local click).
watch(
  () => props.editing,
  (editing) => {
    if (editing) draft.value = props.message.text
  },
  { immediate: true },
)

/** " (code)" suffix for a rejected send, or "". */
function formatCode(code: string | undefined): string {
  return code ? ` (${code})` : ''
}

/** Toggle YOUR reaction — idempotent: an active (mine) reaction is removed. */
function toggleReaction(emoji: string, mine: boolean): void {
  emit('react', props.message.message_id, emoji, mine)
}

/** Add-or-remove from the toolbar/picker: remove iff I already reacted with it. */
function pickReaction(emoji: string): void {
  const mine = reactions.value.some((r) => r.emoji === emoji && r.mine)
  toggleReaction(emoji, mine)
  pickerOpen.value = false
  addPickerOpen.value = false
}

function startEdit(): void {
  emit('edit-start', props.message.message_id)
}

function submitEdit(): void {
  const text = draft.value.trim()
  if (text.length === 0) {
    emit('edit-cancel')
    return
  }
  emit('edit-submit', props.message.message_id, text)
}

/** Enter commits, Shift-Enter is a newline, Escape cancels (composer parity). */
function onEditKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submitEdit()
  } else if (event.key === 'Escape') {
    event.preventDefault()
    emit('edit-cancel')
  }
}

function confirmDelete(): void {
  confirmingDelete.value = false
  emit('delete', props.message.message_id)
}
</script>

<template>
  <div
    class="group relative flex gap-3 px-4 py-0.5 transition-colors hover:bg-surface"
    :class="{ 'opacity-50': isPending, 'bg-accent-subtle': props.flash }"
    data-testid="message-row"
    :data-state="props.message.state ?? 'settled'"
    :data-message-id="props.message.message_id"
  >
    <!-- Avatar gutter (40px + the row's gap-3 = a ~52px content indent). The
         avatar shows only on a group's LEADING row; a grouped follow-up keeps the
         (empty) gutter so its text aligns under the first message's text. -->
    <div class="w-10 shrink-0" data-testid="message-gutter">
      <!-- No presence dot on message rows (ENG-152 conversation-pane cleanup):
           live presence stays on the sidebar/DM header/people pickers only. It
           surfaces on demand via the UserPopover hovercard; a click opens the
           right-drawer user-details panel. -->
      <UserPopover
        v-if="props.showHeader && !isDeleted"
        :user-id="props.message.author_user_id"
        :name="authorName"
      >
        <UserAvatar
          class="flex h-10 w-10 items-center justify-center rounded-full bg-accent-subtle text-sm font-semibold text-accent"
          data-testid="message-avatar"
          :title="authorName"
          aria-hidden="true"
          :user-id="props.message.author_user_id"
          :name="authorName"
          :sha="authorAvatarSha"
        />
      </UserPopover>
    </div>

    <!-- Content column — aligns under the avatar for both leading + grouped rows. -->
    <div class="min-w-0 flex-1">
      <!-- TOMBSTONE (ENG-102/ENG-111): a soft-deleted message. Content is redacted
           projection-side; we render only a muted marker, never the old text. -->
      <p v-if="isDeleted" class="text-sm italic text-muted" data-testid="message-tombstone">
        message deleted
      </p>

      <template v-else>
        <div v-if="props.showHeader" class="flex items-baseline gap-2">
          <UserPopover :user-id="props.message.author_user_id" :name="authorName">
            <span class="text-sm font-semibold text-primary" data-testid="message-author">{{
              authorName
            }}</span>
          </UserPopover>
          <span class="text-xs text-muted" data-testid="message-time">
            <template v-if="isPending">Sending…</template>
            <template v-else>{{ time }}</template>
          </span>
          <span v-if="isEdited" class="text-xs text-muted" data-testid="edited-marker">
            (edited)
          </span>
        </div>

        <!-- INLINE EDIT (own message) — plain textarea, serialized as source text. -->
        <div v-if="props.editing" class="mt-1" data-testid="message-edit">
          <textarea
            v-model="draft"
            rows="2"
            class="w-full resize-y rounded-md border border-strong px-2 py-1 text-sm text-primary outline-none focus:border-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            data-testid="message-edit-input"
            @keydown="onEditKeydown"
          ></textarea>
          <div class="mt-1 flex items-center gap-2 text-xs">
            <button
              type="button"
              class="rounded bg-accent px-2 py-0.5 font-medium text-accent-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="message-edit-save"
              @click="submitEdit"
            >
              Save
            </button>
            <button
              type="button"
              class="font-medium text-secondary hover:text-primary"
              data-testid="message-edit-cancel"
              @click="emit('edit-cancel')"
            >
              Cancel
            </button>
            <span class="text-muted">Enter to save · Esc to cancel</span>
          </div>
        </div>

        <!-- Plain text ONLY — Vue interpolation escapes; never v-html (XSS). On a
             GROUPED follow-up the header (with its "(edited)" marker) is hidden, so
             the marker renders inline here instead — always visible, exactly one in
             the DOM (the header + inline variants are mutually exclusive on showHeader). -->
        <p
          v-else
          class="whitespace-pre-wrap break-words text-sm text-primary"
          data-testid="message-text"
        >
          {{ props.message.text }}
        </p>
        <span
          v-if="!props.editing && !props.showHeader && isEdited"
          class="text-xs text-muted"
          data-testid="edited-marker"
        >
          (edited)
        </span>

        <!-- Attachments (ENG-121). Resolved from the local `attachments.forMessage`
           projection. image (by mime_type) → thumbnail + lightbox; other → file
           card + download; not-yet-projected ids → a muted pending placeholder.
           Names/sizes are attacker-controlled and render ONLY via text / :alt. -->
        <div
          v-if="hasAttachments"
          class="mt-1 flex flex-col gap-1.5"
          data-testid="message-attachments"
        >
          <template v-for="file in attachmentFiles" :key="file.file_id">
            <AttachmentImage v-if="isImage(file)" :file="file" />
            <AttachmentFile v-else :file="file" />
          </template>
          <div
            v-for="id in pendingFileIds"
            :key="id"
            class="flex h-10 max-w-sm items-center rounded-md border border-dashed border-subtle px-3 text-xs italic text-muted"
            data-testid="attachment-pending"
          >
            attachment loading…
          </div>
        </div>

        <!-- Reaction pills (aggregated, present-only). Clicking toggles YOUR reaction;
           the trailing ghost pill opens the shared EmojiPicker to add a new one. -->
        <div v-if="reactions.length > 0" class="mt-1 flex flex-wrap items-center gap-1">
          <ReactionPill
            v-for="chip in reactions"
            :key="chip.emoji"
            :chip="chip"
            :disabled="!canReact"
            @toggle="toggleReaction"
          />
          <div v-if="canReact" class="relative">
            <button
              type="button"
              class="inline-flex items-center gap-0.5 rounded-full border border-subtle bg-surface px-2 py-0.5 text-xs text-secondary hover:bg-surface-elevated focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="add-reaction"
              aria-label="Add reaction"
              @click="addPickerOpen = !addPickerOpen"
            >
              <Icon name="smile" :size="14" />
              <span aria-hidden="true">+</span>
            </button>
            <EmojiPicker
              v-if="addPickerOpen"
              class="absolute left-0 top-full z-30 mt-1"
              menu-testid="reaction-picker-menu"
              option-testid="reaction-option"
              @select="pickReaction"
            />
          </div>
        </div>

        <!-- Thread summary (ENG-103): overlapping participant avatars + reply count on
           a root. Click opens the thread pane — suppressed in the read-only
           preview where nothing wires `open-thread`. -->
        <ThreadSummary
          v-if="isThreadRoot && !props.readonly"
          :reply-count="replyCount"
          :participants="participants"
          @open="emit('open-thread', props.message.message_id)"
        />

        <!-- Hover toolbar: quick reactions + emoji picker + (own) edit/delete. -->
        <div
          v-if="canReact && !props.editing"
          class="absolute right-3 top-0 z-10 -mt-2 hidden items-center gap-0.5 rounded-md border border-subtle bg-surface-elevated px-1 py-0.5 shadow-sm group-hover:flex"
          data-testid="message-toolbar"
        >
          <button
            v-for="emoji in QUICK_REACTIONS"
            :key="emoji"
            type="button"
            class="rounded px-1 text-sm hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            data-testid="reaction-quick"
            :data-emoji="emoji"
            @click="pickReaction(emoji)"
          >
            {{ emoji }}
          </button>
          <div class="relative">
            <button
              type="button"
              class="rounded px-1 text-sm text-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="reaction-picker"
              aria-label="Add reaction"
              @click="pickerOpen = !pickerOpen"
            >
              +
            </button>
            <EmojiPicker
              v-if="pickerOpen"
              class="absolute right-0 top-full z-30 mt-1"
              menu-testid="reaction-picker-menu"
              option-testid="reaction-option"
              @select="pickReaction"
            />
          </div>
          <button
            type="button"
            class="rounded px-1 text-xs text-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            data-testid="reply-in-thread"
            aria-label="Reply in thread"
            @click="emit('open-thread', threadTarget)"
          >
            Reply
          </button>
          <template v-if="canModify">
            <button
              type="button"
              class="rounded px-1 text-xs text-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="message-edit"
              aria-label="Edit message"
              @click="startEdit"
            >
              Edit
            </button>
            <button
              type="button"
              class="rounded px-1 text-xs text-secondary hover:bg-surface-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              data-testid="message-delete"
              aria-label="Delete message"
              @click="confirmingDelete = true"
            >
              Delete
            </button>
          </template>
        </div>

        <!-- Soft-delete confirm (ENG-111 honest labeling: removed for everyone, NOT
           a permanent/unrecoverable erasure — the log retains it). -->
        <div
          v-if="confirmingDelete"
          class="mt-1 flex items-center gap-2 rounded-md border border-subtle bg-surface px-2 py-1 text-xs"
          data-testid="message-delete-confirm"
        >
          <span class="text-secondary">Delete message? It will be removed for everyone.</span>
          <button
            type="button"
            class="rounded bg-danger px-2 py-0.5 font-medium text-danger-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            data-testid="message-delete-confirm-yes"
            @click="confirmDelete"
          >
            Delete
          </button>
          <button
            type="button"
            class="font-medium text-secondary hover:text-primary"
            data-testid="message-delete-cancel"
            @click="confirmingDelete = false"
          >
            Cancel
          </button>
        </div>

        <div
          v-if="isFailed"
          class="mt-1 flex items-center gap-2 text-xs"
          data-testid="message-failed"
        >
          <span class="text-danger">
            Failed to send{{ formatCode(props.message.error_code) }}
          </span>
          <template v-if="canAct">
            <button
              type="button"
              class="font-medium text-secondary underline hover:text-primary"
              data-testid="message-retry"
              @click="emit('retry', props.message.message_id)"
            >
              Retry
            </button>
            <button
              type="button"
              class="font-medium text-secondary underline hover:text-primary"
              data-testid="message-failed-discard"
              @click="emit('discard', props.message.message_id)"
            >
              Discard
            </button>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>
