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
