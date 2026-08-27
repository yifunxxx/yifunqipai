import blessed from "blessed";
import type { Widgets } from "blessed";
import { pokerLabel, tileColorHint } from "@yifun/qipai-shared";

type Screen = Widgets.Screen;
type Box = Widgets.BoxElement;

export type MjSeatSlot = "top" | "left" | "right" | "bottom";

export const MJ_REST_BORDER: Record<MjSeatSlot | "center", string> = {
  top: "cyan",
  left: "magenta",
  right: "yellow",
  bottom: "green",
  center: "white",
};

export interface GameBoard {
  root: Box;
  textMain: Box;
  mj: {
    top: Box;
    left: Box;
    center: Box;
    right: Box;
    bottom: Box;
    fx: Box;
  };
  th: {
    info: Box;
    seats: Box[];
    hint: Box;
  };
  showText(): void;
  showMahjong(): void;
  showTenhalf(seatCount: number): void;
  setMjBorder(slot: MjSeatSlot | "center", color: string, bold?: boolean): void;
  showFx(kind: "peng" | "hu" | "gang" | "wait", title: string, sub?: string): void;
  hideFx(): void;
}

/** 创建主区棋盘（麻将四家分区 + 十点半座位格） */
export function createGameBoard(parent: Screen): GameBoard {
  const root = blessed.box({
    parent,
    top: 3,
    left: 0,
    width: "70%",
    height: "100%-6",
    tags: true,
  });

  const textMain = blessed.box({
    parent: root,
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    tags: true,
    border: { type: "line" },
    label: " 主区 ",
    content: "",
  });

  const mjTop = blessed.box({
    parent: root,
    top: 0,
    left: 0,
    width: "100%",
    height: "24%",
    tags: true,
    wrap: false,
    scrollable: true,
    border: { type: "line" },
    label: " 对家 ",
    style: { border: { fg: "cyan" } },
    hidden: true,
  });
  const mjLeft = blessed.box({
    parent: root,
    top: "24%",
    left: 0,
    width: "30%",
    height: "36%",
    tags: true,
    wrap: false,
    scrollable: true,
    border: { type: "line" },
    label: " 上家 ",
    style: { border: { fg: "magenta" } },
    hidden: true,
  });
  const mjCenter = blessed.box({
    parent: root,
    top: "24%",
    left: "30%",
    width: "40%",
    height: "36%",
    tags: true,
    wrap: false,
    border: { type: "line" },
    label: " 公区 ",
    style: { border: { fg: "white" } },
    hidden: true,
  });
  const mjRight = blessed.box({
    parent: root,
    top: "24%",
    left: "70%",
    width: "30%",
    height: "36%",
    tags: true,
    wrap: false,
    scrollable: true,
    border: { type: "line" },
    label: " 下家 ",
    style: { border: { fg: "yellow" } },
    hidden: true,
  });
  const mjBottom = blessed.box({
    parent: root,
    top: "60%",
    left: 0,
    width: "100%",
    height: "40%",
    tags: true,
    wrap: false,
    border: { type: "line" },
    label: " 自家 ",
    style: { border: { fg: "green" } },
    hidden: true,
  });

  const mjFx = blessed.box({
    parent: root,
    top: "center",
    left: "center",
    width: 36,
    height: 8,
    tags: true,
    align: "center",
    valign: "middle",
    border: { type: "line" },
    hidden: true,
    shadow: true,
  });

  const thInfo = blessed.box({
    parent: root,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line" },
    label: " 十点半 ",
    style: { border: { fg: "white" } },
    hidden: true,
  });

  const thSeats: Box[] = [];
  for (let i = 0; i < 6; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    thSeats.push(
      blessed.box({
        parent: root,
        top: 3 + row * 5,
        left: col === 0 ? 0 : "50%",
        width: "50%",
        height: 5,
        tags: true,
        border: { type: "line" },
        label: ` 座位${i + 1} `,
        style: { border: { fg: col === 0 ? "cyan" : "yellow" } },
        hidden: true,
      }),
    );
  }

  const thHint = blessed.box({
    parent: root,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line" },
    label: " 提示 ",
    hidden: true,
  });

  const mjAll = [mjTop, mjLeft, mjCenter, mjRight, mjBottom];
  const mjBySlot: Record<MjSeatSlot | "center", Box> = {
    top: mjTop,
    left: mjLeft,
    right: mjRight,
    bottom: mjBottom,
    center: mjCenter,
  };

  function hideAll(): void {
    textMain.hide();
    for (const b of mjAll) b.hide();
    thInfo.hide();
    thHint.hide();
    for (const b of thSeats) b.hide();
  }

  function setMjBorder(slot: MjSeatSlot | "center", color: string, bold = false): void {
    const box = mjBySlot[slot];
    box.style.border = { fg: color };
    box.style.bold = bold;
  }

  function showFx(kind: "peng" | "hu" | "gang" | "wait", title: string, sub?: string): void {
    const palette: Record<typeof kind, { border: string; bg: string; fg: string }> = {
      peng: { border: "magenta", bg: "magenta", fg: "white" },
      hu: { border: "yellow", bg: "yellow", fg: "black" },
      gang: { border: "red", bg: "red", fg: "white" },
      wait: { border: "cyan", bg: "black", fg: "cyan" },
    };
    const p = palette[kind];
    mjFx.style.border = { fg: p.border };
    mjFx.style.bg = p.bg;
    mjFx.style.fg = p.fg;
    const star = kind === "wait" ? "·" : "*";
    mjFx.setContent(
      [
        `{bold}${star}  ${title}  ${star}{/}`,
        sub ? sub : "",
      ].join("\n"),
    );
    mjFx.show();
    mjFx.setFront();
  }

  function hideFx(): void {
    mjFx.hide();
  }

  return {
    root,
    textMain,
    mj: {
      top: mjTop,
      left: mjLeft,
      center: mjCenter,
      right: mjRight,
      bottom: mjBottom,
      fx: mjFx,
    },
    th: { info: thInfo, seats: thSeats, hint: thHint },
    showText() {
      hideFx();
      hideAll();
      textMain.show();
    },
    showMahjong() {
      hideAll();
      for (const b of mjAll) b.show();
    },
    showTenhalf(seatCount: number) {
      hideFx();
      hideAll();
      thInfo.show();
      thHint.show();
      for (let i = 0; i < thSeats.length; i++) {
        if (i < seatCount) thSeats[i]!.show();
        else thSeats[i]!.hide();
      }
    },
    setMjBorder,
    showFx,
    hideFx,
  };
}

type TileLike = { id?: string; suit: string; rank: number };

const RANK_CN = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
const ZI_FACE: Array<[string, string]> = [
  ["东", "风"],
  ["南", "风"],
  ["西", "风"],
  ["北", "风"],
  ["红", "中"],
  ["发", "财"],
  ["白", "板"],
];

function tileFace(t: TileLike): { a: string; b: string; label: string } {
  if (t.suit === "wan" || t.suit === "tong" || t.suit === "tiao") {
    const a = RANK_CN[t.rank] ?? "?";
    const b = t.suit === "wan" ? "万" : t.suit === "tong" ? "筒" : "条";
    return { a, b, label: `${a}${b}` };
  }
  const pair = ZI_FACE[t.rank - 1] ?? (["?", "?"] as [string, string]);
  return { a: pair[0], b: pair[1], label: `${pair[0]}${pair[1]}` };
}

function tileFg(t: TileLike, selected = false, locked = false): string {
  if (selected) return "white-fg";
  if (locked) return "yellow-fg";
  const hint = tileColorHint(t as never);
  if (hint === "red") return "red-fg";
  if (hint === "blue") return "blue-fg";
  if (hint === "green") return "green-fg";
  return "white-fg";
}

/** 一个汉字按 2 格宽补齐 */
function padFace(ch: string, width: number): string {
  const extra = Math.max(0, width - 2);
  const left = Math.floor(extra / 2);
  return `${" ".repeat(left)}${ch}${" ".repeat(extra - left)}`;
}

function paintFg(text: string, fg: string): string {
  return `{${fg}}{bold}${text}{/}`;
}

interface Chip {
  lines: string[];
  width: number;
}

export type TileChipSize = "hand" | "table" | "last";

interface TileGeom {
  w: number;
  h: number;
}

/** 高:宽 ≈ 43:33。容不下时按同比例从大到小选用。 */
const TILE_SCALES: TileGeom[] = [
  { w: 6, h: 4 },
  { w: 5, h: 3 },
  { w: 4, h: 3 },
  { w: 4, h: 2 },
];

function rowWidth(n: number, w: number, gap = 1): number {
  if (n <= 0) return 0;
  return n * w + (n - 1) * gap;
}

function pickGeom(n: number, cols: number, maxRows = 1): TileGeom {
  const count = Math.max(n, 1);
  for (const g of TILE_SCALES) {
    const per = Math.max(1, Math.floor((cols + 1) / (g.w + 1)));
    if (Math.ceil(count / per) <= maxRows) return g;
  }
  return TILE_SCALES[TILE_SCALES.length - 1]!;
}

function makeChip(t: TileLike, geom: TileGeom, selected = false, locked = false): Chip {
  const { a, b } = tileFace(t);
  const fg = tileFg(t, selected, locked);
  const paint = (s: string) => paintFg(s, fg);
  const inner = Math.max(2, geom.w - 2);
  const width = inner + 2;
  const top = `┌${"─".repeat(inner)}┐`;
  const bot = `└${"─".repeat(inner)}┘`;
  const ra = `│${padFace(a, inner)}│`;
  const rb = `│${padFace(b, inner)}│`;
  const raw = geom.h >= 4 ? [top, ra, rb, bot] : geom.h >= 3 ? [top, ra, rb] : [ra, rb];
  return { width, lines: raw.map(paint) };
}

function blankChip(width: number, height: number): Chip {
  return { width, lines: Array.from({ length: height }, () => " ".repeat(width)) };
}

function packChips(chips: Chip[], maxCols: number, gap = 1): string {
  if (!chips.length) return "";
  const h = chips[0]!.lines.length;
  const rows: Chip[][] = [];
  let cur: Chip[] = [];
  let used = 0;
  for (const chip of chips) {
    const need = chip.width + (cur.length ? gap : 0);
    if (cur.length && used + need > maxCols) {
      rows.push(cur);
      cur = [chip];
      used = chip.width;
    } else {
      used += need;
      cur.push(chip);
    }
  }
  if (cur.length) rows.push(cur);
  const gapStr = " ".repeat(gap);
  return rows
    .map((row) =>
      Array.from({ length: h }, (_, y) => row.map((c) => c.lines[y] ?? " ".repeat(c.width)).join(gapStr)).join("\n"),
    )
    .join("\n");
}

export function renderTiles(
  tiles: TileLike[],
  _size: TileChipSize,
  opts?: {
    cols?: number;
    cursor?: number;
    lockedTileId?: string | null;
    drawnId?: string;
    drawnGap?: number;
    maxRows?: number;
  },
): string {
  if (!tiles.length) return "-";
  const cols = Math.max(8, opts?.cols ?? 80);
  const drawnIndex = opts?.drawnId ? tiles.findIndex((t) => t.id === opts.drawnId) : -1;
  const extra = drawnIndex > 0 ? 1 : 0;
  const geom = pickGeom(tiles.length + extra, cols, opts?.maxRows ?? 1);
  const drawnGap = Math.max(2, Math.round((opts?.drawnGap ?? 4) * (geom.w / 6)));
  const chips: Chip[] = [];
  for (let i = 0; i < tiles.length; i++) {
    if (i === drawnIndex && i > 0) chips.push(blankChip(drawnGap, geom.h));
    const t = tiles[i]!;
    chips.push(makeChip(t, geom, i === opts?.cursor, !!t.id && t.id === opts?.lockedTileId));
  }
  return packChips(chips, cols, 1);
}

export function renderMelds(melds: Array<{ tiles: TileLike[] }>, cols: number): string {
  if (!melds.length) return "-";
  const n = melds.reduce((s, m) => s + m.tiles.length, 0) + Math.max(0, melds.length - 1);
  const geom = pickGeom(n, cols, 1);
  const chips: Chip[] = [];
  for (let i = 0; i < melds.length; i++) {
    if (i > 0) chips.push(blankChip(Math.max(1, Math.floor(geom.w / 2)), geom.h));
    for (const t of melds[i]!.tiles) chips.push(makeChip(t, geom));
  }
  return packChips(chips, cols, 1);
}

/** 对家横排副露|弃牌（容不下则缩小或改竖排）；上家/下家竖排并自动缩小 */
export function renderSeatTiles(
  melds: Array<{ tiles: TileLike[] }>,
  discards: TileLike[],
  cols: number,
  layout: "row" | "stack",
): string {
  const meldTiles = melds.flatMap((m) => m.tiles);
  const discs = discards.slice(-16);
  const n1 = meldTiles.length;
  const n2 = discs.length;
  if (!n1 && !n2) return "-";

  if (layout === "row") {
    let geom = TILE_SCALES[TILE_SCALES.length - 1]!;
    let oneRow = false;
    for (const g of TILE_SCALES) {
      const sep = n1 > 0 && n2 > 0 ? 3 : 0;
      if (rowWidth(n1, g.w) + sep + rowWidth(n2, g.w) <= cols) {
        geom = g;
        oneRow = true;
        break;
      }
    }
    if (oneRow) {
      const chips: Chip[] = [];
      for (const t of meldTiles) chips.push(makeChip(t, geom));
      if (n1 && n2) chips.push(blankChip(3, geom.h));
      for (const t of discs) chips.push(makeChip(t, geom));
      const w1 = rowWidth(n1, geom.w);
      const label = n1 && n2 ? `副露${" ".repeat(Math.max(1, w1 + 3 - 4))}弃牌` : n1 ? "副露" : "弃牌";
      return `${label}\n${packChips(chips, cols, 1)}`;
    }
  }

  const parts: string[] = [];
  if (n1) parts.push(`副露\n${renderTiles(meldTiles, "table", { cols, maxRows: 2 })}`);
  if (n2) parts.push(`弃牌\n${renderTiles(discs, "table", { cols, maxRows: 2 })}`);
  return parts.join("\n");
}

/** 单行文字（日志等窄处） */
export function colorTile(t: TileLike): string {
  const { label } = tileFace(t);
  return paintFg(label, tileFg(t));
}

export function renderBigHand(
  tiles: Array<{ id: string; suit: string; rank: number }>,
  cursor: number,
  lockedTileId: string | null,
  drawnId?: string,
  cols = 80,
): string {
  if (!tiles.length) return "(无手牌)";
  return renderTiles(tiles, "hand", { cols, cursor, lockedTileId, drawnId, drawnGap: 4 });
}

export function colorPoker(c: { suit: string; rank: number }): string {
  const label = pokerLabel(c as never);
  const fg = c.suit === "H" || c.suit === "D" ? "red-fg" : "white-fg";
  return paintFg(label, fg);
}
