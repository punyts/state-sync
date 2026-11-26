import { connectJson } from "../__fixtures__/Wired.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { report } from "@punyts/core";
import { copyJson } from "../Apply.js";
import type { SyncMessage } from "../Messages.js";
import { createAuthority } from "./Authority.js";
import { createMemoryNamespaceStorage } from "./NamespaceStorage.js";

vi.mock("@punyts/core", async (original) => ({ ...(await original<typeof import("@punyts/core")>()), report: vi.fn() }));

const NAMESPACE = "apps.signin";
const STATE = { app: { password: { value: "" } }, data: {} };

const hello = (revision = 0) => JSON.stringify({ type: "hello", namespace: NAMESPACE, revision, clientId: "c", protocol: 4 });

const setup = async () => {
    const storage = createMemoryNamespaceStorage();
    const authority = await createAuthority({ namespace: NAMESPACE, storage, initial: copyJson(STATE), secret: ["$.app.password.value"] });
    const join = () => {
        const received: SyncMessage[] = [];
        const session = connectJson(authority, (message) => received.push(message), vi.fn());
        session.receive(hello(0));
        return { received, session };
    };
    return { authority, storage, join };
};

afterEach(() => {
    vi.mocked(report).mockClear();
});

describe("createAuthority with secret paths", () => {
    it("should hand a secret change to server logic and keep nothing of it", async () => {
        // Arrange
        const { authority, storage, join } = await setup();
        const seen: unknown[] = [];
        authority.onApplied((change) => seen.push(change.value));
        const writer = join();
        const other = join();

        // Act
        writer.session.receive(JSON.stringify({ type: "change", change: { id: "s1", path: "$.app.password.value", op: "set", value: "hunter2", base: 0 } }));
        await authority.flush();

        // Assert
        expect(seen).toEqual(["hunter2"]);
        expect(writer.received.at(-1)).toEqual({ type: "ack", id: "s1", result: "passed" });
        expect(other.received.filter((message) => message.type === "changes")).toEqual([]);
        expect(authority.state()).toEqual(STATE);
        expect(JSON.stringify((await storage.load(NAMESPACE)) ?? {})).not.toContain("hunter2");
        expect(JSON.stringify(vi.mocked(report).mock.calls)).not.toContain("hunter2");
    });

    it("should still apply and push a change beside a secret path", async () => {
        // Arrange
        const { authority, join } = await setup();
        const writer = join();
        const other = join();

        // Act
        writer.session.receive(JSON.stringify({ type: "change", change: { id: "p1", path: "$.app.password.label", op: "set", value: "Password", base: 0 } }));

        // Assert
        expect(authority.state()).toEqual({ app: { password: { value: "", label: "Password" } }, data: {} });
        expect(other.received.filter((message) => message.type === "changes")).toHaveLength(1);
    });
});
