/** What a transport calls while a connection lives */
export interface TransportHandlers {
    /** The connection is open and can send */
    onOpen: () => void;
    /** A message arrived: text (a WebSocket text frame) or bytes (a binary frame), as `createSyncWire` reads them */
    onMessage: (data: string | Uint8Array) => void;
    /** The connection closed or could not open; it is not used again */
    onClose: () => void;
}

/** One connection to an authority */
export interface TransportConnection {
    /** Sends a message as the sync wire wrote it: text as a text frame, bytes as a binary frame */
    send: (data: string | Uint8Array) => void;
    close: () => void;
}

/** The port the sync client connects through: a WebSocket in a browser, a fake in tests */
export interface SyncTransport {
    connect: (handlers: TransportHandlers) => TransportConnection;
}
