import { randomUUID } from "node:crypto";
import type { MahjongRoomConfig, TenhalfRoomConfig } from "@yifun/qipai-shared";
import type { Store } from "../db/store.js";
import type { LobbyService, RoomState } from "../lobby/lobby-service.js";
import { MahjongEngine } from "./mahjong-engine.js";
import { TenhalfEngine } from "./tenhalf-engine.js";

export type AnyEngine = MahjongEngine | TenhalfEngine;

export class MatchManager {
  matches = new Map<string, AnyEngine>();
  /** roomId -> matchId */
  byRoom = new Map<string, string>();
  private botTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private store: Store,
    private lobby: LobbyService,
    private broadcast: (roomId: string) => void,
  ) {
    this.restorePlaying();
  }

  /** 进程重启后从 SQLite 恢复进行中的对局 */
  private restorePlaying(): void {
    for (const room of this.lobby.rooms.values()) {
      if (room.phase !== "playing" || !room.matchId) continue;
      const row = this.store.getMatchByRoom(room.roomId);
      if (!row) continue;
      try {
        const engine =
          row.game_type === "mahjong"
            ? MahjongEngine.fromJSON(row.state_json)
            : TenhalfEngine.fromJSON(row.state_json);
        this.matches.set(row.match_id, engine);
        this.byRoom.set(room.roomId, row.match_id);
        this.scheduleBots(row.match_id);
      } catch (e) {
        console.error("[match] restore failed", room.roomId, e);
      }
    }
  }

  start(room: RoomState): AnyEngine {
    const check = this.lobby.canStart(room);
    if (!check.ok) {
      throw Object.assign(new Error(check.reason ?? "无法开始"), { code: "CANNOT_START" });
    }
    const matchId = randomUUID();
    const seats = room.seats
      .filter((s) => s.userId)
      .map((s) => ({
        seat: s.seat,
        userId: s.userId!,
        username: s.username,
        isBot: s.isBot,
        connected: s.connected,
        score: 0,
      }));

    let engine: AnyEngine;
    if (room.gameType === "mahjong") {
      engine = new MahjongEngine(
        matchId,
        room.roomId,
        room.config as MahjongRoomConfig,
        seats,
        room.roundIndex,
      );
    } else {
      engine = new TenhalfEngine(
        matchId,
        room.roomId,
        room.config as TenhalfRoomConfig,
        seats,
      );
    }

    this.matches.set(matchId, engine);
    this.byRoom.set(room.roomId, matchId);
    this.lobby.markPlaying(room, matchId);
    this.persist(engine);
    this.scheduleBots(matchId);
    return engine;
  }

  getByRoom(roomId: string): AnyEngine | undefined {
    const id = this.byRoom.get(roomId);
    return id ? this.matches.get(id) : undefined;
  }

  get(matchId: string): AnyEngine | undefined {
    return this.matches.get(matchId);
  }

  persist(engine: AnyEngine): void {
    const snap =
      engine instanceof MahjongEngine
        ? engine.snapshotFor()
        : engine.snapshotFor();
    this.store.saveMatchSnapshot({
      match_id: snap.matchId,
      room_id: snap.roomId,
      game_type: snap.gameType,
      state_json: engine.toJSON(),
      updated_at: Date.now(),
    });
  }

  action(roomId: string, userId: string, action: string, data: Record<string, unknown>): AnyEngine {
    const engine = this.getByRoom(roomId);
    if (!engine) throw Object.assign(new Error("无进行中对局"), { code: "NO_MATCH" });
    engine.action(userId, action, data);
    this.persist(engine);
    this.afterAction(roomId, engine);
    return engine;
  }

  private afterAction(roomId: string, engine: AnyEngine): void {
    if (engine.isFinished()) {
      const room = this.lobby.get(roomId);
      if (room) {
        this.lobby.markSettled(room, engine.getScores());
        if (engine instanceof MahjongEngine) {
          const winner = engine.getWinnerSeat();
          // 流局连庄：dealer 已在引擎内保持；赢家坐庄已设置
          room.roundIndex += 1;
          if (winner !== undefined) {
            // dealer already winner inside engine for next round start
          }
        }
      }
      this.clearBotTimer(engine instanceof MahjongEngine ? engine.snapshotFor().matchId : engine.snapshotFor().matchId);
    } else {
      this.scheduleBots(
        engine instanceof MahjongEngine ? engine.snapshotFor().matchId : engine.snapshotFor().matchId,
      );
    }
    this.broadcast(roomId);
  }

  scheduleBots(matchId: string): void {
    this.clearBotTimer(matchId);
    const timer = setTimeout(() => {
      const engine = this.matches.get(matchId);
      if (!engine || engine.isFinished()) return;
      const acted = engine.botAct();
      if (acted) {
        this.persist(engine);
        const roomId =
          engine instanceof MahjongEngine
            ? engine.snapshotFor().roomId
            : engine.snapshotFor().roomId;
        this.afterAction(roomId, engine);
      } else {
        // 若仍轮到人机但未行动（如等待），再试
        this.scheduleBots(matchId);
      }
    }, 600);
    this.botTimers.set(matchId, timer);
  }

  private clearBotTimer(matchId: string): void {
    const t = this.botTimers.get(matchId);
    if (t) clearTimeout(t);
    this.botTimers.delete(matchId);
  }

  returnToLobby(roomId: string): void {
    const room = this.lobby.get(roomId);
    if (!room) return;
    const matchId = this.byRoom.get(roomId);
    if (matchId) {
      this.clearBotTimer(matchId);
      this.matches.delete(matchId);
      this.store.deleteMatch(matchId);
      this.byRoom.delete(roomId);
    }
    this.lobby.backToWaiting(room);
  }

  /** 再来一局（麻将多局） */
  nextRound(room: RoomState): AnyEngine | null {
    if (room.gameType !== "mahjong") {
      this.returnToLobby(room.roomId);
      return null;
    }
    const cfg = room.config as MahjongRoomConfig;
    if (room.roundIndex >= cfg.maxRounds) {
      this.returnToLobby(room.roomId);
      return null;
    }
    // 清掉旧 match，保留房间分数与 roundIndex
    const oldId = this.byRoom.get(room.roomId);
    let dealer: number | undefined;
    if (oldId) {
      const old = this.matches.get(oldId);
      if (old instanceof MahjongEngine) {
        dealer = old.getWinnerSeat() ?? old.getDealerSeat();
      }
      this.clearBotTimer(oldId);
      this.matches.delete(oldId);
      this.store.deleteMatch(oldId);
    }
    const matchId = randomUUID();
    const seats = room.seats
      .filter((s) => s.userId)
      .map((s) => ({
        seat: s.seat,
        userId: s.userId!,
        username: s.username,
        isBot: s.isBot,
        connected: s.connected,
        score: 0,
      }));
    const engine = new MahjongEngine(
      matchId,
      room.roomId,
      cfg,
      seats,
      room.roundIndex,
      dealer,
    );
    this.matches.set(matchId, engine);
    this.byRoom.set(room.roomId, matchId);
    this.lobby.markPlaying(room, matchId);
    this.persist(engine);
    this.scheduleBots(matchId);
    return engine;
  }
}
