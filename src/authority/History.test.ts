import { connectJson } from "../__fixtures__/Wired.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { report } from "@punyts/core";
import { copyJson } from "../Apply.js";
import type { SyncMessage } from "../Messages.js";
import { createAuthority } from "./Authority.js";
import { createMemoryNamespaceStorage, type NamespaceStorage } from "./NamespaceStorage.js";

vi.mock("@punyts/core", async (original) => ({ ...(await original<typeof import("@punyts/core")>()), report: vi.fn() }));

const NAMESPACE = "7001.apps.orders";
const STATE = { app: { title: "Orders", panel: { open: false } }, data: {} };

let counter = 0;
const change = (path: string, value: unknown) =>
    JSON.stringify({ type: "change", change: { id: `h-${++counter}`, path, op: "set", value, base: 0 } });

const setup = async (storage: NamespaceStorage = createMemoryNamespaceStorage(), history = 10) => {
    const authority = await createAuthority({ namespace: NAMESPACE, storage, initial: copyJson(STATE), history });
    const join = () => {
        const received: SyncMessage[] = [];
        const session = connectJson(authority, (message) => received.push(message), vi.fn());
        session.receive(JSON.stringify({ type: "hello", namespace: NAMESPACE, revision: 0, clientId: "c", protocol: 4 }));
        return { received, session };
    };
    return { authority, storage, join };
};

afterEach(() => {
    vi.mocked(report).mockClear();
});

describe("createAuthority with history", () => {
    it("should undo a client's change by writing back what its path held, and push it to every client", async () => {
        // Arrange
        const { authority, join } = await setup();
        const person = join();
        const other = join();
        person.session.receive(change("$.app.panel.open", true));

        // Act
        person.session.receive(JSON.stringify({ type: "undo" }));

        // Assert
        expect(authority.get("$.app.panel.open")).toBe(false);
        const pushed = other.received.filter((message) => message.type === "changes").flatMap((message) => message.type === "changes" ? message.changes : []);
        expect(pushed.map((item) => [item.path, item.value])).toEqual([["$.app.panel.open", true], ["$.app.panel.open", false]]);
    });

    it("should remove a value the undone change created, and redo it", async () => {
        // Arrange
        const { authority, join } = await setup();
        const person = join();
        person.session.receive(change("$.app.panel.width", 320));

        // Act
        authority.undo();
        const afterUndo = authority.get("$.app.panel.width");
        authority.redo();

        // Assert
        expect(afterUndo).toBeUndefined();
        expect(authority.get("$.app.panel.width")).toBe(320);
        expect(authority.history().map((entry) => entry.change.path)).toEqual(["$.app.panel.width"]);
    });

    it("should run no server logic for an undo", async () => {
        // Arrange
        const { authority, join } = await setup();
        const applied = vi.fn();
        authority.onApplied(applied);
        const person = join();
        person.session.receive(change("$.app.title", "Mine"));
        applied.mockClear();

        // Act
        authority.undo();

        // Assert
        expect(authority.get("$.app.title")).toBe("Orders");
        expect(applied).not.toHaveBeenCalled();
    });

    it("should clear what was undone when a new change arrives", async () => {
        // Arrange
        const { authority, join } = await setup();
        const person = join();
        person.session.receive(change("$.app.title", "A"));
        authority.undo();

        // Act
        person.session.receive(change("$.app.title", "B"));
        const redone = authority.redo();

        // Assert
        expect(redone).toBeUndefined();
        expect(authority.get("$.app.title")).toBe("B");
    });

    it("should keep only as many changes as the history holds, and save them with the namespace", async () => {
        // Arrange
        const storage = createMemoryNamespaceStorage();
        const { authority, join } = await setup(storage, 2);
        const person = join();

        // Act
        for (const title of ["A", "B", "C"]) person.session.receive(change("$.app.title", title));
        await authority.flush();
        const reloaded = await setup(storage, 2);

        // Assert
        expect(reloaded.authority.history().map((entry) => entry.change.value)).toEqual(["B", "C"]);
        reloaded.authority.undo();
        reloaded.authority.undo();
        expect(reloaded.authority.undo()).toBeUndefined();
        expect(reloaded.authority.get("$.app.title")).toBe("A");
    });

    it("should keep no history by default", async () => {
        // Arrange
        const { authority, join } = await setup(createMemoryNamespaceStorage(), 0);
        const person = join();
        person.session.receive(change("$.app.title", "A"));

        // Act
        const undone = authority.undo();

        // Assert
        expect(undone).toBeUndefined();
        expect(authority.get("$.app.title")).toBe("A");
    });
});
