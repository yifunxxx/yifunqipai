import blessed from "blessed";
import type { Widgets } from "blessed";
import { pokerLabel, tileColorHint } from "@yifun/qipai-shared";

type Screen = Widgets.Screen;
type Box = Widgets.BoxElement;

const WIN_TUI = process.platform === "win32";

function wipe(box: Box): void {
  box.setContent("");
  box.hide();
}

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
    claim: Box;
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
  showFx(kind: MjFxKind, title: string, sub?: string): void;
  hideFx(): void;
  showClaim(lines: string[]): void;
  hideClaim(): void;
}

export type MjFxKind = "peng" | "hu" | "gang" | "wait" | "discard" | "liuju";

/** 创建主区棋盘（麻将四家分区 + 十点半座位格） */
export function createGameBoard(parent: Screen): GameBoard {
  const root = blessed.box({
    parent,
    top: 3,
    left: 0,
    width: "70%",
    height: "100%-6",
    tags: true,
    style: { bg: "black" },
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
    style: { bg: "black" },
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
    style: { border: { fg: "cyan" }, bg: "black" },
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
    style: { border: { fg: "magenta" }, bg: "black" },
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
    style: { border: { fg: "white" }, bg: "black" },
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
    style: { border: { fg: "yellow" }, bg: "black" },
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
    style: { border: { fg: "green" }, bg: "black" },
    hidden: true,
  });

  const mjFx = blessed.box({
    parent: root,
    top: "center",
    left: "center",
    width: 40,
    height: 10,
    tags: true,
    align: "center",
    valign: "middle",
    border: { type: "line" },
    hidden: true,
    shadow: !WIN_TUI,
    style: { bg: "black" },
  });

  const mjClaim = blessed.box({
    parent: root,
    bottom: 1,
    right: 1,
    width: 22,
    height: 10,
    tags: true,
    border: { type: "line" },
    label: " 操作 ",
    hidden: true,
    shadow: !WIN_TUI,
    style: { border: { fg: "magenta" }, bg: "black" },
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
    style: { border: { fg: "white" }, bg: "black" },
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
        style: { border: { fg: col === 0 ? "cyan" : "yellow" }, bg: "black" },
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
    style: { bg: "black" },
  });

  const mjAll = [mjTop, mjLeft, mjCenter, mjRight, mjBottom];
  const mjBySlot: Record<MjSeatSlot | "center", Box> = {
    top: mjTop,
    left: mjLeft,
    right: mjRight,
    bottom: mjBottom,
    center: mjCenter,
  };

  function hideExcept(keep: Box[]): void {
    const keepSet = new Set(keep);
    const all = [textMain, ...mjAll, mjClaim, thInfo, thHint, ...thSeats];
    for (const b of all) {
      if (keepSet.has(b)) continue;
      wipe(b);
    }
  }

  function setMjBorder(slot: MjSeatSlot | "center", color: string, bold = false): void {
    const box = mjBySlot[slot];
    box.style.border = { fg: color };
    box.style.bold = bold;
  }

  function showFx(kind: MjFxKind, title: string, sub?: string): void {
    const palette: Record<MjFxKind, { border: string; bg: string; fg: string }> = {
      peng: { border: "magenta", bg: "magenta", fg: "white" },
      hu: { border: "yellow", bg: "yellow", fg: "black" },
      gang: { border: "red", bg: "red", fg: "white" },
      wait: { border: "cyan", bg: "black", fg: "cyan" },
      discard: { border: "white", bg: "black", fg: "white" },
      liuju: { border: "white", bg: "black", fg: "white" },
    };
    const p = palette[kind];
    mjFx.style.border = { fg: p.border };
    mjFx.style.bg = p.bg;
    mjFx.style.fg = p.fg;
    const star = kind === "wait" || kind === "liuju" ? "·" : "*";
    const lines = [`{bold}${star}  ${title}  ${star}{/}`, sub ? sub : ""];
    const extra = sub ? sub.split("\n").length : 0;
    mjFx.height = Math.min(16, Math.max(8, 5 + extra));
    mjFx.width = kind === "discard" ? 28 : 40;
    mjFx.setContent(lines.join("\n"));
    mjFx.show();
    mjFx.setFront();
  }

  function hideFx(): void {
    wipe(mjFx);
  }

  function showClaim(lines: string[]): void {
    if (!lines.length) {
      mjClaim.hide();
      return;
    }
    mjClaim.height = Math.min(12, Math.max(5, lines.length + 2));
    mjClaim.setContent(lines.join("\n"));
    mjClaim.show();
    mjClaim.setFront();
  }

  function hideClaim(): void {
    wipe(mjClaim);
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
      claim: mjClaim,
    },
    th: { info: thInfo, seats: thSeats, hint: thHint },
    showText() {
      hideFx();
      hideExcept([textMain]);
      textMain.show();
    },
    showMahjong() {
      hideExcept(mjAll);
      for (const b of mjAll) b.show();
    },
    showTenhalf(seatCount: number) {
      hideFx();
      const keep = [thInfo, thHint, ...thSeats.slice(0, seatCount)];
      hideExcept(keep);
      thInfo.show();
      thHint.show();
      for (let i = 0; i < thSeats.length; i++) {
        if (i < seatCount) thSeats[i]!.show();
        else wipe(thSeats[i]!);
      }
    },
    setMjBorder,
    showFx,
    hideFx,
    showClaim,
    hideClaim,
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

function tileFg(t: TileLike, locked = false): string {
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

function paintFg(text: string, fg: string, selected = false): string {
  if (selected) return `{black-fg}{yellow-bg}{bold}${text}{/}`;
  return `{${fg}}{bold}${text}{/}`;
}

interface Chip {
  lines: string[];
  width: number;
}

export type TileChipSize = "hand" | "table" | "last" | "other";

interface TileGeom {
  w: number;
  h: number;
}

/**
 * 终端格子约 1:2，手牌默认 6×4 对应实体牌 33:43。
 * 他家/弃牌带完整线框，默认约手牌一半宽，牌多了再压矮，不会去掉外框。
 */
const HAND_SCALES: TileGeom[] = [
  { w: 6, h: 4 },
  { w: 5, h: 3 },
  { w: 4, h: 3 },
  { w: 4, h: 2 },
];

const OTHER_SCALES: TileGeom[] = [
  { w: 4, h: 4 },
  { w: 4, h: 3 },
];

function scalesFor(size: TileChipSize): TileGeom[] {
  return size === "hand" || size === "last" ? HAND_SCALES : OTHER_SCALES;
}

function pickGeom(
  n: number,
  cols: number,
  scales: TileGeom[],
  maxHeight?: number,
): TileGeom {
  const count = Math.max(n, 1);
  const heightLimit = maxHeight && maxHeight > 0 ? maxHeight : 1_000;
  for (const g of scales) {
    const per = Math.max(1, Math.floor((cols + 1) / (g.w + 1)));
    const wrapRows = Math.ceil(count / per);
    const height = wrapRows * g.h + Math.max(0, wrapRows - 1);
    if (height <= heightLimit) return g;
  }
  return scales[scales.length - 1]!;
}

function makeChip(t: TileLike, geom: TileGeom, selected = false, locked = false): Chip {
  const { a, b } = tileFace(t);
  const fg = tileFg(t, locked);
  const paint = (s: string) => paintFg(s, fg, selected);
  const inner = Math.max(2, geom.w - 2);
  const width = inner + 2;
  const top = `┌${"─".repeat(inner)}┐`;
  const bot = `└${"─".repeat(inner)}┘`;
  const ra = `│${padFace(a, inner)}│`;
  const rb = `│${padFace(b, inner)}│`;
  const raw = geom.h >= 4 ? [top, ra, rb, bot] : geom.h >= 3 ? [top, ra, rb] : [ra, rb];
  return { width, lines: raw.map(paint) };
}

function backChip(geom: TileGeom): Chip {
  const paint = (s: string) => paintFg(s, "white-fg");
  const inner = Math.max(2, geom.w - 2);
  const width = inner + 2;
  const top = `┌${"─".repeat(inner)}┐`;
  const mid = `│${"░".repeat(inner)}│`;
  const bot = `└${"─".repeat(inner)}┘`;
  const raw = geom.h >= 4 ? [top, mid, mid, bot] : geom.h >= 3 ? [top, mid, bot] : [top, bot];
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
  size: TileChipSize,
  opts?: {
    cols?: number;
    cursor?: number;
    lockedTileId?: string | null;
    drawnId?: string;
    drawnGap?: number;
    maxRows?: number;
    maxHeight?: number;
  },
): string {
  if (!tiles.length) return "-";
  const cols = Math.max(8, opts?.cols ?? 80);
  const scales = scalesFor(size);
  const drawnIndex = opts?.drawnId ? tiles.findIndex((t) => t.id === opts.drawnId) : -1;
  const extra = drawnIndex > 0 ? 1 : 0;
  let maxHeight = opts?.maxHeight;
  if (maxHeight == null && opts?.maxRows != null) {
    maxHeight = opts.maxRows * scales[0]!.h + Math.max(0, opts.maxRows - 1);
  }
  const geom = pickGeom(tiles.length + extra, cols, scales, maxHeight);
  const drawnGap = Math.max(2, Math.round((opts?.drawnGap ?? 4) * (geom.w / 6)));
  const chips: Chip[] = [];
  for (let i = 0; i < tiles.length; i++) {
    if (i === drawnIndex && i > 0) chips.push(blankChip(drawnGap, geom.h));
    const t = tiles[i]!;
    chips.push(makeChip(t, geom, i === opts?.cursor, !!t.id && t.id === opts?.lockedTileId));
  }
  return packChips(chips, cols, 1);
}

export function renderMelds(
  melds: Array<{ tiles: TileLike[] }>,
  cols: number,
  size: TileChipSize = "hand",
  maxHeight?: number,
): string {
  if (!melds.length) return "-";
  const n = melds.reduce((s, m) => s + m.tiles.length, 0) + Math.max(0, melds.length - 1);
  const geom = pickGeom(n, cols, scalesFor(size), maxHeight);
  const chips: Chip[] = [];
  for (let i = 0; i < melds.length; i++) {
    if (i > 0) chips.push(blankChip(Math.max(1, Math.floor(geom.w / 2)), geom.h));
    for (const t of melds[i]!.tiles) chips.push(makeChip(t, geom));
  }
  return packChips(chips, cols, 1);
}

export function renderHiddenHand(count: number, cols: number, maxHeight?: number): string {
  if (count <= 0) return "-";
  const geom = pickGeom(count, cols, OTHER_SCALES, maxHeight);
  const chips = Array.from({ length: count }, () => backChip(geom));
  return packChips(chips, cols, 1);
}

/** 他家：副露 + 手牌（牌背或亮出） */
export function renderOtherSeat(
  melds: Array<{ tiles: TileLike[] }>,
  concealedCount: number,
  revealedHand: TileLike[] | undefined,
  cols: number,
  maxHeight?: number,
): string {
  const parts: string[] = [];
  const meldH = maxHeight ? Math.max(2, Math.floor(maxHeight / 3)) : undefined;
  const handH = maxHeight ? Math.max(2, maxHeight - (meldH ?? 0) - 2) : undefined;
  if (melds.length) {
    parts.push(`副露\n${renderMelds(melds, cols, "other", meldH)}`);
  }
  if (revealedHand?.length) {
    parts.push(`手牌\n${renderTiles(revealedHand, "other", { cols, maxHeight: handH })}`);
  } else if (concealedCount > 0) {
    parts.push(`手牌\n${renderHiddenHand(concealedCount, cols, handH)}`);
  }
  return parts.length ? parts.join("\n") : "-";
}

export function renderDiscardRiver(
  groups: Array<{ name: string; discards: TileLike[] }>,
  cols: number,
  maxHeight?: number,
): string {
  if (!groups.length) return "暂无弃牌";
  const per = Math.max(3, Math.floor((maxHeight ?? 20) / Math.max(1, groups.length)));
  return groups
    .map((g) => {
      const tiles = g.discards.length
        ? renderTiles(g.discards, "other", { cols, maxHeight: Math.max(1, per - 1) })
        : "-";
      return `{bold}${g.name}{/}\n${tiles}`;
    })
    .join("\n");
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
  maxHeight?: number,
): string {
  if (!tiles.length) return "(无手牌)";
  return renderTiles(tiles, "hand", { cols, cursor, lockedTileId, drawnId, drawnGap: 4, maxHeight });
}

export function colorPoker(c: { suit: string; rank: number }): string {
  const label = pokerLabel(c as never);
  const fg = c.suit === "H" || c.suit === "D" ? "red-fg" : "white-fg";
  return paintFg(label, fg);
}
