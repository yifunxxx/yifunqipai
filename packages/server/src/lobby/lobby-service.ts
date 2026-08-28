import { randomUUID } from "node:crypto";
import type {
  GameType,
  MahjongRoomConfig,
  RoomConfig,
  RoomPhase,
  RoomSummary,
  RoundScoreLine,
  SeatInfo,
  ScoreEvent,
  TenhalfRoomConfig,
} from "@yifun/qipai-shared";
import type { Store } from "../db/store.js";

export interface RoomState {
  roomId: string;
  name: string;
  gameType: GameType;
  phase: RoomPhase;
  hostUserId: string;
  seats: SeatInfo[];
  maxSeats: number;
  config: RoomConfig;
  matchId?: string;
  roundIndex: number;
  roundResults: RoundScoreLine[];
}

function defaultMahjongConfig(partial?: Partial<MahjongRoomConfig>): MahjongRoomConfig {
  return {
    tileCount: partial?.tileCount === 144 ? 144 : 112,
    baseScore: Math.max(1, partial?.baseScore ?? 1),
    maxRounds: Math.max(1, Math.min(64, partial?.maxRounds ?? 4)),
    botCount: Math.max(0, Math.min(3, partial?.botCount ?? 0)),
  };
}

function defaultTenhalfConfig(partial?: Partial<TenhalfRoomConfig>): TenhalfRoomConfig {
  const maxPlayers = Math.max(2, Math.min(6, partial?.maxPlayers ?? 4));
  return {
    mode: partial?.mode === "free" ? "free" : "banker",
    potPerPlayer: partial?.potPerPlayer ?? 10,
    botCount: Math.max(0, Math.min(maxPlayers - 1, partial?.botCount ?? 0)),
    maxPlayers,
    botStopAt: partial?.botStopAt ?? 8,
    maxRounds: Math.max(1, Math.min(64, partial?.maxRounds ?? 4)),
  };
}

export class LobbyService {
  rooms = new Map<string, RoomState>();

  constructor(private store: Store) {
    for (const row of store.loadAllRooms()) {
      try {
        const r = JSON.parse(row.data_json) as RoomState;
        if (!r.roundResults) r.roundResults = [];
        this.rooms.set(r.roomId, r);
      } catch {
        /* skip corrupt */
      }
    }
  }

  private persist(room: RoomState): void {
    this.store.saveRoom(room.roomId, room);
  }

  listRooms(): RoomSummary[] {
    return [...this.rooms.values()].map((r) => this.toSummary(r));
  }

  get(roomId: string): RoomState | undefined {
    return this.rooms.get(roomId);
  }

  toSummary(room: RoomState): RoomSummary {
    return {
      roomId: room.roomId,
      name: room.name,
      gameType: room.gameType,
      phase: room.phase,
      hostUserId: room.hostUserId,
      seats: room.seats,
      maxSeats: room.maxSeats,
      config: room.config,
      matchId: room.matchId,
      roundIndex: room.roundIndex,
      roundResults: room.roundResults ?? [],
    };
  }

  create(
    hostUserId: string,
    hostUsername: string,
    gameType: GameType,
    name: string | undefined,
    configPartial: Partial<RoomConfig>,
  ): RoomState {
    const roomId = randomUUID().slice(0, 8);
    let maxSeats = 4;
    let config: RoomConfig;
    if (gameType === "mahjong") {
      config = defaultMahjongConfig(configPartial as Partial<MahjongRoomConfig>);
      maxSeats = 4;
    } else {
      config = defaultTenhalfConfig(configPartial as Partial<TenhalfRoomConfig>);
      maxSeats = (config as TenhalfRoomConfig).maxPlayers;
    }

    const seats: SeatInfo[] = Array.from({ length: maxSeats }, (_, i) => ({
      seat: i,
      userId: null,
      username: "",
      isBot: false,
      ready: false,
      connected: false,
      score: 0,
    }));

    seats[0] = {
      seat: 0,
      userId: hostUserId,
      username: hostUsername,
      isBot: false,
      ready: false,
      connected: true,
      score: 0,
    };

    const room: RoomState = {
      roomId,
      name: name?.trim() || `${gameType === "mahjong" ? "麻将" : "十点半"}-${roomId}`,
      gameType,
      phase: "waiting",
      hostUserId,
      seats,
      maxSeats,
      config,
      roundIndex: 0,
      roundResults: [],
    };

    // 初始人机
    const bots = gameType === "mahjong"
      ? (config as MahjongRoomConfig).botCount
      : (config as TenhalfRoomConfig).botCount;
    this.fillBots(room, bots);

    this.rooms.set(roomId, room);
    this.persist(room);
    return room;
  }

  private emptySeat(room: RoomState): SeatInfo | undefined {
    return room.seats.find((s) => !s.userId && !s.isBot);
  }

  fillBots(room: RoomState, count: number): void {
    let added = 0;
    for (const seat of room.seats) {
      if (added >= count) break;
      if (seat.userId || seat.isBot) continue;
      seat.isBot = true;
      seat.userId = `bot-${room.roomId}-${seat.seat}`;
      seat.username = `人机${seat.seat + 1}`;
      seat.ready = true;
      seat.connected = true;
      added++;
    }
  }

  addBots(roomId: string, userId: string, count = 1): RoomState {
    const room = this.requireWaitingHost(roomId, userId);
    this.fillBots(room, count);
    this.persist(room);
    return room;
  }

  removeBot(roomId: string, userId: string, seat?: number): RoomState {
    const room = this.requireWaitingHost(roomId, userId);
    const bots = room.seats.filter((s) => s.isBot);
    if (bots.length === 0) {
      throw Object.assign(new Error("房间内无人机"), { code: "NO_BOT" });
    }
    const target =
      seat !== undefined
        ? room.seats.find((s) => s.seat === seat && s.isBot)
        : [...bots].sort((a, b) => b.seat - a.seat)[0];
    if (!target) {
      throw Object.assign(new Error("指定座位不是人机"), { code: "NOT_BOT" });
    }
    target.userId = null;
    target.username = "";
    target.isBot = false;
    target.ready = false;
    target.connected = false;
    if (room.gameType === "mahjong") {
      (room.config as MahjongRoomConfig).botCount = Math.max(
        0,
        room.seats.filter((s) => s.isBot).length,
      );
    } else {
      (room.config as TenhalfRoomConfig).botCount = Math.max(
        0,
        room.seats.filter((s) => s.isBot).length,
      );
    }
    this.persist(room);
    return room;
  }

  setHost(roomId: string, userId: string, seat: number): RoomState {
    const room = this.requireWaitingHost(roomId, userId);
    const target = room.seats.find((s) => s.seat === seat);
    if (!target?.userId || target.isBot) {
      throw Object.assign(new Error("只能转让给真人玩家"), { code: "INVALID_HOST" });
    }
    if (target.userId === room.hostUserId) {
      throw Object.assign(new Error("对方已是房主"), { code: "ALREADY_HOST" });
    }
    room.hostUserId = target.userId;
    this.persist(room);
    return room;
  }

  roomsHostedBy(userId: string): RoomState[] {
    return [...this.rooms.values()].filter((r) => r.hostUserId === userId);
  }

  dissolve(roomId: string): RoomState | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    this.rooms.delete(roomId);
    this.store.deleteRoom(roomId);
    return room;
  }

  /** 房主踢人：走 leave 同一套座位/房主/对局中转人机逻辑 */
  kick(
    roomId: string,
    hostUserId: string,
    seat: number,
  ): { remaining: RoomState | null; kickedUserId: string } {
    const room = this.rooms.get(roomId);
    if (!room) throw Object.assign(new Error("房间不存在"), { code: "ROOM_NOT_FOUND" });
    if (room.hostUserId !== hostUserId) {
      throw Object.assign(new Error("仅房主可踢人"), { code: "NOT_HOST" });
    }
    const target = room.seats.find((s) => s.seat === seat);
    if (!target?.userId) {
      throw Object.assign(new Error("该座位没有玩家"), { code: "EMPTY_SEAT" });
    }
    if (target.isBot) {
      throw Object.assign(new Error("人机请用移除人机"), { code: "NOT_HUMAN" });
    }
    if (target.userId === hostUserId) {
      throw Object.assign(new Error("不能踢出自己"), { code: "KICK_SELF" });
    }
    const kickedUserId = target.userId;
    const remaining = this.leave(roomId, kickedUserId);
    return { remaining, kickedUserId };
  }

  join(roomId: string, userId: string, username: string): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) throw Object.assign(new Error("房间不存在"), { code: "ROOM_NOT_FOUND" });
    if (room.phase !== "waiting") {
      // 重连：已在座位上
      const existing = room.seats.find((s) => s.userId === userId);
      if (existing) {
        existing.connected = true;
        this.persist(room);
        return room;
      }
      throw Object.assign(new Error("对局已开始，无法加入"), { code: "ROOM_BUSY" });
    }
    const already = room.seats.find((s) => s.userId === userId);
    if (already) {
      already.connected = true;
      already.username = username;
      this.persist(room);
      return room;
    }
    const seat = this.emptySeat(room);
    if (!seat) throw Object.assign(new Error("房间已满"), { code: "ROOM_FULL" });
    seat.userId = userId;
    seat.username = username;
    seat.isBot = false;
    seat.ready = false;
    seat.connected = true;
    this.persist(room);
    return room;
  }

  leave(roomId: string, userId: string): RoomState | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const seat = room.seats.find((s) => s.userId === userId && !s.isBot);
    if (!seat) return room;

    const otherHumans = room.seats.some((s) => s.userId && !s.isBot && s.userId !== userId);

    if (room.phase === "playing" || room.phase === "settled") {
      if (!otherHumans) {
        this.rooms.delete(roomId);
        this.store.deleteRoom(roomId);
        return null;
      }
      seat.isBot = true;
      seat.userId = `bot-${room.roomId}-${seat.seat}`;
      seat.username = `人机${seat.seat + 1}`;
      seat.ready = true;
      seat.connected = true;
      if (room.hostUserId === userId) {
        const next = room.seats.find((s) => s.userId && !s.isBot);
        if (next?.userId) room.hostUserId = next.userId;
      }
      this.persist(room);
      return room;
    }

    seat.userId = null;
    seat.username = "";
    seat.ready = false;
    seat.connected = false;
    seat.isBot = false;
    if (room.hostUserId === userId) {
      const next = room.seats.find((s) => s.userId && !s.isBot);
      if (next?.userId) room.hostUserId = next.userId;
      else {
        this.rooms.delete(roomId);
        this.store.deleteRoom(roomId);
        return null;
      }
    }
    this.persist(room);
    return room;
  }

  setReady(roomId: string, userId: string, ready: boolean): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) throw Object.assign(new Error("房间不存在"), { code: "ROOM_NOT_FOUND" });
    const mahjongBetween =
      room.phase === "settled" &&
      room.gameType === "mahjong" &&
      room.roundIndex < (room.config as MahjongRoomConfig).maxRounds;
    if (room.phase !== "waiting" && !mahjongBetween) {
      throw Object.assign(new Error("对局中无法改准备状态"), { code: "ROOM_BUSY" });
    }
    const seat = room.seats.find((s) => s.userId === userId);
    if (!seat) throw Object.assign(new Error("不在房间内"), { code: "NOT_IN_ROOM" });
    seat.ready = ready;
    this.persist(room);
    return room;
  }

  updateConfig(roomId: string, userId: string, partial: Partial<RoomConfig>): RoomState {
    const room = this.requireWaitingHost(roomId, userId);
    if (room.gameType === "mahjong") {
      room.config = defaultMahjongConfig({
        ...(room.config as MahjongRoomConfig),
        ...(partial as Partial<MahjongRoomConfig>),
      });
    } else {
      const cfg = defaultTenhalfConfig({
        ...(room.config as TenhalfRoomConfig),
        ...(partial as Partial<TenhalfRoomConfig>),
      });
      room.config = cfg;
      if (cfg.maxPlayers !== room.maxSeats) {
        // 调整座位数（仅空房扩展/收缩空位）
        while (room.seats.length < cfg.maxPlayers) {
          room.seats.push({
            seat: room.seats.length,
            userId: null,
            username: "",
            isBot: false,
            ready: false,
            connected: false,
            score: 0,
          });
        }
        while (room.seats.length > cfg.maxPlayers) {
          const last = room.seats[room.seats.length - 1]!;
          if (last.userId || last.isBot) break;
          room.seats.pop();
        }
        room.maxSeats = room.seats.length;
        room.seats.forEach((s, i) => (s.seat = i));
      }
    }
    this.persist(room);
    return room;
  }

  private requireWaitingHost(roomId: string, userId: string): RoomState {
    const room = this.rooms.get(roomId);
    if (!room) throw Object.assign(new Error("房间不存在"), { code: "ROOM_NOT_FOUND" });
    if (room.hostUserId !== userId) {
      throw Object.assign(new Error("仅房主可操作"), { code: "NOT_HOST" });
    }
    if (room.phase !== "waiting") {
      throw Object.assign(new Error("对局中无法修改"), { code: "ROOM_BUSY" });
    }
    return room;
  }

  canStart(room: RoomState): { ok: boolean; reason?: string } {
    const occupied = room.seats.filter((s) => s.userId || s.isBot);
    const min = room.gameType === "mahjong" ? 4 : 2;
    if (occupied.length < min) return { ok: false, reason: `至少需要 ${min} 人` };
    if (room.gameType === "mahjong" && occupied.length !== 4) {
      return { ok: false, reason: "麻将需要恰好 4 人" };
    }
    for (const s of occupied) {
      if (!s.isBot && !s.ready) return { ok: false, reason: "仍有玩家未准备" };
    }
    return { ok: true };
  }

  /** 麻将小局结束后，全体真人已准备则可开下一局 */
  canContinueMatch(room: RoomState): boolean {
    if (room.phase !== "settled") return false;
    if (room.gameType !== "mahjong") return false;
    if (room.roundIndex >= (room.config as MahjongRoomConfig).maxRounds) return false;
    const humans = room.seats.filter((s) => s.userId && !s.isBot);
    return humans.length > 0 && humans.every((s) => s.ready);
  }

  markPlaying(room: RoomState, matchId: string): void {
    room.phase = "playing";
    room.matchId = matchId;
    this.persist(room);
  }

  markSettled(room: RoomState, scores: number[], events: ScoreEvent[] = []): void {
    room.phase = "settled";
    room.seats.forEach((s, i) => {
      if (scores[i] !== undefined) s.score += scores[i]!;
    });
    if (!room.roundResults) room.roundResults = [];
    room.roundResults.push({
      round: room.roundIndex + 1,
      deltas: room.seats.map((_, i) => scores[i] ?? 0),
      events,
    });
    if (room.gameType === "mahjong") {
      const max = (room.config as MahjongRoomConfig).maxRounds;
      if (room.roundIndex + 1 < max) {
        for (const s of room.seats) {
          if (!s.isBot) s.ready = false;
        }
      }
    }
    this.persist(room);
  }

  bumpRound(room: RoomState): void {
    room.roundIndex += 1;
    this.persist(room);
  }

  /** 从等待房开新一场：局数与累计分归零 */
  resetMatchProgress(room: RoomState): void {
    room.roundIndex = 0;
    room.roundResults = [];
    for (const s of room.seats) s.score = 0;
    this.persist(room);
  }

  backToWaiting(room: RoomState): void {
    room.phase = "waiting";
    room.matchId = undefined;
    for (const s of room.seats) {
      if (!s.isBot) s.ready = false;
    }
    this.persist(room);
  }

  setSeatConnected(userId: string, connected: boolean): void {
    for (const room of this.rooms.values()) {
      const seat = room.seats.find((s) => s.userId === userId);
      if (seat) {
        seat.connected = connected;
        this.persist(room);
      }
    }
  }

  findRoomByUser(userId: string): RoomState | undefined {
    for (const room of this.rooms.values()) {
      if (room.seats.some((s) => s.userId === userId)) return room;
    }
    return undefined;
  }
}
