/** 麻将牌编码：suit + rank */
export type Suit = "wan" | "tong" | "tiao" | "zi";

export interface Tile {
  /** 唯一实例 id（同面值多张区分） */
  id: string;
  suit: Suit;
  /** wan/tong/tiao: 1-9; zi: 1东 2南 3西 4北 5中 6发 7白 */
  rank: number;
}

export function tileKey(t: Pick<Tile, "suit" | "rank">): string {
  return `${t.suit}:${t.rank}`;
}

export function tileLabel(t: Pick<Tile, "suit" | "rank">): string {
  if (t.suit === "wan") return `${t.rank}万`;
  if (t.suit === "tong") return `${t.rank}筒`;
  if (t.suit === "tiao") return `${t.rank}条`;
  const zi = ["", "东", "南", "西", "北", "中", "发", "白"];
  return zi[t.rank] ?? "?";
}

export function tileColorHint(t: Pick<Tile, "suit" | "rank">): string {
  if (t.suit === "wan") return "red";
  if (t.suit === "tong") return "blue";
  if (t.suit === "tiao") return "green";
  if (t.rank === 5) return "red";
  if (t.rank === 6) return "green";
  return "white";
}

let tileSeq = 0;

export function resetTileSeq(n = 0): void {
  tileSeq = n;
}

export function makeTile(suit: Suit, rank: number): Tile {
  tileSeq += 1;
  return { id: `t${tileSeq}`, suit, rank };
}

/** 112：万筒条各 36 + 红中 4 */
export function buildWall112(): Tile[] {
  resetTileSeq();
  const tiles: Tile[] = [];
  for (const suit of ["wan", "tong", "tiao"] as Suit[]) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let i = 0; i < 4; i++) tiles.push(makeTile(suit, rank));
    }
  }
  for (let i = 0; i < 4; i++) tiles.push(makeTile("zi", 5)); // 红中
  return tiles;
}

/** 144：标准万筒条 + 字牌 */
export function buildWall144(): Tile[] {
  resetTileSeq();
  const tiles: Tile[] = [];
  for (const suit of ["wan", "tong", "tiao"] as Suit[]) {
    for (let rank = 1; rank <= 9; rank++) {
      for (let i = 0; i < 4; i++) tiles.push(makeTile(suit, rank));
    }
  }
  for (let rank = 1; rank <= 7; rank++) {
    for (let i = 0; i < 4; i++) tiles.push(makeTile("zi", rank));
  }
  return tiles;
}

export function shuffleInPlace<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

export function countByKey(tiles: Tile[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tiles) {
    const k = tileKey(t);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export function sortTiles(tiles: Tile[]): Tile[] {
  const suitOrder: Record<Suit, number> = { wan: 0, tong: 1, tiao: 2, zi: 3 };
  return [...tiles].sort((a, b) => {
    const s = suitOrder[a.suit] - suitOrder[b.suit];
    if (s !== 0) return s;
    return a.rank - b.rank;
  });
}
