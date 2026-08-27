import {
  buildWall112,
  buildWall144,
  canAnGang,
  canBuGang,
  canMingGang,
  canPeng,
  drawableCount,
  evaluateHu,
  shuffleInPlace,
  sortTiles,
  tileKey,
  type MahjongRoomConfig,
  type Meld,
  type ScoreEvent,
  type Tile,
} from "@yifun/qipai-shared";

export type MahjongPhase =
  | "draw"
  | "discard"
  | "claim"
  | "settled"
  | "liuju";

export interface MahjongPlayerPublic {
  seat: number;
  username: string;
  isBot: boolean;
  meldCount: number;
  handCount: number;
  discards: Tile[];
  melds: Meld[];
  score: number;
  connected: boolean;
}

export interface MahjongPlayerState {
  seat: number;
  userId: string;
  username: string;
  isBot: boolean;
  hand: Tile[];
  melds: Meld[];
  discards: Tile[];
  score: number;
  connected: boolean;
}

export interface ClaimOption {
  seat: number;
  actions: Array<"peng" | "mingGang" | "hu" | "pass">;
}

export interface MahjongSnapshot {
  matchId: string;
  roomId: string;
  gameType: "mahjong";
  phase: MahjongPhase;
  tileCount: 112 | 144;
  baseScore: number;
  dealerSeat: number;
  currentSeat: number;
  wallRemaining: number;
  deadWall: number;
  gangCount: number;
  lastDiscard?: Tile;
  lastDiscardSeat?: number;
  claimOptions: ClaimOption[];
  claimResponses: Record<number, string>;
  players: MahjongPlayerPublic[];
  /** 仅发给对应座位的手牌 */
  selfHand?: Tile[];
  selfSeat?: number;
  /** 刚摸进、尚未打出的那张（在手牌末尾） */
  justDrew?: Tile;
  availableActions: string[];
  logs: string[];
  scoreEvents: ScoreEvent[];
  winnerSeat?: number;
  huType?: string;
  roundIndex: number;
  maxRounds: number;
  /** 真人出牌/鸣牌截止时间（仅至少两名真人对局） */
  turnDeadlineAt?: number;
}

export const HUMAN_TURN_MS = 60_000;

interface InternalState {
  matchId: string;
  roomId: string;
  config: MahjongRoomConfig;
  phase: MahjongPhase;
  wall: Tile[];
  deadWallBaseUsed: number;
  gangCount: number;
  dealerSeat: number;
  currentSeat: number;
  players: MahjongPlayerState[];
  lastDiscard?: Tile;
  lastDiscardSeat?: number;
  claimOptions: ClaimOption[];
  claimResponses: Map<number, string>;
  logs: string[];
  scoreEvents: ScoreEvent[];
  winnerSeat?: number;
  huType?: string;
  roundIndex: number;
  justDrew?: Tile;
  pendingBuGang?: { seat: number; tile: Tile };
  turnDeadlineAt?: number;
}

function rollDealer(rng: () => number): number {
  return Math.floor(rng() * 4);
}

export class MahjongEngine {
  private s: InternalState;

  constructor(
    matchId: string,
    roomId: string,
    config: MahjongRoomConfig,
    seats: Array<{
      seat: number;
      userId: string;
      username: string;
      isBot: boolean;
      connected: boolean;
      score: number;
    }>,
    roundIndex: number,
    dealerSeat?: number,
    rng: () => number = Math.random,
  ) {
    const wall =
      config.tileCount === 144 ? buildWall144() : buildWall112();
    shuffleInPlace(wall, rng);
    const dealer = dealerSeat ?? rollDealer(rng);
    const players: MahjongPlayerState[] = seats.map((seat) => ({
      ...seat,
      hand: [],
      melds: [],
      discards: [],
    }));

    // 发 13 张
    for (let r = 0; r < 13; r++) {
      for (let i = 0; i < 4; i++) {
        const seat = (dealer + i) % 4;
        players[seat]!.hand.push(wall.pop()!);
      }
    }
    for (const p of players) p.hand = sortTiles(p.hand);

    this.s = {
      matchId,
      roomId,
      config,
      phase: "draw",
      wall,
      deadWallBaseUsed: 0,
      gangCount: 0,
      dealerSeat: dealer,
      currentSeat: dealer,
      players,
      claimOptions: [],
      claimResponses: new Map(),
      logs: [`第 ${roundIndex + 1} 局开始，庄家座位 ${dealer}`],
      scoreEvents: [],
      roundIndex,
    };

    this.drawForCurrent();
    this.armDeadline();
  }

  static fromJSON(raw: string): MahjongEngine {
    const data = JSON.parse(raw) as Omit<InternalState, "claimResponses"> & {
      claimResponses: Record<string, string> | Map<number, string>;
    };
    const eng = Object.create(MahjongEngine.prototype) as MahjongEngine;
    const responses =
      data.claimResponses instanceof Map
        ? data.claimResponses
        : new Map(
            Object.entries(data.claimResponses ?? {}).map(([k, v]) => [Number(k), v]),
          );
    eng.s = { ...(data as unknown as InternalState), claimResponses: responses };
    return eng;
  }

  toJSON(): string {
    const obj = {
      ...this.s,
      claimResponses: Object.fromEntries(this.s.claimResponses),
    };
    return JSON.stringify(obj);
  }

  private deadWallSize(): number {
    const base = this.s.config.tileCount === 112 ? 14 : 20;
    return this.s.gangCount % 2 === 1 ? base + 1 : base;
  }

  private canDraw(): boolean {
    return drawableCount(this.s.wall.length, this.s.config.tileCount, this.s.gangCount) > 0;
  }

  private drawForCurrent(): void {
    if (!this.canDraw()) {
      this.s.phase = "liuju";
      this.s.logs.push("流局（牌墙摸尽，庄家继续）");
      return;
    }
    const tile = this.s.wall.pop()!;
    const p = this.s.players[this.s.currentSeat]!;
    p.hand.push(tile);
    this.s.justDrew = tile;
    this.s.phase = "discard";
    this.s.logs.push(`座位${this.s.currentSeat} 摸牌`);
  }

  private applyScore(deltas: Array<{ seat: number; delta: number }>, kind: string, description: string): void {
    for (const d of deltas) {
      this.s.players[d.seat]!.score += d.delta;
    }
    this.s.scoreEvents.push({ kind, description, deltas, at: Date.now() });
    this.s.logs.push(description);
  }

  private dealerMul(seat: number): number {
    return seat === this.s.dealerSeat ? 2 : 1;
  }

  getAvailableActions(seat: number): string[] {
    const s = this.s;
    if (s.phase === "settled" || s.phase === "liuju") return [];
    if (s.phase === "claim") {
      const opt = s.claimOptions.find((o) => o.seat === seat);
      if (!opt || s.claimResponses.has(seat)) return [];
      return opt.actions;
    }
    if (s.phase === "discard" && s.currentSeat === seat) {
      const p = s.players[seat]!;
      const acts = ["discard"];
      if (evaluateHu(p.hand, p.melds, s.config.tileCount).ok) acts.push("hu");
      if (canAnGang(p.hand).length) acts.push("anGang");
      if (canBuGang(p.hand, p.melds).length) acts.push("buGang");
      return acts;
    }
    return [];
  }

  snapshotFor(viewerUserId?: string): MahjongSnapshot {
    const self = this.s.players.find((p) => p.userId === viewerUserId);
    const dead = this.deadWallSize();
    return {
      matchId: this.s.matchId,
      roomId: this.s.roomId,
      gameType: "mahjong",
      phase: this.s.phase,
      tileCount: this.s.config.tileCount,
      baseScore: this.s.config.baseScore,
      dealerSeat: this.s.dealerSeat,
      currentSeat: this.s.currentSeat,
      wallRemaining: this.s.wall.length,
      deadWall: dead,
      gangCount: this.s.gangCount,
      lastDiscard: this.s.lastDiscard,
      lastDiscardSeat: this.s.lastDiscardSeat,
      claimOptions: this.s.claimOptions,
      claimResponses: Object.fromEntries(this.s.claimResponses),
      players: this.s.players.map((p) => ({
        seat: p.seat,
        username: p.username,
        isBot: p.isBot,
        meldCount: p.melds.length,
        handCount: p.hand.length,
        discards: p.discards,
        melds: p.melds,
        score: p.score,
        connected: p.connected,
      })),
      selfHand: self ? self.hand : undefined,
      selfSeat: self?.seat,
      justDrew: self && this.s.justDrew && self.seat === this.s.currentSeat ? this.s.justDrew : undefined,
      availableActions: self ? this.getAvailableActions(self.seat) : [],
      logs: this.s.logs.slice(-40),
      scoreEvents: this.s.scoreEvents.slice(-20),
      winnerSeat: this.s.winnerSeat,
      huType: this.s.huType,
      roundIndex: this.s.roundIndex,
      maxRounds: this.s.config.maxRounds,
      turnDeadlineAt: this.s.turnDeadlineAt,
    };
  }

  isFinished(): boolean {
    return this.s.phase === "settled" || this.s.phase === "liuju";
  }

  getScores(): number[] {
    return this.s.players.map((p) => p.score);
  }

  getDealerSeat(): number {
    return this.s.dealerSeat;
  }

  getWinnerSeat(): number | undefined {
    return this.s.winnerSeat;
  }

  action(userId: string, action: string, data: Record<string, unknown> = {}): void {
    const player = this.s.players.find((p) => p.userId === userId);
    if (!player) throw Object.assign(new Error("不在对局中"), { code: "NOT_IN_MATCH" });
    const seat = player.seat;
    const allowed = this.getAvailableActions(seat);
    if (!allowed.includes(action) && action !== "pass") {
      // pass 在 claim 时单独处理
      if (!(this.s.phase === "claim" && action === "pass" && allowed.includes("pass"))) {
        if (!allowed.includes(action)) {
          throw Object.assign(new Error(`当前不可执行 ${action}`), { code: "BAD_ACTION" });
        }
      }
    }

    switch (action) {
      case "discard":
        this.doDiscard(seat, String(data.tileId ?? ""));
        break;
      case "peng":
        this.respondClaim(seat, "peng");
        break;
      case "mingGang":
        this.respondClaim(seat, "mingGang");
        break;
      case "hu":
        if (this.s.phase === "claim") this.respondClaim(seat, "hu");
        else this.doZimo(seat);
        break;
      case "pass":
        this.respondClaim(seat, "pass");
        break;
      case "anGang":
        this.doAnGang(seat, String(data.tileId ?? ""));
        break;
      case "buGang":
        this.doBuGang(seat, String(data.tileId ?? ""));
        break;
      default:
        throw Object.assign(new Error("未知动作"), { code: "BAD_ACTION" });
    }
    this.armDeadline();
  }

  private humanCount(): number {
    return this.s.players.filter((p) => !p.isBot).length;
  }

  /** 当前需要真人行动的座位 */
  waitingHumanSeats(): number[] {
    const s = this.s;
    if (s.phase === "settled" || s.phase === "liuju") return [];
    if (s.phase === "claim") {
      return s.claimOptions
        .filter((o) => !s.claimResponses.has(o.seat))
        .map((o) => o.seat)
        .filter((seat) => !s.players[seat]?.isBot);
    }
    if (s.phase === "discard" || s.phase === "draw") {
      const p = s.players[s.currentSeat];
      if (p && !p.isBot) return [p.seat];
    }
    return [];
  }

  private armDeadline(): void {
    if (this.humanCount() < 2) {
      this.s.turnDeadlineAt = undefined;
      return;
    }
    const waiting = this.waitingHumanSeats();
    this.s.turnDeadlineAt = waiting.length ? Date.now() + HUMAN_TURN_MS : undefined;
  }

  /** 真人超时：自动出牌或过 */
  tryHumanTimeout(): boolean {
    if (this.humanCount() < 2) return false;
    if (this.waitingHumanSeats().length && !this.s.turnDeadlineAt) {
      this.armDeadline();
      return false;
    }
    const at = this.s.turnDeadlineAt;
    if (!at || Date.now() < at) return false;
    const seats = this.waitingHumanSeats();
    const seat = seats[0];
    if (seat === undefined) {
      this.s.turnDeadlineAt = undefined;
      return false;
    }
    const p = this.s.players[seat]!;
    const acts = this.getAvailableActions(seat);
    this.s.logs.push(`座位${seat} 超时，系统代打`);
    try {
      if (acts.includes("discard")) {
        const tile = this.s.justDrew && p.hand.some((t) => t.id === this.s.justDrew!.id)
          ? this.s.justDrew
          : pickDiscard(p.hand);
        this.action(p.userId, "discard", { tileId: tile.id });
        return true;
      }
      if (acts.includes("pass")) {
        this.action(p.userId, "pass", {});
        return true;
      }
    } catch {
      this.s.turnDeadlineAt = undefined;
      return false;
    }
    this.s.turnDeadlineAt = undefined;
    return false;
  }

  private doDiscard(seat: number, tileId: string): void {
    const p = this.s.players[seat]!;
    const idx = p.hand.findIndex((t) => t.id === tileId);
    if (idx < 0) throw Object.assign(new Error("手牌中无此牌"), { code: "BAD_TILE" });
    const [tile] = p.hand.splice(idx, 1);
    p.discards.push(tile!);
    this.s.lastDiscard = tile;
    this.s.lastDiscardSeat = seat;
    this.s.justDrew = undefined;
    p.hand = sortTiles(p.hand);
    this.s.logs.push(`座位${seat} 打出 ${tileKey(tile!)}`);

    // 收集吃碰杠胡（无吃）
    const options: ClaimOption[] = [];
    for (const other of this.s.players) {
      if (other.seat === seat) continue;
      const acts: ClaimOption["actions"] = [];
      const trial = [...other.hand, tile!];
      if (evaluateHu(trial, other.melds, this.s.config.tileCount).ok) acts.push("hu");
      if (canMingGang(other.hand, tile!)) acts.push("mingGang");
      if (canPeng(other.hand, tile!)) acts.push("peng");
      if (acts.length) {
        acts.push("pass");
        options.push({ seat: other.seat, actions: acts });
      }
    }
    if (options.length) {
      this.s.phase = "claim";
      this.s.claimOptions = options;
      this.s.claimResponses = new Map();
      return;
    }
    this.advanceTurn();
  }

  private advanceTurn(): void {
    this.s.claimOptions = [];
    this.s.claimResponses = new Map();
    this.s.currentSeat = (this.s.currentSeat + 1) % 4;
    this.s.phase = "draw";
    this.drawForCurrent();
  }

  private respondClaim(seat: number, action: string): void {
    if (this.s.phase !== "claim") {
      throw Object.assign(new Error("当前非抢牌阶段"), { code: "BAD_PHASE" });
    }
    const opt = this.s.claimOptions.find((o) => o.seat === seat);
    if (!opt || !opt.actions.includes(action as ClaimOption["actions"][number])) {
      throw Object.assign(new Error("不可用的抢牌动作"), { code: "BAD_ACTION" });
    }
    this.s.claimResponses.set(seat, action);
    if (this.s.claimResponses.size < this.s.claimOptions.length) return;
    this.resolveClaims();
  }

  private resolveClaims(): void {
    const priority = (a: string) => (a === "hu" ? 3 : a === "mingGang" ? 2 : a === "peng" ? 1 : 0);
    let best: { seat: number; action: string } | null = null;
    for (const [seat, action] of this.s.claimResponses) {
      if (action === "pass") continue;
      if (!best || priority(action) > priority(best.action)) {
        best = { seat, action };
      } else if (best && priority(action) === priority(best.action) && action === "hu") {
        // 一炮多响：取距离打牌者最近的下家
        const discarder = this.s.lastDiscardSeat!;
        const dist = (s: number) => (s - discarder + 4) % 4;
        if (dist(seat) < dist(best.seat)) best = { seat, action };
      }
    }
    if (!best) {
      this.advanceTurn();
      return;
    }
    const tile = this.s.lastDiscard!;
    const from = this.s.lastDiscardSeat!;
    // 从弃牌区移除
    const disc = this.s.players[from]!.discards;
    const di = disc.findIndex((t) => t.id === tile.id);
    if (di >= 0) disc.splice(di, 1);

    const p = this.s.players[best.seat]!;
    if (best.action === "hu") {
      p.hand.push(tile);
      this.finishHu(best.seat, from, false);
      return;
    }
    if (best.action === "peng") {
      const taken = this.takeTiles(p, tileKey(tile), 2);
      p.melds.push({ type: "peng", tiles: [...taken, tile], fromSeat: from });
      p.hand = sortTiles(p.hand);
      this.s.justDrew = undefined;
      this.s.currentSeat = best.seat;
      this.s.phase = "discard";
      this.s.claimOptions = [];
      this.s.claimResponses = new Map();
      this.s.logs.push(`座位${best.seat} 碰`);
      return;
    }
    if (best.action === "mingGang") {
      const taken = this.takeTiles(p, tileKey(tile), 3);
      p.melds.push({ type: "mingGang", tiles: [...taken, tile], fromSeat: from });
      const base = this.s.config.baseScore;
      this.applyScore(
        [
          { seat: from, delta: -base },
          { seat: best.seat, delta: base },
        ],
        "mingGang",
        `座位${best.seat} 明杠，座位${from} 付 ${base}`,
      );
      this.s.gangCount += 1;
      this.s.currentSeat = best.seat;
      this.s.claimOptions = [];
      this.s.claimResponses = new Map();
      p.hand = sortTiles(p.hand);
      this.s.phase = "draw";
      this.drawForCurrent();
    }
  }

  private takeTiles(p: MahjongPlayerState, key: string, n: number): Tile[] {
    const out: Tile[] = [];
    for (let i = p.hand.length - 1; i >= 0 && out.length < n; i--) {
      if (tileKey(p.hand[i]!) === key) {
        out.push(p.hand.splice(i, 1)[0]!);
      }
    }
    if (out.length < n) throw Object.assign(new Error("牌不足"), { code: "BAD_TILE" });
    return out;
  }

  private doZimo(seat: number): void {
    const p = this.s.players[seat]!;
    const hu = evaluateHu(p.hand, p.melds, this.s.config.tileCount);
    if (!hu.ok) throw Object.assign(new Error("未胡牌"), { code: "NOT_HU" });
    this.finishHu(seat, undefined, true);
  }

  private finishHu(winner: number, discarder: number | undefined, zimo: boolean): void {
    const p = this.s.players[winner]!;
    const hu = evaluateHu(p.hand, p.melds, this.s.config.tileCount);
    const base = this.s.config.baseScore * hu.multiplier * this.dealerMul(winner);
    // 若点炮者是庄或赢家是庄已在 winner 乘；点炮时再考虑点炮方庄家？计划：庄家输赢再翻倍乘在该笔胡上
    let payBase = base;
    if (!zimo && discarder !== undefined && discarder === this.s.dealerSeat && winner !== this.s.dealerSeat) {
      payBase = base * 2;
    }
    const deltas: Array<{ seat: number; delta: number }> = [];
    if (zimo) {
      for (let i = 0; i < 4; i++) {
        if (i === winner) continue;
        let pay = this.s.config.baseScore * hu.multiplier;
        if (winner === this.s.dealerSeat || i === this.s.dealerSeat) pay *= 2;
        deltas.push({ seat: i, delta: -pay });
        deltas.push({ seat: winner, delta: pay });
      }
    } else {
      deltas.push({ seat: discarder!, delta: -payBase });
      deltas.push({ seat: winner, delta: payBase });
    }
    // 合并同座位
    const merged = new Map<number, number>();
    for (const d of deltas) merged.set(d.seat, (merged.get(d.seat) ?? 0) + d.delta);
    const flat = [...merged.entries()].map(([seat, delta]) => ({ seat, delta }));
    this.applyScore(
      flat,
      zimo ? "zimo" : "dianpao",
      `座位${winner} ${zimo ? "自摸" : "胡"} (${hu.patterns.join(",")})`,
    );
    this.s.winnerSeat = winner;
    this.s.huType = hu.patterns.join(",");
    this.s.phase = "settled";
    this.s.dealerSeat = winner; // 赢家坐庄
  }

  private doAnGang(seat: number, tileId: string): void {
    const p = this.s.players[seat]!;
    const candidates = canAnGang(p.hand);
    const tile = candidates.find((t) => t.id === tileId) ?? candidates[0];
    if (!tile) throw Object.assign(new Error("无法暗杠"), { code: "BAD_ACTION" });
    const key = tileKey(tile);
    const taken = this.takeTiles(p, key, 4);
    p.melds.push({ type: "anGang", tiles: taken });
    const base = this.s.config.baseScore;
    const deltas: Array<{ seat: number; delta: number }> = [];
    for (let i = 0; i < 4; i++) {
      if (i === seat) continue;
      deltas.push({ seat: i, delta: -2 * base });
      deltas.push({ seat: seat, delta: 2 * base });
    }
    const merged = new Map<number, number>();
    for (const d of deltas) merged.set(d.seat, (merged.get(d.seat) ?? 0) + d.delta);
    this.applyScore(
      [...merged.entries()].map(([s, delta]) => ({ seat: s, delta })),
      "anGang",
      `座位${seat} 暗杠，其余各付 ${2 * base}`,
    );
    this.s.gangCount += 1;
    this.s.phase = "draw";
    p.hand = sortTiles(p.hand);
    this.drawForCurrent();
  }

  private doBuGang(seat: number, tileId: string): void {
    const p = this.s.players[seat]!;
    const candidates = canBuGang(p.hand, p.melds);
    const tile = candidates.find((t) => t.id === tileId) ?? candidates[0];
    if (!tile) throw Object.assign(new Error("无法补杠"), { code: "BAD_ACTION" });
    const key = tileKey(tile);
    const idx = p.hand.findIndex((t) => tileKey(t) === key);
    const [t] = p.hand.splice(idx, 1);
    const meld = p.melds.find((m) => m.type === "peng" && tileKey(m.tiles[0]!) === key)!;
    meld.type = "buGang";
    meld.tiles.push(t!);
    const base = this.s.config.baseScore;
    const deltas: Array<{ seat: number; delta: number }> = [];
    for (let i = 0; i < 4; i++) {
      if (i === seat) continue;
      deltas.push({ seat: i, delta: -base });
      deltas.push({ seat: seat, delta: base });
    }
    const merged = new Map<number, number>();
    for (const d of deltas) merged.set(d.seat, (merged.get(d.seat) ?? 0) + d.delta);
    this.applyScore(
      [...merged.entries()].map(([s, delta]) => ({ seat: s, delta })),
      "buGang",
      `座位${seat} 碰后杠，其余各付 ${base}`,
    );
    this.s.gangCount += 1;
    this.s.phase = "draw";
    p.hand = sortTiles(p.hand);
    this.drawForCurrent();
  }

  /** 人机一步 */
  botAct(): boolean {
    const bots = this.s.players.filter((p) => p.isBot);
    for (const bot of bots) {
      const acts = this.getAvailableActions(bot.seat);
      if (!acts.length) continue;
      if (acts.includes("hu")) {
        this.action(bot.userId, "hu", {});
        return true;
      }
      if (acts.includes("mingGang")) {
        this.action(bot.userId, "mingGang", {});
        return true;
      }
      if (acts.includes("anGang")) {
        const t = canAnGang(bot.hand)[0];
        this.action(bot.userId, "anGang", { tileId: t?.id });
        return true;
      }
      if (acts.includes("buGang")) {
        const t = canBuGang(bot.hand, bot.melds)[0];
        this.action(bot.userId, "buGang", { tileId: t?.id });
        return true;
      }
      if (acts.includes("peng")) {
        // 简单：有碰就碰
        this.action(bot.userId, "peng", {});
        return true;
      }
      if (acts.includes("pass")) {
        this.action(bot.userId, "pass", {});
        return true;
      }
      if (acts.includes("discard")) {
        const tile = pickDiscard(bot.hand);
        this.action(bot.userId, "discard", { tileId: tile.id });
        return true;
      }
    }
    return false;
  }
}

function pickDiscard(hand: Tile[]): Tile {
  const counts = new Map<string, number>();
  for (const t of hand) counts.set(tileKey(t), (counts.get(tileKey(t)) ?? 0) + 1);
  // 孤张优先
  let best = hand[hand.length - 1]!;
  let bestScore = Infinity;
  for (const t of hand) {
    const c = counts.get(tileKey(t)) ?? 1;
    const score = c; // 越少越优先打
    if (score < bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}
