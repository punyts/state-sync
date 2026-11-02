# Changelog

## 0.3.0
- **Local store and Standalone mode.** The `LocalStore` port with `createWebLocalStore` (over `localStorage`) and `createMemoryLocalStore`. With `localStore` the sync client mounts the saved confirmed state, revision and outbox on start and saves them as they change, coalesced to a microtask; a failed save (a quota error) is reported and sets `saveFailed` in the status while the client keeps running in memory. A client with no `transport` is `standalone`: changes are confirmed at once and kept in the local store. Chromium tests (`npm run test:browser`); the library moves to Vitest 4 (AMM-1813).

## 0.2.0
- **Sync client.** `createSyncClient` keeps the confirmed state and revision and an ordered outbox, shows the confirmed state with the outbox on top through a `StoreBridge`, folds waiting changes, sends `hello` and the outbox on `welcome`, handles `applied`, `adjusted` and `rejected` acks (`onRejected`), catches up again on a revision gap, and reconnects with backoff through a `SyncTransport`, reporting `connecting`, `online` or `offline` and the changes waiting (`onStatus`). `createStoreBridge` is the bridge to a store in the same page, and `applyChange` applies a change with the store's own methods (AMM-1812).

## 0.1.0
- **Changes, messages and capture.** The change and revised change, the sync protocol messages (`hello`, `welcome`, `changes`, `change`, `ack`, `emit`, `error`) with `parseMessage`, which refuses unknown types and keys, wrong shapes, paths that are not sync paths, values that are not JSON and messages past the `SyncLimits`; `isSyncPath`; `captureChanges`, which turns a store's own writes into changes batched to a microtask and folded; and `syncSnapshot` (AMM-1811).
