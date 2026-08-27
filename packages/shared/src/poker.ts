/** 扑克牌（十点半） */
export type PokerSuit = "S" | "H" | "D" | "C";

export interface PokerCard {
  id: string;
  suit: PokerSuit;
  /** 1=A … 13=K */
  rank: number;
}

export function pokerValue(card: PokerCard): number {
  if (card.rank === 1) return 1;
  if (card.rank >= 11) return 0.5;
  return card.rank;
}

export function handPoints(cards: PokerCard[]): number {
  return cards.reduce((s, c) => s + pokerValue(c), 0);
}

export function isBust(cards: PokerCard[]): boolean {
  return handPoints(cards) > 10.5;
}

export function isTenHalf(cards: PokerCard[]): boolean {
  return Math.abs(handPoints(cards) - 10.5) < 1e-9;
}

/** 五龙：恰好 5 张且未炸 */
export function isWuLong(cards: PokerCard[]): boolean {
  return cards.length === 5 && !isBust(cards);
}

export type TenhalfStrength = "wulong" | "tenhalf" | "points" | "bust";

export function strengthOf(cards: PokerCard[]): {
  kind: TenhalfStrength;
  points: number;
} {
  if (isBust(cards)) return { kind: "bust", points: handPoints(cards) };
  if (isWuLong(cards)) return { kind: "wulong", points: handPoints(cards) };
  if (isTenHalf(cards)) return { kind: "tenhalf", points: 10.5 };
  return { kind: "points", points: handPoints(cards) };
}

const KIND_RANK: Record<TenhalfStrength, number> = {
  wulong: 3,
  tenhalf: 2,
  points: 1,
  bust: 0,
};

/** 比较两手牌：>0 a 胜，<0 b 胜，0 平（同档同点） */
export function compareHands(a: PokerCard[], b: PokerCard[]): number {
  const sa = strengthOf(a);
  const sb = strengthOf(b);
  if (KIND_RANK[sa.kind] !== KIND_RANK[sb.kind]) {
    return KIND_RANK[sa.kind] - KIND_RANK[sb.kind];
  }
  if (sa.kind === "bust") return 0;
  if (sa.kind === "points" || sa.kind === "wulong") {
    if (sa.points !== sb.points) return sa.points - sb.points;
  }
  return 0;
}

let pokerSeq = 0;

export function buildPokerDeck(): PokerCard[] {
  pokerSeq = 0;
  const suits: PokerSuit[] = ["S", "H", "D", "C"];
  const cards: PokerCard[] = [];
  for (const suit of suits) {
    for (let rank = 1; rank <= 13; rank++) {
      pokerSeq += 1;
      cards.push({ id: `p${pokerSeq}`, suit, rank });
    }
  }
  return cards;
}

const SUIT_SYMBOL: Record<PokerSuit, string> = {
  S: "♠",
  H: "♥",
  D: "♦",
  C: "♣",
};

/** 展示用：符号 + 点数，如 ♠A、♥10、♦K */
export function pokerLabel(c: PokerCard): string {
  const ranks = ["", "A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  return `${SUIT_SYMBOL[c.suit]}${ranks[c.rank]}`;
}

export function isRedSuit(suit: PokerSuit): boolean {
  return suit === "H" || suit === "D";
}
