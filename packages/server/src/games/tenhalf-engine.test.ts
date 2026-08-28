import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TenhalfRoomConfig } from "@yifun/qipai-shared";
import { TenhalfEngine } from "./tenhalf-engine.js";

const cfgFree: TenhalfRoomConfig = {
  mode: "free",
  potPerPlayer: 10,
  botCount: 0,
  maxPlayers: 4,
  botStopAt: 8,
  maxRounds: 4,
};

const cfgBanker: TenhalfRoomConfig = { ...cfgFree, mode: "banker" };

function seats(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    seat: i,
    userId: `u${i}`,
    username: `p${i}`,
    isBot: false,
    connected: true,
    score: 0,
  }));
}

describe("tenhalf start seat and banker", () => {
  it("free mode has no banker and starts at seat 0", () => {
    const eng = new TenhalfEngine("m", "r", cfgFree, seats(4), () => 0);
    const snap = eng.snapshotFor("u0");
    assert.equal(snap.mode, "free");
    assert.equal(snap.bankerSeat, -1);
    assert.equal(snap.currentSeat, 0);
  });

  it("free mode starts from given winner seat", () => {
    const eng = new TenhalfEngine("m", "r", cfgFree, seats(4), () => 0, 2);
    assert.equal(eng.snapshotFor().currentSeat, 2);
    assert.equal(eng.snapshotFor().bankerSeat, -1);
    assert.equal(eng.getStartSeat(), 2);
  });

  it("banker mode: winner is banker, idle seats act first", () => {
    const eng = new TenhalfEngine("m", "r", cfgBanker, seats(4), () => 0, 2);
    const snap = eng.snapshotFor();
    assert.equal(snap.bankerSeat, 2);
    assert.equal(snap.currentSeat, 3);
  });
});

describe("tenhalf auto finish is stepwise", () => {
  it("after ten-half, others draw one card per step", () => {
    const deck = [
      { id: "d3", suit: "S" as const, rank: 3 },
      { id: "d4", suit: "H" as const, rank: 4 },
      { id: "d5", suit: "D" as const, rank: 5 },
      { id: "hit", suit: "C" as const, rank: 11 },
    ];
    const raw = {
      matchId: "m",
      roomId: "r",
      config: cfgFree,
      phase: "turn",
      deck,
      players: [
        {
          seat: 0,
          userId: "u0",
          username: "a",
          isBot: false,
          connected: true,
          hole: { id: "h0", suit: "S", rank: 10 },
          open: [],
          stopped: false,
          busted: false,
          revealed: false,
          score: 0,
          potShare: 10,
        },
        {
          seat: 1,
          userId: "u1",
          username: "b",
          isBot: false,
          connected: true,
          hole: { id: "h1", suit: "H", rank: 2 },
          open: [],
          stopped: false,
          busted: false,
          revealed: false,
          score: 0,
          potShare: 10,
        },
        {
          seat: 2,
          userId: "u2",
          username: "c",
          isBot: false,
          connected: true,
          hole: { id: "h2", suit: "D", rank: 3 },
          open: [],
          stopped: false,
          busted: false,
          revealed: false,
          score: 0,
          potShare: 10,
        },
      ],
      bankerSeat: -1,
      startSeat: 0,
      currentSeat: 0,
      potTotal: 30,
      logs: [],
      scoreEvents: [],
      drawTieSeats: [],
      drawCards: [],
      drawRound: 0,
      autoFinishActive: false,
    };
    const eng = TenhalfEngine.fromJSON(JSON.stringify(raw));
    eng.action("u0", "hit");
    const afterHit = eng.snapshotFor("u0");
    assert.equal(afterHit.players[0]?.revealed, true);
    assert.equal(afterHit.phase, "reveal_auto");
    assert.equal(afterHit.players[1]?.open.length, 0);
    assert.equal(afterHit.players[2]?.open.length, 0);

    eng.botAct();
    const step1 = eng.snapshotFor("u1");
    const opened = step1.players.filter((p) => p.seat !== 0 && p.open.length > 0);
    assert.equal(opened.length, 1);
    assert.equal(step1.phase === "settled", false);

    let guard = 0;
    while (!eng.isFinished() && guard++ < 20) eng.botAct();
    assert.equal(eng.isFinished(), true);
  });
});
