/** 统一消息信封 */
export interface Envelope<T = unknown> {
  type: string;
  requestId?: string;
  payload: T;
}

export type GameType = "mahjong" | "tenhalf";

export type RoomPhase = "waiting" | "playing" | "settled";

export interface AuthLoginPayload {
  username: string;
}

export interface AuthHelloPayload {
  sessionToken: string;
}

export interface AuthOkPayload {
  sessionToken: string;
  userId: string;
  username: string;
  expiresAt: number;
}

export interface LobbyListGamesPayload {
  games: Array<{
    id: GameType;
    name: string;
    description: string;
    minPlayers: number;
    maxPlayers: number;
  }>;
}

export interface MahjongRoomConfig {
  tileCount: 112 | 144;
  baseScore: number;
  maxRounds: number;
  botCount: number;
}

export interface TenhalfRoomConfig {
  mode: "banker" | "free";
  potPerPlayer: number;
  botCount: number;
  maxPlayers: number;
  botStopAt: number;
  /** 总局数，打完自动结束并统分 */
  maxRounds: number;
}

export type RoomConfig = MahjongRoomConfig | TenhalfRoomConfig;

export interface SeatInfo {
  seat: number;
  userId: string | null;
  username: string;
  isBot: boolean;
  ready: boolean;
  connected: boolean;
  score: number;
}

/** 一局的分数明细（用于终场排名弹窗） */
export interface RoundScoreLine {
  round: number;
  deltas: number[];
  events: ScoreEvent[];
}

export interface RoomSummary {
  roomId: string;
  name: string;
  gameType: GameType;
  phase: RoomPhase;
  hostUserId: string;
  seats: SeatInfo[];
  maxSeats: number;
  config: RoomConfig;
  matchId?: string;
  /** 已完成局数 */
  roundIndex: number;
  /** 本场各局分差与事件，重新开始后清空 */
  roundResults?: RoundScoreLine[];
}

export interface RoomCreatePayload {
  gameType: GameType;
  name?: string;
  config: Partial<RoomConfig>;
}

export interface RoomJoinPayload {
  roomId: string;
}

export interface RoomReadyPayload {
  ready: boolean;
}

export interface RoomAddBotPayload {
  count?: number;
}

export interface RoomRemoveBotPayload {
  /** 不传则移除编号最大的一个人机 */
  seat?: number;
}

export interface RoomSetHostPayload {
  /** 目标座位号（须为真人玩家） */
  seat: number;
}

export interface RoomKickPayload {
  /** 目标座位号（须为真人玩家，不能是自己） */
  seat: number;
}

export interface RoomKickedPayload {
  roomId: string;
  reason: string;
}

export interface RoomChatPayload {
  text: string;
}

export interface RoomChatMessagePayload {
  roomId: string;
  userId: string;
  username: string;
  text: string;
  at: number;
}

export interface RoomUpdateConfigPayload {
  config: Partial<RoomConfig>;
}

export interface SysErrorPayload {
  code: string;
  message: string;
  requestId?: string;
}

export interface SysKickedPayload {
  reason: string;
}

/** 麻将动作 */
export type MahjongActionType =
  | "discard"
  | "peng"
  | "mingGang"
  | "anGang"
  | "buGang"
  | "hu"
  | "pass"
  | "lockSelect";

export interface GameActionPayload {
  action: string;
  data?: Record<string, unknown>;
}

export interface ScoreEvent {
  kind: string;
  description: string;
  deltas: Array<{ seat: number; delta: number }>;
  at: number;
}

/** 麻将桌面通知（出牌/碰杠胡/流局），客户端按 seq 去重弹窗 */
export interface TableEvent {
  seq: number;
  kind: "discard" | "peng" | "mingGang" | "anGang" | "buGang" | "hu" | "zimo" | "liuju";
  seat: number;
  text: string;
  tile?: { id: string; suit: string; rank: number };
}

export const PROTOCOL_VERSION = 1;

export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export const GAME_CATALOG: LobbyListGamesPayload["games"] = [
  {
    id: "mahjong",
    name: "陕西麻将",
    description: "112/144 张，碰杠胡，无吃",
    minPlayers: 4,
    maxPlayers: 4,
  },
  {
    id: "tenhalf",
    name: "十点半",
    description: "打庄/通比，2–6 人",
    minPlayers: 2,
    maxPlayers: 6,
  },
];
