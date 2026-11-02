# state-sync

State sync for `@punyts/state`: the change, the messages of the sync protocol with their validator, the capture that
turns a store's own writes into changes, and the snapshot a store syncs from. Clients, authorities, the runtime and the
statenet build on it. It has no transport, storage, DOM or Node dependency.

## Changes

```ts
interface Change {
    id: string;                                   // unique; an ack names the change by it
    path: string;                                 // "$."-prefixed
    op: "set" | "replace" | "merge" | "delete";
    value?: JsonValue;                            // absent for delete
    base: number;                                 // the authority revision the client was at
}
interface RevisedChange extends Change { revision: number }   // accepted by the authority, 1 or more
```

- `set` writes the value at the path, `replace` writes it and removes keys it does not have, `merge` writes the keys of
  an object into the object at the path, `delete` removes the path.
- A path is a sync path (`isSyncPath`) when it is a valid `$.`-prefixed store path other than `$`, with no wildcard and
  no `__proto__`, `prototype` or `constructor` segment, and not at or below `$.runtime`. `$.server` paths are valid: an
  app server relays them to the statenet. Capture and the authority keep them from browsers.

## Messages

| type | sent by | fields |
|---|---|---|
| `hello` | client | `namespace`, `revision` (0 for none), `clientId`, `protocol` (1) |
| `welcome` | authority | `namespace`, `revision`, and exactly one of `changes` (since the client's revision) or `snapshot` |
| `changes` | authority | `changes`: revised changes from other clients or server logic |
| `change` | client | `change` |
| `ack` | authority | `id`, `result`: `applied` with `revision`; `adjusted` with `revision` and `value`; `rejected` with `reason` |
| `emit` | either | `name`, optional `value` |
| `error` | either | `code`, `message` |

A namespace is dot-separated segments of letters, digits, `_` and `-` (`apps.orders`).

`parseMessage(input, limits?)` takes the message JSON, or a parsed message (a `postMessage` payload), and returns
`{ ok: true, message }` or `{ ok: false, error }`, where `error` is an `error` message to send back:

- `invalid-json`: the text is not JSON.
- `too-large`: the message is longer than `maxMessageSize` characters.
- `invalid-message`: an unknown type, an unknown or missing key, a wrong shape, a path that is not a sync path, a value
  that is not JSON (`NaN`, `Infinity`, functions, dates, sparse arrays, `__proto__` keys) or a field past its limit.

```ts
const result = parseMessage(text);
if (!result.ok) {
    socket.send(JSON.stringify(result.error));
}
```

`SyncLimits` (defaults in `DEFAULT_SYNC_LIMITS`): `maxMessageSize` 1,000,000; `maxChanges` 1000; `maxDepth` 64;
`maxPathLength` 1024; `maxIdLength` 128 (change ids, client ids, error codes, emit names); `maxReasonLength` 1024 (ack
reasons, error messages); `maxNamespaceLength` 256. Pass any of them to override.

## Capture

```ts
const capture = captureChanges(store, {
    base: () => revision,                         // read when a batch is sent
    onChanges: (changes) => changes.forEach((change) => send({ type: "change", change }))
});
capture.flush();                                  // send what is waiting now
capture.stop();                                   // stop listening, drop what is waiting
```

- `insert` and `update` give a `set` (a `delete` when the value is `undefined`), `replace` a `replace`, `delete` a
  `delete`. `apply` gives a `set` per key. Capture never gives `merge`.
- A write inside an array (an element set, a push, a splice, `store.delete` of an element) gives a `set` of the whole
  array, read when the batch is sent, since splices move every later index.
- No change comes from a write with an origin (apply the authority's changes with `{ origin }`), from `*-child` and
  `relink` events, from alias paths (a write through an alias gives the target path), or from `$.runtime` and
  `$.server`.
- The value is copied as JSON when it is written.
- The changes of a turn are sent together in a microtask, in the order they were made, folded: a change at or below the
  path of a later change in the batch is left out, so setting an object sends one change. Ids and `base` are given when
  the batch is sent; ids come from `crypto.randomUUID` unless `createId` is passed.

## Snapshot

`syncSnapshot(store)` is the state as JSON without `$.runtime` and `$.server`. Aliases are links, not state, so they are
never in it.

## Applying a change

`applyChange(store, change, options?)` applies a change with the store's own methods: `set` with `set`, `replace` with
`replace` (or `set` when the path or the value is not an object or array), `merge` with `apply` (or `set` when there
is nothing to merge into) and `delete` with `delete`. The value is copied first. A set, replace or merge below a
missing parent creates the missing parents as empty objects; a delete below a missing parent does nothing. The client, and the authority later, apply every change this way.

## Sync client

```ts
const client = createSyncClient({
    namespace: "apps.orders",
    bridge: createStoreBridge(store),
    transport,                                    // a SyncTransport, such as a WebSocket adapter; none for standalone
    localStore: createWebLocalStore(),            // keeps the state across reloads
    onStatus: ({ status, waiting, saveFailed }) => { /* standalone, connecting, online, offline; changes waiting */ },
    onRejected: ({ path, reason }) => { /* the value at path is the confirmed one again */ },
    onEmit: (name, value) => { /* a named event from the authority */ }
});
client.start();
```

- **Confirmed state and outbox.** The client keeps the authority's state at its revision and an ordered outbox of the
  store's own changes. The store shows the confirmed state with the outbox on top, so a change shows at once, online or
  offline. Changes from the authority are written through the bridge with the `sync` origin and are never sent back.
- **Folding.** A new change replaces the waiting changes at its path and drops those below it, unless it is a merge.
  The order of the rest is kept. A change already sent is never folded, so each sent change gets its ack.
- **Connecting.** When the connection opens the client sends `hello` with its namespace, revision and client id. On
  `welcome` it takes the snapshot or applies the changes after its revision (a change of its own in them leaves the
  outbox), loads the visible state into the store, and sends the outbox in order.
- **Acks.** `applied` puts the change into the confirmed state; `adjusted` puts the ack value at the path and shows it;
  `rejected` shows the confirmed value at the path again and calls `onRejected`. The change leaves the outbox.
- **Catch-up.** A skipped revision in `changes` sends `hello` again; changes and acks wait for the new `welcome`.
- **Reconnect.** A dropped connection reports `offline` and reconnects after `backoff(attempt)`, 500 ms doubling to
  30 s by default. The status stays `offline` until a connection opens, is `connecting` until `welcome`, and the
  attempt count starts over after `welcome`. Changes the authority had applied before the drop come back by id in the
  catch-up, or are acked again by id when they are resent.
- `initial: { state, revision, outbox }` is mounted into the store on `start`, before connecting; `client.state()`
  returns the same shape to keep. `client.emit(name, value)` sends an event when online and returns `false` otherwise.

### Local store and Standalone

- **Local store.** With `localStore`, the client mounts what it holds for the namespace on `start` (`initial` when it
  holds nothing, or the saved state is not a state and revision), before connecting. Saved outbox changes that are not
  valid changes are skipped.
- **Saving.** The confirmed state and its revision are saved together as the `confirmed` part, the outbox as the
  `outbox` part, each when it changes, coalesced to a microtask, confirmed first. A stop between the two leaves a
  change in both: it is applied again and the authority acks it again by its id. `stop` saves what is pending.
- **Save failures.** A write that throws (a quota error) is reported, sets `saveFailed` in the status, and the client
  keeps running in memory. The part is tried again on the next save; a save that succeeds clears `saveFailed`.
- **Standalone.** A client with no `transport` reports `standalone` and never connects. The local store is the
  authority: each change is confirmed at once and there is no outbox. An outbox a connected run left is confirmed on
  `start`. `$.runtime` and `$.server` are never saved.
- `LocalStore`: `read(namespace, part)`, `write(namespace, part, value)`, `remove(namespace, part)`; the parts are
  `confirmed`, `outbox` and `document` (the app document, kept by the host). `createWebLocalStore(storage?, prefix?)`
  keeps each part as JSON under `<prefix>:<namespace>:<part>` in `localStorage` (prefix `punyts.sync`); a value that is
  not JSON reads as `undefined`. `createMemoryLocalStore()` keeps them in memory.

## Authority

`@punyts/state-sync/authority` is the side that owns a namespace's order of changes, for Node (an app server, the
statenet). It is a separate entry, so a client bundle never includes it; it uses `node:crypto` for `$.server`.

```ts
import { createAuthority, createMemoryNamespaceStorage } from "@punyts/state-sync/authority";

const authority = await createAuthority({ namespace: "apps.orders", storage, initial: { data: {} } });
wss.on("connection", (socket) => {
    const session = authority.connect({ send: (text) => socket.send(text), close: () => socket.close() });
    socket.on("message", (data) => session.receive(String(data)));
    socket.on("close", session.close);
});
```

- **State.** The authority holds the namespace's store, its revision, a log of the last `logLength` changes (1000 by
  default) and the last `appliedLength` applied change ids (10000 by default, never fewer than the log). `initial` is
  the state at revision 0 when the storage holds nothing. `createParents: true` suits a sparse state (only what a user
  changed, such as the articulation of `$.app`): changes and writes below a missing parent create it.
- **hello.** Answered with `welcome`: the logged changes after the client's revision, or a snapshot (no `$.runtime` or
  `$.server`) when the client has nothing (revision 0), is ahead of the authority, is behind the log, or is more than
  `maxChanges` behind. A hello for another namespace is an `error` (`wrong-namespace`) and the connection is closed.
  Another hello on the same connection, the client's catch-up after a gap, is answered the same way.
- **change.** A change before `welcome` is an `error` (`no-hello`). A change id applied before is acked `applied` with
  its revision and not applied again. A change at or below `$.server`, or under a parent that does not exist (any op
  but `delete`, unless the authority was made with `createParents: true`), is acked `rejected`. Otherwise the change is applied with `applyChange` at the next revision, in
  arrival order (stale or not), logged, acked `applied`, and pushed as `changes` to every other welcomed connection.
- **Messages** are handled one at a time in arrival order; every message is checked with `parseMessage`, and a refused
  one is answered with its `error`.
- **Storage.** `NamespaceStorage` is the port: `load(namespace)` and `save(namespace, { state, revision, log, applied
  })`, both async. After each change a save is scheduled, coalesced to a microtask, one save at a time; a failed save is
  reported and the next change saves again. `flush()` waits for the pending saves. `createMemoryNamespaceStorage()` is
  the adapter for tests.
- `authority.revision()`, `authority.state()` (a copy, `$.server` included) and `authority.close()` (closes every
  connection).

### Server logic

```ts
authority.onChange("$.data.expenses.*", ({ change, get, stale, since, clientId }) => {
    if (change.value.amount < 0) {
        return { result: "reject", reason: "amount must be positive" };
    }
    return { result: "adjust", value: { ...change.value, amount: Math.round(change.value.amount) } };
});
authority.onEmit((name, value, clientId) => { /* an app event, not a change */ });
authority.write({ path: "$.data.total", op: "set", value: 42 });   // revision 43, pushed to every client
authority.write({ path: "$.server.token", op: "set", value: token });   // kept and saved, never sent
authority.emit("notice", { text: "saved" });
```

- **Change handlers** are called for a client change at, below or above a path their pattern matches (`*` matches one
  segment). They get a copy of the change as adjusted so far, the client id, `get(path)` for a copy of the current state,
  `since` (the logged changes after the change's base) and `stale` (one of those is at, above or below the change's
  path, or the base is older than the log). They return `undefined` or `{ result: "apply" }`, `{ result: "adjust",
  value }` or `{ result: "reject", reason }`. Handlers run in registration order and are synchronous, so changes stay
  in arrival order. The first reject wins; an adjust makes the change a `set` of the value, acked `adjusted` with it and
  pushed with it. A handler that throws rejects the change (`server logic failed`). `onChange` returns the function
  that removes the handler.
- **Server writes** (`write`) go to any sync path at any time and are not passed to handlers; they may be made from a
  handler. A write outside `$.server` gets the next revision, is logged and pushed to every client, and `write` returns
  the revision. A path that is not a sync path, or whose parent does not exist without `createParents`, throws.
- **`$.server`** never leaves the authority: a client change at or below it is rejected before any handler runs, and a
  server write under it is applied and saved but takes no revision, so it is never logged, pushed or in a `welcome`,
  and clients see no revision gap. Snapshots leave it out.

### `$.server` at rest

```ts
const authority = await createAuthority({ namespace, storage, serverKey: Buffer.from(process.env.SERVER_KEY!, "base64") });
```

- **Encrypted per value.** On every save each direct child of `$.server` is stored as
  `punyts-enc:v1:<base64 of nonce, ciphertext and tag>`: AES-256-GCM with a fresh 12-byte nonce and the 32-byte
  `serverKey`, with `<namespace>:<name>` as additional data, so a value copied to another name or namespace does not
  decrypt. Loading decrypts it; a wrong key, tampered data or an unencrypted value throws
  `Could not decrypt $.server.<name> of <namespace>: …` and the authority is not created, instead of loading garbage.
- **No key, no `$.server`.** Without `serverKey` a server write at or below `$.server` throws, and a stored or
  `initial` state with `$.server` is refused, so nothing is ever saved in plaintext. `$.server` itself must be an
  object of named values.
- **The key stays in memory.** It is never put in the state, the stored namespace or a report. `@punyts/state` reports
  written values under its `state-set-extended` category, so an app server holding secrets does not enable that
  category (or `all`) for a listener that writes to a log.
- `encryptServerBranch` and `decryptServerBranch` are exported for a relay that forwards `$.server` (S1.12).
- **Emit.** A client's `emit` (after `hello`) is handed to each `onEmit` handler with the client id and is not a change;
  a throwing handler is reported. `authority.emit(name, value?)` sends an `emit` to every welcomed client.

## Tests

`npm test` runs the unit tests in Node; `npm run test:browser` runs `*.browser.test.ts` in headless Chromium
(Playwright) against the real `localStorage`: a reload, Standalone across a reload, and a quota error.

### Bridge and transport

- `StoreBridge`: `load(state)` sets every top-level branch and removes the others (`runtime` and `server` stay),
  `write(path, value)` writes one path (`undefined` deletes), `subscribe(onChanges)` gives the store's own changes.
  `createStoreBridge(store)` is the bridge to a store in the same page; a host page reaches a framed runtime with a
  bridge over messages.
- `SyncTransport.connect({ onOpen, onMessage, onClose })` returns `{ send, close }`. Messages are text; the client checks
  every message with `parseMessage` and ignores the ones it refuses. Handlers are called after `connect` returns.
