# Changelog

## 0.1.0
- **Changes, messages and capture.** The change and revised change, the sync protocol messages (`hello`, `welcome`, `changes`, `change`, `ack`, `emit`, `error`) with `parseMessage`, which refuses unknown types and keys, wrong shapes, paths that are not sync paths, values that are not JSON and messages past the `SyncLimits`; `isSyncPath`; `captureChanges`, which turns a store's own writes into changes batched to a microtask and folded; and `syncSnapshot` (AMM-1811).
