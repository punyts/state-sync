# Changelog

## 0.8.0
- **Server logic after a change, batched writes and reads.** `authority.onApplied(handler)` runs server logic after a client change is committed and acknowledged, with the change as applied and the client id. `authority.writeAll(writes)` applies server writes in order and pushes those outside `$.server` in one `changes` message, checking every path first. `authority.get(path)` returns a copy of one value. `captureChanges` takes `origins`, write origins captured besides untagged writes (the writes of local logic).
- Docs: the README describes the three modes (Standalone, Persisted, Full) and has security notes (AMM-1822).

## 0.7.0
- **Sparse states.** `applyChange` creates missing parents as empty objects for a set, replace or merge (a merge with nothing to merge into sets), and a delete below a missing parent does nothing. `createAuthority({ createParents: true })` accepts client changes and server writes below a missing parent instead of rejecting them, for states that hold only what a user changed, such as the articulation of `$.app` (AMM-1819).

## 0.6.0
- **`$.server` encryption at rest.** `createAuthority({ serverKey })` saves each direct child of `$.server` encrypted with AES-256-GCM, a fresh nonce and the namespace and name as additional data, and decrypts it on load; a wrong key or tampered data fails with a clear error. Without a key the authority keeps no `$.server`: a server write there throws and a state holding one is refused. `encryptServerBranch` and `decryptServerBranch` are exported. The authority now needs Node (`node:crypto`) (AMM-1816).

## 0.5.0
- **Server logic.** `authority.onChange(pattern, handler)` registers change handlers for wildcard paths that apply, adjust or reject a client change, with the stale flag and the changes since its base; `adjusted` acks carry the value. `authority.write` makes server writes at the next revision, pushed to every client; writes under `$.server` are kept and saved without a revision and never leave the authority. `authority.onEmit` hands client emits to the app server, and `authority.emit` sends one to every client (AMM-1815).

## 0.4.0
- **Authority.** `@punyts/state-sync/authority`: `createAuthority` owns a namespace's order of changes. It answers `hello` with the logged changes or a snapshot, applies each change at the next revision in arrival order, acks it, pushes it to the other connections, applies a repeated change id once, rejects changes under `$.server` or a missing parent, and saves the state, revision, log and applied ids through the `NamespaceStorage` port (`createMemoryNamespaceStorage` for tests). Connections come in through `authority.connect({ send, close })` (AMM-1814).

## 0.3.0
- **Local store and Standalone mode.** The `LocalStore` port with `createWebLocalStore` (over `localStorage`) and `createMemoryLocalStore`. With `localStore` the sync client mounts the saved confirmed state, revision and outbox on start and saves them as they change, coalesced to a microtask; a failed save (a quota error) is reported and sets `saveFailed` in the status while the client keeps running in memory. A client with no `transport` is `standalone`: changes are confirmed at once and kept in the local store. Chromium tests (`npm run test:browser`); the library moves to Vitest 4 (AMM-1813).

## 0.2.0
- **Sync client.** `createSyncClient` keeps the confirmed state and revision and an ordered outbox, shows the confirmed state with the outbox on top through a `StoreBridge`, folds waiting changes, sends `hello` and the outbox on `welcome`, handles `applied`, `adjusted` and `rejected` acks (`onRejected`), catches up again on a revision gap, and reconnects with backoff through a `SyncTransport`, reporting `connecting`, `online` or `offline` and the changes waiting (`onStatus`). `createStoreBridge` is the bridge to a store in the same page, and `applyChange` applies a change with the store's own methods (AMM-1812).

## 0.1.0
- **Changes, messages and capture.** The change and revised change, the sync protocol messages (`hello`, `welcome`, `changes`, `change`, `ack`, `emit`, `error`) with `parseMessage`, which refuses unknown types and keys, wrong shapes, paths that are not sync paths, values that are not JSON and messages past the `SyncLimits`; `isSyncPath`; `captureChanges`, which turns a store's own writes into changes batched to a microtask and folded; and `syncSnapshot` (AMM-1811).
