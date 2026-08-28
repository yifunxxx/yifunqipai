import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Store } from "../db/store.js";
import { LobbyService } from "./lobby-service.js";

function tmpLobby(): { lobby: LobbyService; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qipai-lobby-"));
  const store = new Store(path.join(dir, "t.db"));
  return {
    lobby: new LobbyService(store),
    cleanup: () => {
      store.db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("lobby leave", () => {
  it("dissolves a bot match when the last human leaves mid-game", () => {
    const { lobby, cleanup } = tmpLobby();
    try {
      const room = lobby.create("u1", "host", "mahjong", undefined, { botCount: 3 });
      lobby.markPlaying(room, "match-1");
      const left = lobby.leave(room.roomId, "u1");
      assert.equal(left, null);
      assert.equal(lobby.get(room.roomId), undefined);
    } finally {
      cleanup();
    }
  });

  it("converts the leaver to a bot when other humans remain", () => {
    const { lobby, cleanup } = tmpLobby();
    try {
      const room = lobby.create("u1", "host", "mahjong", undefined, { botCount: 2 });
      lobby.join(room.roomId, "u2", "p2");
      lobby.markPlaying(room, "match-2");
      const left = lobby.leave(room.roomId, "u1");
      assert.ok(left);
      assert.equal(left.seats.filter((s) => !s.isBot && s.userId).length, 1);
      assert.equal(left.seats.find((s) => s.userId === "u2")?.isBot, false);
      assert.equal(
        left.seats.filter((s) => s.isBot).length,
        3,
      );
      assert.equal(lobby.findRoomByUser("u1"), undefined);
    } finally {
      cleanup();
    }
  });

  it("deletes an empty waiting room when the host leaves", () => {
    const { lobby, cleanup } = tmpLobby();
    try {
      const room = lobby.create("u1", "host", "mahjong", undefined, { botCount: 0 });
      const left = lobby.leave(room.roomId, "u1");
      assert.equal(left, null);
      assert.equal(lobby.get(room.roomId), undefined);
    } finally {
      cleanup();
    }
  });
});

describe("match progress", () => {
  it("resetMatchProgress clears rounds and scores", () => {
    const { lobby, cleanup } = tmpLobby();
    try {
      const room = lobby.create("u1", "host", "mahjong", undefined, { botCount: 3 });
      room.roundIndex = 4;
      room.seats[0]!.score = 99;
      lobby.resetMatchProgress(room);
      assert.equal(room.roundIndex, 0);
      assert.equal(room.seats[0]!.score, 0);
      assert.deepEqual(room.roundResults, []);
    } finally {
      cleanup();
    }
  });

  it("allows ready between mahjong rounds", () => {
    const { lobby, cleanup } = tmpLobby();
    try {
      const room = lobby.create("u1", "host", "mahjong", undefined, { botCount: 3 });
      lobby.markPlaying(room, "m1");
      lobby.markSettled(room, [1, 0, 0, -1], []);
      lobby.bumpRound(room);
      assert.equal(room.seats[0]!.ready, false);
      const after = lobby.setReady(room.roomId, "u1", true);
      assert.equal(after.seats[0]!.ready, true);
      assert.equal(lobby.canContinueMatch(after), true);
    } finally {
      cleanup();
    }
  });
});
