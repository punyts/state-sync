/** What a transport calls while a connection lives */
export interface TransportHandlers {
    /** The connection is open and can send */
    onOpen: () => void;
    /** A message arrived, as text */
    onMessage: (text: string) => void;
    /** The connection closed or could not open; it is not used again */
    onClose: () => void;
}

/** One connection to an authority */
export interface TransportConnection {
    send: (text: string) => void;
    close: () => void;
}

/** The port the sync client connects through: a WebSocket in a browser, a fake in tests */
export interface SyncTransport {
    connect: (handlers: TransportHandlers) => TransportConnection;
}
