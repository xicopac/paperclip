import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { agentApiKeys, agents } from "@paperclipai/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { logger } from "../middleware/logger.js";

vi.mock("../middleware/logger.js", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

class FakeUpgradeSocket extends EventEmitter {
  destroyed = false;
  writable = true;
  writableEnded = false;
  writableDestroyed = false;
  endedChunks: string[] = [];
  destroyCalls = 0;

  end(chunk?: string) {
    if (chunk) this.endedChunks.push(chunk);
    this.writableEnded = true;
    this.writable = false;
    setImmediate(() => {
      if (this.destroyed) return;
      this.emit("finish");
      if (!this.destroyed) {
        this.emit("close");
      }
    });
    return this;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("close");
    return this;
  }

  emitSocketError(err: Error) {
    this.writable = false;
    this.writableDestroyed = true;
    this.emit("error", err);
  }
}

function createUpgradeRequest(overrides: Partial<IncomingMessage> = {}) {
  return {
    url: "/api/companies/company-1/events/ws",
    headers: {},
    ...overrides,
  } as IncomingMessage;
}

async function flushPromises() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A live socket as the ws server sees it, without a real handshake. */
class FakeWsSocket extends EventEmitter {
  readyState = 1;
  pingCalls = 0;
  terminateCalls = 0;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  ping() {
    this.pingCalls += 1;
  }

  send() {}

  terminate() {
    this.terminateCalls += 1;
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = 3;
    this.emit("close");
  }
}

/**
 * Minimal drizzle-shaped db for the two tables the upgrade handler touches.
 * `agentStatusById` is read on every status lookup, so a test can flip it
 * between the upgrade and a later keepalive tick.
 */
function createFakeDb(opts: {
  keyRow?: Record<string, unknown> | null;
  agentStatusById?: Record<string, string>;
  /** Runs on every agent-status read; used to stop before the ws handshake. */
  onStatusRead?: () => void;
}) {
  const state = { lastUsedAtWrites: 0, statusReads: 0 };
  const agentStatusById = opts.agentStatusById ?? {};

  const db = {
    select: () => ({
      from(table: unknown) {
        return {
          where() {
            if (table === agentApiKeys) {
              return Promise.resolve(opts.keyRow ? [opts.keyRow] : []);
            }
            opts.onStatusRead?.();
            state.statusReads += 1;
            return Promise.resolve(
              Object.entries(agentStatusById).map(([id, status]) => ({
                id,
                companyId: "company-1",
                status,
              })),
            );
          },
        };
      },
    }),
    update: () => ({
      set: () => ({
        where() {
          state.lastUsedAtWrites += 1;
          return Promise.resolve();
        },
      }),
    }),
  };

  return { db, state, agentStatusById };
}

const agentKeyRow = {
  id: "key-1",
  agentId: "agent-1",
  companyId: "company-1",
  keyHash: "hash",
  scopeConfig: null,
  responsibleUserId: "user-1",
  revokedAt: null,
};

function createAgentKeyRequest() {
  return createUpgradeRequest({ headers: { authorization: "Bearer pcp_test_agent_key" } });
}

describe("setupLiveEventsWebSocketServer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not write a rejection response after the raw upgrade socket is already closed", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    socket.destroy();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyCalls).toBe(1);
  });

  it("handles raw upgrade socket errors during async authorization", async () => {
    const server = new EventEmitter();
    let resolveSession: (value: null) => void = () => undefined;
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    expect(() => socket.emitSocketError(new Error("write EPIPE"))).not.toThrow();
    resolveSession(null);
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), path: "/api/companies/company-1/events/ws" }),
      "live websocket upgrade socket error",
    );
    expect(socket.endedChunks).toEqual([]);
    expect(socket.destroyed).toBe(true);
  });

  it("destroys and cleans up listeners after flushing a rejection response", async () => {
    const server = new EventEmitter();
    setupLiveEventsWebSocketServer(server as never, {} as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    expect(socket.destroyed).toBe(true);
    expect(socket.listenerCount("error")).toBe(0);
    expect(socket.listenerCount("close")).toBe(0);
    expect(socket.listenerCount("finish")).toBe(0);
  });

  it("authorizes a cloud-proxied browser for a company in its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    const socket = new FakeUpgradeSocket();
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => {
        // Stop before the ws handshake writes to the fake socket; the
        // assertion is that authorization passed without any rejection.
        socket.writable = false;
        return { userId: "cloud-user-1", companyIds: ["company-1", "company-2"] };
      },
    });

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("rejects a cloud actor for a company outside its membership scope", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => ({ userId: "cloud-user-1", companyIds: ["company-other"] }),
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    // A resolved cloud actor is authoritative; the session path must not run.
    expect(resolveSessionFromHeaders).not.toHaveBeenCalled();
  });

  it("falls through to session auth when no cloud actor resolves", async () => {
    const server = new EventEmitter();
    const resolveSessionFromHeaders = vi.fn(async () => null);
    setupLiveEventsWebSocketServer(server as never, {} as never, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders,
      resolveCloudActor: async () => null,
    });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createUpgradeRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(resolveSessionFromHeaders).toHaveBeenCalledTimes(1);
    expect(socket.endedChunks[0]).toContain("403 Forbidden");
  });

  // The upgrade handler is a raw `server.on("upgrade")` listener, so it never
  // reaches Express or actorMiddleware. Without its own status read, a paused
  // agent's stored key opens a socket and is subscribed to the whole company
  // event stream — the middleware fix cannot reach it.
  it.each([
    ["paused", "agent-1"],
    ["pending_approval", "agent-2"],
    ["terminated", "agent-3"],
  ])("rejects a stored agent key whose agent is %s", async (status, agentId) => {
    const server = new EventEmitter();
    const { db, state } = createFakeDb({
      keyRow: { ...agentKeyRow, agentId },
      agentStatusById: { [agentId]: status },
    });
    setupLiveEventsWebSocketServer(server as never, db as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createAgentKeyRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
    // The rejection must not enumerate anything and must not touch the key row.
    expect(socket.endedChunks.join("")).not.toContain(agentId);
    expect(state.statusReads).toBe(1);
    expect(state.lastUsedAtWrites).toBe(0);
  });

  it("rejects a stored agent key whose agent row is missing", async () => {
    const server = new EventEmitter();
    const { db } = createFakeDb({ keyRow: { ...agentKeyRow, agentId: "agent-gone" }, agentStatusById: {} });
    setupLiveEventsWebSocketServer(server as never, db as never, { deploymentMode: "authenticated" });
    const socket = new FakeUpgradeSocket();

    server.emit("upgrade", createAgentKeyRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks[0]).toContain("403 Forbidden");
  });

  it("authorizes a stored agent key for an invokable agent and touches the key", async () => {
    const server = new EventEmitter();
    const socket = new FakeUpgradeSocket();
    const { db, state } = createFakeDb({
      keyRow: agentKeyRow,
      agentStatusById: { "agent-1": "active" },
      // Stop before the ws handshake writes to the fake socket; the assertion is
      // that authorization passed without any rejection.
      onStatusRead: () => {
        socket.writable = false;
      },
    });
    setupLiveEventsWebSocketServer(server as never, db as never, { deploymentMode: "authenticated" });

    server.emit("upgrade", createAgentKeyRequest(), socket as unknown as Duplex, Buffer.alloc(0));
    await flushPromises();
    await flushPromises();

    expect(socket.endedChunks).toEqual([]);
    expect(state.lastUsedAtWrites).toBe(1);
  });

  it("closes an open agent socket within one keepalive interval after the agent is paused", async () => {
    vi.useFakeTimers();
    try {
      const server = new EventEmitter();
      const { db, state, agentStatusById } = createFakeDb({
        keyRow: agentKeyRow,
        agentStatusById: { "agent-1": "active" },
      });
      const wss = setupLiveEventsWebSocketServer(server as never, db as never, {
        deploymentMode: "authenticated",
      });
      const socket = new FakeWsSocket();
      wss.clients.add(socket as never);
      wss.emit(
        "connection",
        socket as never,
        {
          paperclipUpgradeContext: { companyId: "company-1", actorType: "agent", actorId: "agent-1" },
        } as never,
      );

      // A still-invokable agent keeps its socket across a keepalive tick.
      await vi.advanceTimersByTimeAsync(30000);
      socket.emit("pong");
      expect(socket.closeCalls).toEqual([]);
      expect(state.statusReads).toBe(1);

      // The ping/pong keepalive itself performs no re-authorization, so the
      // revalidation pass is the only thing that can end a paused agent's
      // subscription.
      agentStatusById["agent-1"] = "paused";
      await vi.advanceTimersByTimeAsync(30000);

      expect(socket.closeCalls).toEqual([{ code: 1008, reason: "agent no longer authorized" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an open agent socket when its agent row disappears", async () => {
    vi.useFakeTimers();
    try {
      const server = new EventEmitter();
      const { db, agentStatusById } = createFakeDb({
        keyRow: agentKeyRow,
        agentStatusById: { "agent-1": "active" },
      });
      const wss = setupLiveEventsWebSocketServer(server as never, db as never, {
        deploymentMode: "authenticated",
      });
      const socket = new FakeWsSocket();
      wss.clients.add(socket as never);
      wss.emit(
        "connection",
        socket as never,
        {
          paperclipUpgradeContext: { companyId: "company-1", actorType: "agent", actorId: "agent-1" },
        } as never,
      );

      delete agentStatusById["agent-1"];
      await vi.advanceTimersByTimeAsync(30000);

      expect(socket.closeCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
