import { afterEach, describe, expect, it } from "vitest";
import { addListener, clearListeners, setCategories } from "@punyts/core";
import { createStore } from "@punyts/state";
import { createStoreBridge } from "./Bridge.js";
import { createSyncClient } from "./Client.js";
import { createInProcessTransport, settle } from "./__fixtures__/InProcessTransport.js";
import { createAuthority } from "./authority/Authority.js";
import { createMemoryNamespaceStorage } from "./authority/NamespaceStorage.js";
import { createAuthorityUpstream, createRelay } from "./authority/Relay.js";

const NAMESPACE = "apps.orders";
const SECRET = "card-4242-secret";

interface Heard {
    category: string;
    message: string;
}

const listen = (): Heard[] => {
    const heard: Heard[] = [];
    setCategories(["state-sync.*"]);
    addListener((_timestamp, category, message) => heard.push({ category, message }), ["state-sync.*"]);
    return heard;
};

const messagesOf = (heard: Heard[], category: string) => heard.filter((entry) => entry.category === category).map((entry) => entry.message);

describe("reporting", () => {
    afterEach(() => {
        setCategories(["info", "error", "stack"]);
        clearListeners();
    });

    it("should report the client, capture and authority by path, revision and count, and never a value", async () => {
        // Arrange
        const heard = listen();
        const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), initial: { data: { total: 1 } } });
        const { transport } = createInProcessTransport(authority);
        const writerStore = createStore<any>({});
        const readerStore = createStore<any>({});
        const writer = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(writerStore), transport, clientId: "writer", backoff: () => 0 });
        const reader = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(readerStore), transport, clientId: "reader", backoff: () => 0 });
        writer.start();
        reader.start();
        await settle();

        // Act
        writerStore.set("$.data.card", SECRET);
        await settle();
        await authority.flush();
        writer.stop();
        reader.stop();
        authority.close();

        // Assert
        const client = messagesOf(heard, "state-sync.client");
        expect(client).toContain(`Started ${NAMESPACE} from nothing at revision 0 with 0 changes waiting`);
        expect(client).toContain(`Connecting to the authority of ${NAMESPACE}`);
        expect(client).toContain(`Sent hello for ${NAMESPACE} at revision 0 with 0 changes waiting`);
        expect(client).toContain(`Welcomed to ${NAMESPACE} at revision 0 with a snapshot, 0 changes waiting`);
        expect(client).toContain(`Queued 1 local changes of ${NAMESPACE}: $.data.card`);
        expect(client).toContain(`Sent 1 changes of ${NAMESPACE}: $.data.card`);
        expect(client).toContain(`The authority applied the change of ${NAMESPACE} at $.data.card`);
        expect(client).toContain(`Applying 1 changes to ${NAMESPACE}: $.data.card@1`);
        expect(client).toContain(`Stopped ${NAMESPACE} at revision 1 with 0 changes waiting`);
        expect(messagesOf(heard, "state-sync.capture")).toContain("Captured 1 changes (0 writes folded): set $.data.card");
        const authorityReports = messagesOf(heard, "state-sync.authority");
        expect(authorityReports.some((message) => /^Loaded apps\.orders at revision 0 from the initial state in [\d.]+ ms, 0 changes logged$/.test(message))).toBe(true);
        expect(authorityReports).toContain(`A client connected to ${NAMESPACE}: 2 connections`);
        expect(authorityReports).toContain(`Welcomed client writer to ${NAMESPACE} at revision 0 with a snapshot (protocol 2)`);
        expect(authorityReports).toContain(`Applied the set of client writer at $.data.card in ${NAMESPACE} at revision 1`);
        expect(authorityReports.some((message) => /^Saved apps\.orders at revision 1 in [\d.]+ ms$/.test(message))).toBe(true);
        expect(authorityReports).toContain(`Closed ${NAMESPACE} at revision 1 with 0 connections`);
        expect(JSON.stringify(heard)).not.toContain(SECRET);
    });

    it("should report a relay's upstream subscription, its listeners and the changes it passes on, and never a value", async () => {
        // Arrange
        const heard = listen();
        const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), initial: { data: { total: 1 } } });
        const relay = createRelay(createAuthorityUpstream(async () => authority), { sweep: false });
        const subscription = relay.subscribe("owner/app/scope", "$.data", undefined, { welcome: () => undefined, changes: () => undefined });
        await settle();

        // Act
        authority.write({ path: "$.data.card", op: "set", value: SECRET });
        await settle();
        subscription.close();
        relay.close();
        authority.close();

        // Assert
        const reports = messagesOf(heard, "state-sync.relay");
        expect(reports).toContain("A first listener of owner/app/scope $.data from revision 0");
        expect(reports).toContain("Subscribing upstream to owner/app/scope $.data for a snapshot");
        expect(reports).toContain("Upstream welcomed owner/app/scope $.data at revision 0 with a snapshot, 1 listeners");
        expect(reports).toContain("Passing 1 changes of owner/app/scope $.data to 1 listeners: $.data.card@1");
        expect(reports).toContain("Dropped owner/app/scope $.data: no listeners");
        expect(messagesOf(heard, "state-sync.authority")).toContain(`Server wrote set $.data.card in ${NAMESPACE} at revision 1`);
        expect(JSON.stringify(heard)).not.toContain(SECRET);
    });
});
