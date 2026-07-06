// worker/index.ts — public barrel for the stores (ENG-82). The tab side should
// import from here and stay off the transport internals.

export {
  createWorkerClient,
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
} from './types'
