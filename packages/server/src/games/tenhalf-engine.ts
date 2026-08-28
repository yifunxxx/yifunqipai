import {
  buildPokerDeck,
  compareHands,
  handPoints,
  isBust,
  isTenHalf,
  isWuLong,
  pokerLabel,
  shuffleInPlace,
  strengthOf,
  type PokerCard,
  type ScoreEvent,
  type TenhalfRoomConfig,
} from "@yifun/qipai-shared";

export type TenhalfPhase =
  | "deal"
  | "turn"
  | "reveal_auto"
  | "draw_tie"
  | "settled";

export interface TenhalfPlayerState {
  seat: number;
  userId: string;
  username: string;
  isBot: boolean;
  connected: boolean;
  hole: PokerCard | null;
  open: PokerCard[];
  stopped: boolean;
  busted: boolean;
  revealed: boolean;
  score: number;
  potShare: number;
}

export interface TenhalfSnapshot {
  matchId: string;
  roomId: string;
  gameType: "tenhalf";
  phase: TenhalfPhase;
  mode: "banker" | "free";
  bankerSeat: number;
  currentSeat: number;
  potTotal: number;
  potPerPlayer: number;
  deckRemaining: number;
  players: Array<{
    seat: number;
    username: string;
    isBot: boolean;
    connected: boolean;
    cardCount: number;
    open: PokerCard[];
    hole?: PokerCard | null;
    points?: number;
    stopped: boolean;
    busted: boolean;
    revealed: boolean;
    score: number;
    strength?: string;
  }>;
  selfSeat?: number;
  availableActions: string[];
  logs: string[];
  scoreEvents: ScoreEvent[];
  drawTieSeats?: number[];
  drawCards?: PokerCard[];
}

interface Internal {
  matchId: string;
  roomId: string;
  config: TenhalfRoomConfig;
  phase: TenhalfPhase;
  deck: PokerCard[];
  players: TenhalfPlayerState[];
  bankerSeat: number;
  /** 本局第一个行动座位（通比=赢家；打庄=庄家的下家） */
  startSeat: number;
  currentSeat: number;
  potTotal: number;
  logs: string[];
  scoreEvents: ScoreEvent[];
  drawTieSeats: number[];
  drawCards: PokerCard[];
  drawRound: number;
  autoFinishActive: boolean;
}

export class TenhalfEngine {
  private s: Internal;

  constructor(
    matchId: string,
    roomId: string,
    config: TenhalfRoomConfig,
    seats: Array<{
      seat: number;
      userId: string;
      username: string;
      isBot: boolean;
      connected: boolean;
      score: number;
    }>,
    rng: () => number = Math.random,
    startSeat?: number,
  ) {
    const deck = shuffleInPlace(buildPokerDeck(), rng);
    const potPer = config.potPerPlayer;
    const players: TenhalfPlayerState[] = seats.map((seat) => ({
      ...seat,
      hole: null,
      open: [],
      stopped: false,
      busted: false,
      revealed: false,
      potShare: potPer,
    }));
    const n = Math.max(1, players.length);
    const start = ((startSeat ?? 0) % n + n) % n;
    // 通比无庄；打庄由上一局赢家（首局房主）坐庄，闲家先行动
    const bankerSeat = config.mode === "banker" ? start : -1;
    const currentSeat = config.mode === "banker" ? (start + 1) % n : start;
    // 各发一张暗牌
    for (const p of players) {
      p.hole = deck.pop()!;
    }
    this.s = {
      matchId,
      roomId,
      config,
      phase: "turn",
      deck,
      players,
      bankerSeat,
      startSeat: start,
      currentSeat,
      potTotal: potPer * players.length,
      logs: [
        `十点半开始（${config.mode === "banker" ? "打庄" : "通比"}），锅底 ${potPer * players.length}`,
      ],
      scoreEvents: [],
      drawTieSeats: [],
      drawCards: [],
      drawRound: 0,
      autoFinishActive: false,
    };
    this.skipStopped();
  }

  static fromJSON(raw: string): TenhalfEngine {
    const data = JSON.parse(raw) as Internal;
    const eng = Object.create(TenhalfEngine.prototype) as TenhalfEngine;
    if (typeof data.startSeat !== "number") {
      data.startSeat = data.config?.mode === "banker" ? data.bankerSeat ?? 0 : 0;
    }
    if (data.config?.mode === "free" && data.bankerSeat === 0 && data.phase !== "settled") {
      // 旧存档通比误把房主当庄：进行中的局去掉庄标记
      data.bankerSeat = -1;
    }
    eng.s = data;
    return eng;
  }

  toJSON(): string {
    return JSON.stringify(this.s);
  }

  isFinished(): boolean {
    return this.s.phase === "settled";
  }

  getScores(): number[] {
    return this.s.players.map((p) => p.score);
  }

  getScoreEvents(): ScoreEvent[] {
    return this.s.scoreEvents;
  }

  getStartSeat(): number {
    return this.s.startSeat;
  }

  /** 本局赢家座位：分差最高者；并列则保留本局起始座位 */
  getWinnerSeat(): number {
    const scores = this.getScores();
    if (!scores.length) return this.s.startSeat;
    let best = 0;
    for (let i = 1; i < scores.length; i++) {
      if ((scores[i] ?? 0) > (scores[best] ?? 0)) best = i;
    }
    const top = scores[best] ?? 0;
    const tied = scores.map((s, i) => (s === top ? i : -1)).filter((i) => i >= 0);
    if (tied.length > 1 && tied.includes(this.s.startSeat)) return this.s.startSeat;
    return best;
  }

  private allCards(p: TenhalfPlayerState): PokerCard[] {
    return p.hole ? [p.hole, ...p.open] : [...p.open];
  }

  private skipStopped(): void {
    const n = this.s.players.length;
    for (let i = 0; i < n; i++) {
      const p = this.s.players[this.s.currentSeat]!;
      if (!p.stopped && !p.busted && !p.revealed) return;
      this.s.currentSeat = (this.s.currentSeat + 1) % n;
    }
    this.trySettleOrAuto();
  }

  private activeNeedsDecision(): boolean {
    return this.s.players.some((p) => !p.stopped && !p.busted && !p.revealed);
  }

  private markSpecial(p: TenhalfPlayerState): void {
    const cards = this.allCards(p);
    if (isWuLong(cards) || isTenHalf(cards)) {
      p.revealed = true;
      p.stopped = true;
      this.s.logs.push(
        `座位${p.seat} 亮牌：${isWuLong(cards) ? "五龙" : "十点半"}`,
      );
      this.s.autoFinishActive = true;
    }
    if (isBust(cards)) {
      p.busted = true;
      p.stopped = true;
      p.revealed = true;
      this.s.logs.push(`座位${p.seat} 炸了（${handPoints(cards)}）`);
    }
  }

  getAvailableActions(seat: number): string[] {
    if (this.s.phase === "draw_tie") {
      // 系统自动抽，玩家无操作
      return [];
    }
    if (this.s.phase !== "turn" && this.s.phase !== "reveal_auto") return [];
    if (this.s.autoFinishActive) return [];
    const p = this.s.players[seat];
    if (!p || this.s.currentSeat !== seat) return [];
    if (p.stopped || p.busted || p.revealed) return [];
    return ["hit", "stand"];
  }

  snapshotFor(viewerUserId?: string): TenhalfSnapshot {
    const self = this.s.players.find((p) => p.userId === viewerUserId);
    return {
      matchId: this.s.matchId,
      roomId: this.s.roomId,
      gameType: "tenhalf",
      phase: this.s.phase,
      mode: this.s.config.mode,
      bankerSeat: this.s.bankerSeat,
      currentSeat: this.s.currentSeat,
      potTotal: this.s.potTotal,
      potPerPlayer: this.s.config.potPerPlayer,
      deckRemaining: this.s.deck.length,
      players: this.s.players.map((p) => {
        const showAll = p.revealed || p.busted || this.s.phase === "settled" || p.userId === viewerUserId;
        const cards = this.allCards(p);
        return {
          seat: p.seat,
          username: p.username,
          isBot: p.isBot,
          connected: p.connected,
          cardCount: cards.length,
          open: p.open,
          hole: showAll ? p.hole : null,
          points: showAll ? handPoints(cards) : undefined,
          stopped: p.stopped,
          busted: p.busted,
          revealed: p.revealed,
          score: p.score,
          strength: showAll ? strengthOf(cards).kind : undefined,
        };
      }),
      selfSeat: self?.seat,
      availableActions: self ? this.getAvailableActions(self.seat) : [],
      logs: this.s.logs.slice(-40),
      scoreEvents: this.s.scoreEvents.slice(-20),
      drawTieSeats: this.s.drawTieSeats,
      drawCards: this.s.drawCards,
    };
  }

  action(userId: string, action: string, _data: Record<string, unknown> = {}): void {
    const p = this.s.players.find((x) => x.userId === userId);
    if (!p) throw Object.assign(new Error("不在对局中"), { code: "NOT_IN_MATCH" });
    const allowed = this.getAvailableActions(p.seat);
    if (!allowed.includes(action)) {
      throw Object.assign(new Error(`当前不可执行 ${action}`), { code: "BAD_ACTION" });
    }
    if (action === "hit") this.hit(p.seat);
    else if (action === "stand") this.stand(p.seat);
  }

  private hit(seat: number): void {
    const p = this.s.players[seat]!;
    if (!this.s.deck.length) {
      this.stand(seat);
      return;
    }
    const card = this.s.deck.pop()!;
    p.open.push(card);
    this.s.logs.push(`座位${seat} 要牌 ${pokerLabel(card)}`);
    this.markSpecial(p);
    if (p.stopped || p.busted || p.revealed) {
      this.nextSeat();
    }
    if (this.s.autoFinishActive) this.s.phase = "reveal_auto";
  }

  private stand(seat: number): void {
    const p = this.s.players[seat]!;
    p.stopped = true;
    this.s.logs.push(`座位${seat} 停牌（${handPoints(this.allCards(p))}）`);
    this.nextSeat();
    if (this.s.autoFinishActive) this.s.phase = "reveal_auto";
  }

  private nextSeat(): void {
    const n = this.s.players.length;
    this.s.currentSeat = (this.s.currentSeat + 1) % n;
    this.skipStopped();
  }

  private remainingAuto(): TenhalfPlayerState[] {
    return this.s.players.filter((p) => !p.stopped && !p.busted && !p.revealed);
  }

  private nextAutoPlayer(): TenhalfPlayerState | undefined {
    const n = this.s.players.length;
    for (let i = 0; i < n; i++) {
      const p = this.s.players[(this.s.currentSeat + i) % n]!;
      if (!p.stopped && !p.busted && !p.revealed) return p;
    }
    return undefined;
  }

  private trySettleOrAuto(): void {
    if (this.s.autoFinishActive) {
      if (this.remainingAuto().length) {
        this.s.phase = "reveal_auto";
        return;
      }
      this.settle();
      return;
    }
    if (!this.activeNeedsDecision()) {
      this.settle();
    }
  }

  /**
   * 有人亮五龙/十点半后，其余未停玩家每次只自动摸一张，
   * 由人机节拍驱动，方便客户端逐步展示。
   */
  stepAutoFinish(): boolean {
    this.s.autoFinishActive = true;
    this.s.phase = "reveal_auto";
    const p = this.nextAutoPlayer();
    if (!p) {
      this.settle();
      return true;
    }
    this.s.currentSeat = p.seat;
    if (!this.s.deck.length) {
      p.stopped = true;
      this.s.logs.push(`座位${p.seat} 牌堆已空，停牌`);
      if (!this.remainingAuto().length) this.settle();
      return true;
    }
    const card = this.s.deck.pop()!;
    p.open.push(card);
    this.s.logs.push(`座位${p.seat} 自动要牌 ${pokerLabel(card)}`);
    this.markSpecial(p);
    const cards = this.allCards(p);
    if (!p.stopped && !p.busted && !p.revealed && cards.length >= 5) {
      p.stopped = true;
    }
    if (!this.remainingAuto().length) this.settle();
    return true;
  }

  private settle(): void {
    if (this.s.config.mode === "free") this.settleFree();
    else this.settleBanker();
  }

  private apply(deltas: Array<{ seat: number; delta: number }>, kind: string, desc: string): void {
    for (const d of deltas) this.s.players[d.seat]!.score += d.delta;
    this.s.scoreEvents.push({ kind, description: desc, deltas, at: Date.now() });
    this.s.logs.push(desc);
  }

  private settleFree(): void {
    const alive = this.s.players.filter((p) => !p.busted);
    const pot = this.s.potTotal;
    if (alive.length === 0) {
      // 全炸，平分退回
      const share = Math.floor(pot / this.s.players.length);
      this.apply(
        this.s.players.map((p) => ({ seat: p.seat, delta: share - p.potShare })),
        "draw",
        "全员炸，锅底平分退回",
      );
      this.s.phase = "settled";
      return;
    }

    // 找最强
    let best = alive[0]!;
    const tied: TenhalfPlayerState[] = [best];
    for (let i = 1; i < alive.length; i++) {
      const p = alive[i]!;
      const cmp = compareHands(this.allCards(p), this.allCards(best));
      if (cmp > 0) {
        best = p;
        tied.length = 0;
        tied.push(p);
      } else if (cmp === 0) {
        tied.push(p);
      }
    }

    // 炸的人份额已在锅里，胜者通吃
    if (tied.length === 1) {
      const winner = tied[0]!;
      const deltas = this.s.players.map((p) => ({
        seat: p.seat,
        delta: p.seat === winner.seat ? pot - p.potShare : -p.potShare,
      }));
      this.apply(deltas, "free_win", `通比：座位${winner.seat} 通吃`);
      this.s.phase = "settled";
      return;
    }

    // 同档抽牌
    this.s.drawTieSeats = tied.map((t) => t.seat);
    this.resolveDrawTie(tied, pot);
  }

  private resolveDrawTie(tied: TenhalfPlayerState[], pot: number): void {
    this.s.phase = "draw_tie";
    this.s.drawCards = [];
    const draws: PokerCard[] = [];
    for (const p of tied) {
      const c = this.s.deck.pop() ?? { id: "x", suit: "S" as const, rank: 1 };
      draws.push(c);
      this.s.drawCards.push(c);
    }
    this.s.logs.push(`同档抽牌决胜：${tied.map((t, i) => `座位${t.seat}=${pokerLabel(draws[i]!)}`).join(", ")}`);

    let bestIdx = 0;
    const still: number[] = [0];
    for (let i = 1; i < draws.length; i++) {
      const a = pokerValueSimple(draws[i]!);
      const b = pokerValueSimple(draws[bestIdx]!);
      if (a > b) {
        bestIdx = i;
        still.length = 0;
        still.push(i);
      } else if (a === b) still.push(i);
    }

    this.s.drawRound += 1;
    if (still.length > 1 && this.s.drawRound < 2) {
      // 再抽一轮
      const again = still.map((i) => tied[i]!);
      this.resolveDrawTie(again, pot);
      return;
    }
    if (still.length > 1) {
      // 两次都和则平分
      const share = Math.floor(pot / still.length);
      const deltas = this.s.players.map((p) => {
        if (still.some((i) => tied[i]!.seat === p.seat)) {
          return { seat: p.seat, delta: share - p.potShare };
        }
        return { seat: p.seat, delta: -p.potShare };
      });
      // 修正：未进决赛的已输掉份额；决赛平分 pot
      this.apply(deltas, "free_split", "通比抽牌两次仍和，平分锅底");
      this.s.phase = "settled";
      return;
    }
    const winner = tied[still[0]!]!;
    const deltas = this.s.players.map((p) => ({
      seat: p.seat,
      delta: p.seat === winner.seat ? pot - p.potShare : -p.potShare,
    }));
    this.apply(deltas, "free_win", `通比抽牌：座位${winner.seat} 获胜`);
    this.s.phase = "settled";
  }

  private settleBanker(): void {
    const banker = this.s.players[this.s.bankerSeat]!;
    const deltas = new Map<number, number>();
    const add = (seat: number, d: number) => deltas.set(seat, (deltas.get(seat) ?? 0) + d);

    for (const p of this.s.players) {
      if (p.seat === banker.seat) continue;
      const share = p.potShare;
      if (p.busted && !banker.busted) {
        add(p.seat, -share);
        add(banker.seat, share);
        continue;
      }
      if (banker.busted && !p.busted) {
        add(banker.seat, -share);
        add(p.seat, share);
        continue;
      }
      if (p.busted && banker.busted) {
        // 互炸：闲家份额给？按约定闲炸只输给庄；庄也炸则对未炸闲赔——两者都炸则互不结算该对
        continue;
      }
      const cmp = compareHands(this.allCards(p), this.allCards(banker));
      if (cmp > 0) {
        add(banker.seat, -share);
        add(p.seat, share);
      } else if (cmp < 0) {
        add(p.seat, -share);
        add(banker.seat, share);
      } else {
        // 同档抽牌（简化：一次，和则不分）
        const pc = this.s.deck.pop();
        const bc = this.s.deck.pop();
        if (pc && bc) {
          const pv = pokerValueSimple(pc);
          const bv = pokerValueSimple(bc);
          this.s.logs.push(`庄闲抽牌：闲${pokerLabel(pc)} vs 庄${pokerLabel(bc)}`);
          if (pv > bv) {
            add(banker.seat, -share);
            add(p.seat, share);
          } else if (pv < bv) {
            add(p.seat, -share);
            add(banker.seat, share);
          }
        }
      }
    }
    this.apply(
      [...deltas.entries()].map(([seat, delta]) => ({ seat, delta })),
      "banker_settle",
      "打庄结算完成",
    );
    this.s.phase = "settled";
  }

  /** 真人中途离开：该座位改由人机接手 */
  convertHumanToBot(userId: string): boolean {
    const p = this.s.players.find((x) => x.userId === userId && !x.isBot);
    if (!p) return false;
    p.isBot = true;
    p.connected = true;
    return true;
  }

  botAct(): boolean {
    if (this.s.phase === "draw_tie") return false;
    if (this.s.phase === "settled") return false;
    if (this.s.autoFinishActive || this.s.phase === "reveal_auto") {
      return this.stepAutoFinish();
    }
    for (const p of this.s.players) {
      if (!p.isBot) continue;
      const acts = this.getAvailableActions(p.seat);
      if (!acts.length) continue;
      const pts = handPoints(this.allCards(p));
      if (pts >= this.s.config.botStopAt && acts.includes("stand")) {
        this.action(p.userId, "stand");
        return true;
      }
      if (acts.includes("hit")) {
        this.action(p.userId, "hit");
        return true;
      }
      if (acts.includes("stand")) {
        this.action(p.userId, "stand");
        return true;
      }
    }
    return false;
  }
}

function pokerValueSimple(c: PokerCard): number {
  if (c.rank === 1) return 1;
  if (c.rank >= 11) return 0.5;
  return c.rank;
}
