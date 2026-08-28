import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Store } from "../db/store.js";
import { SessionService } from "./session-service.js";

function tmpSessions(ttlMs = 60_000): { sessions: SessionService; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qipai-sess-"));
  const store = new Store(path.join(dir, "t.db"));
  return {
    sessions: new SessionService(store, ttlMs),
    cleanup: () => {
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("session idle ttl", () => {
  it("hello fails after expiry and listExpired includes the row", async () => {
    const { sessions, cleanup } = tmpSessions(20);
    try {
      const ok = sessions.login("alice");
      assert.ok(sessions.hello(ok.sessionToken));
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(sessions.hello(ok.sessionToken), null);
      const expired = sessions.listExpired();
      assert.equal(expired.length, 1);
      assert.equal(expired[0]!.user_id, ok.userId);
      sessions.delete(ok.userId);
      assert.equal(sessions.listExpired().length, 0);
      assert.equal(sessions.getByToken(ok.sessionToken), undefined);
    } finally {
      cleanup();
    }
  });

  it("touch extends expiry so hello still works", async () => {
    const { sessions, cleanup } = tmpSessions(80);
    try {
      const ok = sessions.login("bob");
      await new Promise((r) => setTimeout(r, 40));
      sessions.touch(ok.userId);
      await new Promise((r) => setTimeout(r, 40));
      const hello = sessions.hello(ok.sessionToken);
      assert.ok(hello);
      assert.equal(hello.userId, ok.userId);
      assert.ok(hello.expiresAt > Date.now());
    } finally {
      cleanup();
    }
  });
});
