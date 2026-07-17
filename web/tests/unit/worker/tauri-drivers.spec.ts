// ENG-170 (M6-5) — the TS Tauri drivers: each seam implementation must issue
// EXACTLY the right host command + args over the injected IPC bridge (a fake
// `invoke` here; the Rust commands in desktop/src-tauri are cargo-tested
// against the same contracts), re-apply the node-fs fail-closed guards
// client-side (defense-in-depth), and encode/decode binary values across the
// JSON IPC boundary.

import { describe, expect, it, vi } from 'vitest'

import type { WorkspaceManifest } from '../../../src/worker/mirror/seams'
import type { Invoke } from '../../../src/worker/tauri/invoke'
import { TauriBlobCache, TauriEventLog, TauriManifestStore } from '../../../src/worker/tauri/fs'
import { TauriSecretStore } from '../../../src/worker/tauri/secret-store'
import { TauriSqlDriver } from '../../../src/worker/tauri/sql-driver'

/** A recording fake bridge: scripted results keyed by command name. */
function fakeInvoke(results: Record<string, unknown> = {}) {
  const calls: Array<{ cmd: string; args: Record<string, unknown> | undefined }> = []
  const invoke: Invoke = <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args })
    return Promise.resolve(results[cmd] as T)
  }
  return { invoke, calls }
}

const SHA_A = 'a'.repeat(64)

describe('TauriSqlDriver (the SqlDriver seam over sql_*)', () => {
  it('open/execute/select/close issue the right commands and args', async () => {
    const { invoke, calls } = fakeInvoke({ sql_select: [] })
    const driver = await TauriSqlDriver.open('/ws/projections.sqlite3', invoke)
    await driver.execute('CREATE TABLE t (x)')
    await driver.execute('INSERT INTO t VALUES (?)', [42])
    await driver.select('SELECT * FROM t WHERE x = ?', ['y'])
    await driver.close()
    expect(calls.map((c) => c.cmd)).toEqual([
      'sql_open',
      'sql_execute',
      'sql_execute',
      'sql_select',
      'sql_close',
    ])
    expect(calls[0]?.args).toEqual({ path: '/ws/projections.sqlite3' })
    expect(calls[2]?.args).toEqual({
      path: '/ws/projections.sqlite3',
      sql: 'INSERT INTO t VALUES (?)',
      params: [42],
    })
    expect(calls[3]?.args).toMatchObject({ sql: 'SELECT * FROM t WHERE x = ?', params: ['y'] })
    expect(calls[4]?.args).toEqual({ path: '/ws/projections.sqlite3' })
  })

  it('encodes Uint8Array params as byte arrays and decodes BLOB columns back', async () => {
    const { invoke, calls } = fakeInvoke({
      sql_select: [{ id: 1, blob: [7, 8, 9], text: 'hi', nul: null }],
    })
    const driver = await TauriSqlDriver.open('/db', invoke)
    await driver.execute('INSERT INTO t VALUES (?, ?)', [new Uint8Array([1, 2]), null])
    expect(calls[1]?.args?.params).toEqual([[1, 2], null])
    const rows = await driver.select<{ id: number; blob: Uint8Array; text: string; nul: null }>(
      'SELECT *',
    )
    expect(rows[0]?.id).toBe(1)
    expect(rows[0]?.blob).toEqual(new Uint8Array([7, 8, 9]))
    expect(rows[0]?.text).toBe('hi')
    expect(rows[0]?.nul).toBeNull()
  })

  it('brackets transaction() in BEGIN…COMMIT and rolls back on throw', async () => {
    const { invoke, calls } = fakeInvoke({ sql_select: [] })
    const driver = await TauriSqlDriver.open('/db', invoke)
    const result = await driver.transaction(async () => {
      await driver.execute('INSERT 1')
      return 'ok'
    })
    expect(result).toBe('ok')
    const sqls = calls.filter((c) => c.cmd === 'sql_execute').map((c) => c.args?.sql)
    expect(sqls).toEqual(['BEGIN', 'INSERT 1', 'COMMIT'])

    await expect(
      driver.transaction(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    const after = calls.filter((c) => c.cmd === 'sql_execute').map((c) => c.args?.sql)
    expect(after).toEqual(['BEGIN', 'INSERT 1', 'COMMIT', 'BEGIN', 'ROLLBACK'])
  })

  it('serializes concurrent transactions FIFO (never interleaved)', async () => {
    const { invoke, calls } = fakeInvoke({ sql_select: [] })
    const driver = await TauriSqlDriver.open('/db', invoke)
    const first = driver.transaction(async () => {
      await driver.execute('FIRST-A')
      await Promise.resolve() // yield — a second transaction must still wait
      await driver.execute('FIRST-B')
    })
    const second = driver.transaction(async () => {
      await driver.execute('SECOND')
    })
    await Promise.all([first, second])
    const sqls = calls.filter((c) => c.cmd === 'sql_execute').map((c) => c.args?.sql)
    expect(sqls).toEqual(['BEGIN', 'FIRST-A', 'FIRST-B', 'COMMIT', 'BEGIN', 'SECOND', 'COMMIT'])
  })
})

describe('TauriEventLog (the EventLog seam over ndjson_*)', () => {
  it('append issues ndjson_append with root/streamId/month/lines', async () => {
    const { invoke, calls } = fakeInvoke()
    const log = new TauriEventLog('/ws', invoke)
    await log.append('s_abc', '2024-01', ['{"a":1}\n', '{"a":2}\n'])
    expect(calls).toEqual([
      {
        cmd: 'ndjson_append',
        args: {
          root: '/ws',
          streamId: 's_abc',
          month: '2024-01',
          lines: ['{"a":1}\n', '{"a":2}\n'],
        },
      },
    ])
    // Empty appends never cross the bridge.
    await log.append('s_abc', '2024-01', [])
    expect(calls).toHaveLength(1)
  })

  it('re-applies the node-fs fail-closed guards before any IPC', async () => {
    const { invoke, calls } = fakeInvoke()
    const log = new TauriEventLog('/ws', invoke)
    await expect(log.append('../evil', '2024-01', ['{}\n'])).rejects.toThrow(/stream_id/)
    await expect(log.append('s_a', '2024-1', ['{}\n'])).rejects.toThrow(/month/)
    await expect(log.append('s_a', '2024-01', ['{}'])).rejects.toThrow(/newline/)
    await expect(log.append('s_a', '2024-01', ['{}\n{}\n'])).rejects.toThrow(/newline/)
    await expect(log.listMonths('a/b')).rejects.toThrow(/stream_id/)
    await expect(log.readAll('..')).rejects.toThrow(/stream_id/)
    expect(calls).toHaveLength(0)
  })

  it('listMonths/readAll/listStreams issue their commands', async () => {
    const { invoke, calls } = fakeInvoke({
      ndjson_list_months: ['2024-01'],
      ndjson_read_all: ['{"a":1}'],
      ndjson_list_streams: ['s_a'],
    })
    const log = new TauriEventLog('/ws', invoke)
    expect(await log.listMonths('s_a')).toEqual(['2024-01'])
    expect(await log.readAll('s_a')).toEqual(['{"a":1}'])
    expect(await log.listStreams()).toEqual(['s_a'])
    expect(calls.map((c) => c.cmd)).toEqual([
      'ndjson_list_months',
      'ndjson_read_all',
      'ndjson_list_streams',
    ])
    expect(calls[0]?.args).toEqual({ root: '/ws', streamId: 's_a' })
    expect(calls[2]?.args).toEqual({ root: '/ws' })
  })
})

describe('TauriBlobCache (the BlobCache seam over blob_*)', () => {
  it('put/get/has issue their commands with byte-array encoding', async () => {
    const { invoke, calls } = fakeInvoke({ blob_get: [1, 2, 3], blob_has: true })
    const cache = new TauriBlobCache('/ws', invoke)
    await cache.put(SHA_A, new Uint8Array([1, 2, 3]))
    expect(await cache.get(SHA_A)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await cache.has(SHA_A)).toBe(true)
    expect(calls.map((c) => c.cmd)).toEqual(['blob_put', 'blob_get', 'blob_has'])
    expect(calls[0]?.args).toEqual({ root: '/ws', sha256: SHA_A, bytes: [1, 2, 3] })
    expect(calls[1]?.args).toEqual({ root: '/ws', sha256: SHA_A })
  })

  it('get maps a host null to null', async () => {
    const { invoke } = fakeInvoke({ blob_get: null })
    expect(await new TauriBlobCache('/ws', invoke).get(SHA_A)).toBeNull()
  })

  it('rejects malformed keys before any IPC', async () => {
    const { invoke, calls } = fakeInvoke()
    const cache = new TauriBlobCache('/ws', invoke)
    for (const bad of ['abc', 'A'.repeat(64), `sha256:${SHA_A}`, '../etc', '']) {
      await expect(cache.put(bad, new Uint8Array())).rejects.toThrow(/blob key/)
      await expect(cache.get(bad)).rejects.toThrow(/blob key/)
      await expect(cache.has(bad)).rejects.toThrow(/blob key/)
    }
    expect(calls).toHaveLength(0)
  })
})

describe('TauriManifestStore (the ManifestStore seam over manifest_*)', () => {
  const manifest: WorkspaceManifest = {
    format_version: 1,
    workspace_id: 'w_x',
    name: 'acme',
    created_at: '2024-01-01T00:00:00Z',
    local_author: { user_id: 'u_x', device_id: 'd_x' },
    streams: {},
  }

  it('read parses the host JSON text; absent → null', async () => {
    const { invoke } = fakeInvoke({ manifest_read: JSON.stringify(manifest) })
    expect(await new TauriManifestStore('/ws', invoke).read()).toEqual(manifest)
    const absent = fakeInvoke({ manifest_read: null })
    expect(await new TauriManifestStore('/ws', absent.invoke).read()).toBeNull()
  })

  it('write serializes msgctl-style (2-space indent + trailing newline)', async () => {
    const { invoke, calls } = fakeInvoke()
    await new TauriManifestStore('/ws', invoke).write(manifest)
    expect(calls).toEqual([
      {
        cmd: 'manifest_write',
        args: { root: '/ws', json: JSON.stringify(manifest, null, 2) + '\n' },
      },
    ])
  })
})

describe('TauriSecretStore (the SecretStore seam over secret_*)', () => {
  it('get/set/delete issue their commands; get is null-shaped', async () => {
    const { invoke, calls } = fakeInvoke({ secret_get: null })
    const store = new TauriSecretStore(invoke)
    expect(await store.get('msg.session_token')).toBeNull()
    await store.set('msg.session_token', 'tok_1')
    await store.delete('msg.session_token')
    expect(calls).toEqual([
      { cmd: 'secret_get', args: { key: 'msg.session_token' } },
      { cmd: 'secret_set', args: { key: 'msg.session_token', value: 'tok_1' } },
      { cmd: 'secret_delete', args: { key: 'msg.session_token' } },
    ])
  })

  it('propagates a host failure as a rejection (fail-closed, no swallow)', async () => {
    const invoke: Invoke = () => Promise.reject(new Error('keychain get: locked'))
    const store = new TauriSecretStore(invoke)
    await expect(store.get('k')).rejects.toThrow('keychain get: locked')
  })
})

// The bridge indirection itself: worker/tauri/invoke.ts delegates to
// @tauri-apps/api. Mocked here — a jsdom test has no Tauri host.
describe('the invoke indirection', () => {
  it('delegates to @tauri-apps/api core invoke', async () => {
    vi.resetModules()
    const spy = vi.fn().mockResolvedValue('pong')
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: spy }))
    const { invoke } = await import('../../../src/worker/tauri/invoke')
    expect(await invoke('ping', { a: 1 })).toBe('pong')
    expect(spy).toHaveBeenCalledWith('ping', { a: 1 })
    vi.doUnmock('@tauri-apps/api/core')
  })
})
