import type { Access } from "../authority/Grants.js";
import type { Authority } from "../authority/Authority.js";
import type { SyncMessage } from "../Messages.js";
import { createSyncWire } from "../Wire.js";

/**
 * A client connection to an authority for tests that write messages as JSON: it sends each through a sync wire as
 * protocol 4 does, and hands back what the authority sends as parsed messages. Text that is not a message JSON can
 * carry as the wire would (not JSON, or no known type) goes through as it is, so a test can still send a bad one
 */
export const connectJson = (
    authority: Pick<Authority, "connect">,
    onMessage: (message: SyncMessage) => void,
    close: () => void,
    access?: Access
) => {
    const wire = createSyncWire();
    const session = authority.connect(
        {
            send: (data) => {
                const parsed = wire.read(data);
                if (!parsed.ok) throw new Error(`the authority sent what the wire cannot read: ${parsed.error.message}`);
                onMessage(parsed.message);
            },
            close
        },
        access
    );
    return {
        receive: (text: string) => {
            let message: SyncMessage;
            try {
                message = JSON.parse(text) as SyncMessage;
            }
            catch {
                session.receive(text);
                return;
            }
            try {
                session.receive(wire.write(message));
            }
            catch {
                session.receive(text);
            }
        },
        close: () => session.close()
    };
};
