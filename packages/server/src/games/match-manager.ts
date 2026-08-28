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

  start(room: RoomState, opts?: { startSeat?: number; continueSeries?: boolean }): AnyEngine {
    if (!opts?.continueSeries) {
      const check = this.lobby.canStart(room);
      if (!check.ok) {
        throw Object.assign(new Error(check.reason ?? "无法开始"), { code: "CANNOT_START" });
      }
    }
    if (!opts?.continueSeries && room.phase === "waiting") {
      this.lobby.resetMatchProgress(room);
    }
    this.clearOldMatch(room.roomId);

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
        Math.random,
        opts?.startSeat,
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

  /** 房间已解散：停人机计时并丢掉对局 */
  abandon(roomId: string): void {
    this.clearOldMatch(roomId);
  }

  /** 对局中真人离开，座位改人机并继续 */
  convertHumanToBot(roomId: string, userId: string): void {
    const engine = this.getByRoom(roomId);
    if (!engine) return;
    if (!engine.convertHumanToBot(userId)) return;
    this.persist(engine);
    this.scheduleBots(
      engine instanceof MahjongEngine
        ? engine.snapshotFor().matchId
        : engine.snapshotFor().matchId,
    );
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
        this.lobby.markSettled(room, engine.getScores(), engine.getScoreEvents());
        this.lobby.bumpRound(room);
      }
      const matchId =
        engine instanceof MahjongEngine
          ? engine.snapshotFor().matchId
          : engine.snapshotFor().matchId;
      this.clearBotTimer(matchId);
      this.broadcast(roomId);
      if (room) this.scheduleAutoNext(room);
      return;
    }
    this.scheduleBots(
      engine instanceof MahjongEngine
        ? engine.snapshotFor().matchId
        : engine.snapshotFor().matchId,
    );
    this.broadcast(roomId);
  }

  private maxRoundsOf(room: RoomState): number {
    if (room.gameType === "mahjong") {
      return (room.config as MahjongRoomConfig).maxRounds;
    }
    return (room.config as TenhalfRoomConfig).maxRounds;
  }

  private scheduleAutoNext(room: RoomState): void {
    if (room.gameType === "mahjong") return;
    const max = this.maxRoundsOf(room);
    if (room.roundIndex >= max) return;
    setTimeout(() => {
      const live = this.lobby.get(room.roomId);
      if (!live || live.phase !== "settled") return;
      if (live.roundIndex >= this.maxRoundsOf(live)) return;
      try {
        this.nextRound(live);
        this.broadcast(live.roomId);
      } catch (e) {
        console.error("[match] auto next failed", e);
      }
    }, 4000);
  }

  scheduleBots(matchId: string): void {
    this.clearBotTimer(matchId);
    const existing = this.matches.get(matchId);
    const delay =
      existing instanceof TenhalfEngine && existing.snapshotFor().phase === "reveal_auto"
        ? 800
        : 600;
    const timer = setTimeout(() => {
      const engine = this.matches.get(matchId);
      if (!engine || engine.isFinished()) return;
      if (engine instanceof MahjongEngine && engine.tryHumanTimeout()) {
        this.persist(engine);
        this.afterAction(engine.snapshotFor().roomId, engine);
        return;
      }
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
    }, delay);
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

  /** 再来一局：未达总局数则开新局；否则回等待并保留累计分 */
  nextRound(room: RoomState): AnyEngine | null {
    const max = this.maxRoundsOf(room);
    if (room.roundIndex >= max) {
      this.returnToLobby(room.roomId);
      return null;
    }

    if (room.gameType === "mahjong") {
      const humans = room.seats.filter((s) => s.userId && !s.isBot);
      if (humans.some((s) => !s.ready)) {
        throw Object.assign(new Error("需全体真人准备后才能开始下一局"), {
          code: "NOT_READY",
        });
      }
    }

    let dealer: number | undefined;
    let tenhalfStart: number | undefined;
    const oldId = this.byRoom.get(room.roomId);
    if (oldId) {
      const old = this.matches.get(oldId);
      if (old instanceof MahjongEngine) {
        dealer = old.getWinnerSeat() ?? old.getDealerSeat();
      } else if (old instanceof TenhalfEngine) {
        tenhalfStart = old.getWinnerSeat() ?? old.getStartSeat();
      }
      this.clearBotTimer(oldId);
      this.matches.delete(oldId);
      this.store.deleteMatch(oldId);
      this.byRoom.delete(room.roomId);
    }

    if (room.gameType === "tenhalf") {
      return this.start(room, { startSeat: tenhalfStart, continueSeries: true });
    }

    const cfg = room.config as MahjongRoomConfig;
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

  private clearOldMatch(roomId: string): void {
    const matchId = this.byRoom.get(roomId);
    if (!matchId) return;
    this.clearBotTimer(matchId);
    this.matches.delete(matchId);
    this.store.deleteMatch(matchId);
    this.byRoom.delete(roomId);
  }
}
