// worker/index.ts — public barrel for the stores (ENG-82). The tab side should
// import from here and stay off the transport internals.

export {
  createWorkerClient,
  getWorkerClient,
  makeWorkerClient,
  detectTransportKind,
  type WorkerEnv,
  type CreateWorkerClientOptions,
} from './client'

export {
  PROJECTION_VERSION,
  MAX_CACHED_EVENTS_PER_STREAM,
  type WorkerClient,
  type WorkerStatus,
  type Unsubscribe,
  type Topic,
  type QueryParams,
  type QueryResult,
  type MutateParams,
  type MutateResult,
  type PushPayload,
  type AuthStatus,
  type AuthResult,
  type LoginCredentials,
  type SetupCredentials,
  type AcceptInviteCredentials,
  // ENG-80 projection-query surface (ENG-82 stores read these typed results).
  type MessageRow,
  type StreamRow,
  type StreamBadge,
  type MessagesListResult,
  type StreamsListResult,
  type MessageGetResult,
} from './types'

// ENG-80 projection functions — the ENG-79 apply seam + the ENG-83 dump surface.
export { applyEventsToProjection, dumpMessages } from './projection'

export type { ApiError, ApiResult } from './http'
