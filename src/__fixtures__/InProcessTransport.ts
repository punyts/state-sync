import type { Authority, AuthoritySession } from "../authority/Authority.js";
import type { SyncTransport } from "../Transport.js";

/**
 * A transport from sync clients to an authority in the same process, for tests. Every delivery waits for a timer, as a
 * socket would, and drop() closes every open connection from the client side.
 */
export const createInProcessTransport = (authority: Authority) => {
    const open = new Set<{ session: AuthoritySession; onClose: () => void; closed: boolean }>();

    const transport: SyncTransport = {
        connect: (handlers) => {
            const link = {
                closed: false,
                onClose: handlers.onClose,
                session: authority.connect({
                    send: (text) => setTimeout(() => !link.closed && handlers.onMessage(text), 0),
                    close: () => {
                        if (!link.closed) {
                            link.closed = true;
                            open.delete(link);
                            setTimeout(handlers.onClose, 0);
                        }
                    }
                })
            };
            open.add(link);
            setTimeout(() => !link.closed && handlers.onOpen(), 0);
            return {
                send: (text) => {
                    setTimeout(() => !link.closed && link.session.receive(text), 0);
                },
                close: () => {
                    link.closed = true;
                    open.delete(link);
                    link.session.close();
                }
            };
        }
    };

    return {
        transport,
        /** Drops every open connection, as a network failure would */
        drop: () => {
            for (const link of [...open]) {
                link.closed = true;
                open.delete(link);
                link.session.close();
                setTimeout(link.onClose, 0);
            }
        }
    };
};

/** Waits until timers and microtasks have run for a while */
export const settle = async (rounds = 20) => {
    for (let round = 0; round < rounds; round++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};
