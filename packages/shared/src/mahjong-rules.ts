import { countByKey, tileKey, type Suit, type Tile } from "./tiles.js";

export type MeldType = "peng" | "mingGang" | "anGang" | "buGang";

export interface Meld {
  type: MeldType;
  tiles: Tile[];
  /** 点杠/点碰来源座位，暗杠无 */
  fromSeat?: number;
}

export type HuPattern = "pingHu" | "qingYiSe" | "qiDui" | "shiSanYao";

export interface HuResult {
  ok: boolean;
  patterns: HuPattern[];
  /** 相对底分的倍数（不含庄家翻倍） */
  multiplier: number;
}

function isSameSuit(tiles: Tile[]): boolean {
  if (tiles.length === 0) return false;
  const s = tiles[0]!.suit;
  return tiles.every((t) => t.suit === s && s !== "zi");
}

function allKeys(tiles: Tile[]): string[] {
  return tiles.map(tileKey);
}

/** 标准胡：4 面子 + 1 将（面子为刻或顺；字牌只能刻） */
export function canWinStandard(hand: Tile[]): boolean {
  if (hand.length % 3 !== 2) return false;
  const counts = countByKey(hand);
  const keys = [...counts.keys()].sort();

  function tryRemove(remain: Map<string, number>): boolean {
    let first: string | null = null;
    for (const k of keys) {
      if ((remain.get(k) ?? 0) > 0) {
        first = k;
        break;
      }
    }
    if (!first) return true;
    const n = remain.get(first)!;

    // 刻子
    if (n >= 3) {
      remain.set(first, n - 3);
      if (tryRemove(remain)) return true;
      remain.set(first, n);
    }

    // 顺子（仅数牌）
    const [suit, rankStr] = first.split(":") as [Suit, string];
    const rank = Number(rankStr);
    if (suit !== "zi" && rank <= 7) {
      const k2 = `${suit}:${rank + 1}`;
      const k3 = `${suit}:${rank + 2}`;
      if ((remain.get(k2) ?? 0) > 0 && (remain.get(k3) ?? 0) > 0) {
        remain.set(first, n - 1);
        remain.set(k2, (remain.get(k2) ?? 0) - 1);
        remain.set(k3, (remain.get(k3) ?? 0) - 1);
        if (tryRemove(remain)) return true;
        remain.set(first, n);
        remain.set(k2, (remain.get(k2) ?? 0) + 1);
        remain.set(k3, (remain.get(k3) ?? 0) + 1);
      }
    }
    return false;
  }

  for (const jk of keys) {
    if ((counts.get(jk) ?? 0) < 2) continue;
    const remain = new Map(counts);
    remain.set(jk, remain.get(jk)! - 2);
    if (tryRemove(remain)) return true;
  }
  return false;
}

export function isQiDui(hand: Tile[]): boolean {
  if (hand.length !== 14) return false;
  const counts = countByKey(hand);
  if (counts.size !== 7) return false;
  for (const n of counts.values()) {
    if (n !== 2) return false;
  }
  return true;
}

const YAO_KEYS = new Set([
  "wan:1",
  "wan:9",
  "tong:1",
  "tong:9",
  "tiao:1",
  "tiao:9",
  "zi:1",
  "zi:2",
  "zi:3",
  "zi:4",
  "zi:5",
  "zi:6",
  "zi:7",
]);

export function isShiSanYao(hand: Tile[]): boolean {
  if (hand.length !== 14) return false;
  const counts = countByKey(hand);
  const keys = [...counts.keys()];
  if (keys.length !== 13) return false;
  for (const k of keys) {
    if (!YAO_KEYS.has(k)) return false;
  }
  let pair = 0;
  for (const n of counts.values()) {
    if (n === 2) pair++;
    else if (n !== 1) return false;
  }
  return pair === 1;
}

export function isQingYiSe(allTiles: Tile[]): boolean {
  return isSameSuit(allTiles);
}

/**
 * 判断手牌+副露是否可胡（需已含和牌张）。
 * tileCount=112 时不允许十三幺。
 */
export function evaluateHu(
  concealed: Tile[],
  melds: Meld[],
  tileCount: 112 | 144,
): HuResult {
  const patterns: HuPattern[] = [];
  const all = [...concealed, ...melds.flatMap((m) => m.tiles)];

  const qi = isQiDui(concealed) && melds.length === 0;
  const yao = tileCount === 144 && isShiSanYao(concealed) && melds.length === 0;
  const std = canWinStandard(concealed);

  if (!qi && !yao && !std) {
    return { ok: false, patterns: [], multiplier: 0 };
  }

  if (qi) patterns.push("qiDui");
  if (yao) patterns.push("shiSanYao");
  if (std && !qi && !yao) patterns.push("pingHu");

  if (isQingYiSe(all) && (std || qi)) {
    if (!patterns.includes("qingYiSe")) patterns.push("qingYiSe");
  }

  let multiplier = 1;
  if (
    patterns.includes("qingYiSe") ||
    patterns.includes("qiDui") ||
    patterns.includes("shiSanYao")
  ) {
    multiplier = 2;
  }

  return { ok: true, patterns, multiplier };
}

export function canPeng(hand: Tile[], tile: Tile): boolean {
  const k = tileKey(tile);
  return (countByKey(hand).get(k) ?? 0) >= 2;
}

export function canMingGang(hand: Tile[], tile: Tile): boolean {
  const k = tileKey(tile);
  return (countByKey(hand).get(k) ?? 0) >= 3;
}

export function canAnGang(hand: Tile[]): Tile[] {
  const counts = countByKey(hand);
  const out: Tile[] = [];
  const seen = new Set<string>();
  for (const t of hand) {
    const k = tileKey(t);
    if (counts.get(k) === 4 && !seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
}

export function canBuGang(hand: Tile[], melds: Meld[]): Tile[] {
  const out: Tile[] = [];
  for (const m of melds) {
    if (m.type !== "peng") continue;
    const k = tileKey(m.tiles[0]!);
    const hit = hand.find((t) => tileKey(t) === k);
    if (hit) out.push(hit);
  }
  return out;
}

export { allKeys };
