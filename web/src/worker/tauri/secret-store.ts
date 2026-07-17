// worker/tauri/secret-store.ts — the real desktop SecretStore (ENG-170, M6-5):
// the OS keychain behind the M6-4 seam, via the Rust `secret_*` commands
// (desktop/src-tauri/src/secret.rs; keyring crate, 0600 app-data-file
// fallback when the keychain is unavailable). The session token therefore
// rests OUTSIDE the portable workspace folder — `SqliteDb.metaPut` refusing
// META_SESSION_TOKEN is the second line of defense behind this store.

import type { SecretStore } from '../secret-store'

import { invoke as defaultInvoke, type Invoke } from './invoke'

export class TauriSecretStore implements SecretStore {
  constructor(private readonly invoke: Invoke = defaultInvoke) {}

  get(key: string): Promise<string | null> {
    return this.invoke('secret_get', { key })
  }

  async set(key: string, value: string): Promise<void> {
    await this.invoke('secret_set', { key, value })
  }

  async delete(key: string): Promise<void> {
    await this.invoke('secret_delete', { key })
  }
}
