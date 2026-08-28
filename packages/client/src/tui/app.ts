import blessed from "blessed";
import {
  type MahjongRoomConfig,
  type RoomSummary,
  type TableEvent,
  type TenhalfRoomConfig,
} from "@yifun/qipai-shared";
import type { QipaiClient } from "../ws/client.js";
import { loadConfig, saveConfig } from "../config.js";
import {
  colorPoker,
  createGameBoard,
  MJ_REST_BORDER,
  renderBigHand,
  renderDiscardRiver,
  renderMelds,
  renderOtherSeat,
  renderTiles,
  type MjFxKind,
  type MjSeatSlot,
} from "./board.js";
import {
  formatMahjongActions,
  formatRoomConfig,
  formatScoreBoard,
  gameTypeName,
  hostName,
  mahjongActionName,
  mahjongPhaseName,
  phaseName,
} from "./format.js";

type ScreenMode = "login" | "lobby" | "room" | "mahjong" | "tenhalf";

/** 终端列宽：ASCII 1 列，其余按 2 列（中文标签） */
function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
    w += cp <= 0x7e ? 1 : 2;
  }
  return w;
}

interface AppState {
  mode: ScreenMode;
  username: string;
  userId?: string;
  rooms: RoomSummary[];
  room?: RoomSummary;
  game?: Record<string, unknown>;
  status: string;
  cursor: number;
  lockedTileId: string | null;
}

interface MjFx {
  kind: MjFxKind;
  title: string;
  sub?: string;
  until: number;
}

export async function runTui(client: QipaiClient): Promise<void> {
  const winTui = process.platform === "win32";
  if (winTui && !process.env.TERM) {
    process.env.TERM = "xterm-256color";
  }

  const cfg = loadConfig();
  const state: AppState = {
    mode: "login",
    username: cfg.username ?? "",
    rooms: [],
    status: "连接成功",
    cursor: 0,
    lockedTileId: null,
  };

  const screen = blessed.screen({
    smartCSR: !winTui,
    fastCSR: false,
    useBCE: true,
    fullUnicode: true,
    dockBorders: true,
    title: "YiFun 棋牌大厅",
  });

  const header = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line" },
    label: " YiFun 棋牌 ",
    content: "",
    style: { bg: "black" },
  });

  const board = createGameBoard(screen);
  const main = board.textMain;

  let waitTick = 0;
  let pulseOn = false;
  let lastMatchId: string | undefined;
  let lastJustDrewId: string | undefined;
  let lastEventSeq = 0;
  let lastScoreModalKey = "";
  let scoreModalOpen = false;
  let lastOccRoomId: string | undefined;
  let lastOcc: Array<{ userId: string; username: string; isBot: boolean }> = [];
  let mjFx: MjFx | null = null;
  let fxHideTimer: ReturnType<typeof setTimeout> | undefined;

  const logBox = blessed.log({
    parent: screen,
    top: 3,
    left: "70%",
    width: "30%",
    height: "100%-6",
    tags: true,
    border: { type: "line" },
    label: " 日志 ",
    scrollable: true,
    alwaysScroll: true,
    style: { border: { fg: "red" }, bg: "black" },
  });

  const discardBox = blessed.box({
    parent: screen,
    top: 3,
    left: "70%",
    width: "30%",
    height: "50%-3",
    tags: true,
    border: { type: "line" },
    label: " 弃牌 ",
    scrollable: true,
    hidden: true,
    style: { border: { fg: "yellow" }, bg: "black" },
  });

  const chatBox = blessed.log({
    parent: screen,
    top: 3,
    left: "70%",
    width: "30%",
    height: "100%-6",
    tags: true,
    border: { type: "line" },
    label: " 聊天 ",
    scrollable: true,
    alwaysScroll: true,
    hidden: true,
    style: { border: { fg: "green" }, bg: "black" },
  });

  const scoreModal = blessed.box({
    parent: screen,
    top: "center",
    left: "center",
    width: "70%",
    height: "80%",
    tags: true,
    border: { type: "line" },
    label: " 对局积分 ",
    hidden: true,
    scrollable: true,
    keys: true,
    vi: true,
    alwaysScroll: false,
    scrollbar: { ch: "│", style: { inverse: true } },
    shadow: !winTui,
    style: { border: { fg: "yellow" }, bg: "black" },
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 3,
    tags: true,
    border: { type: "line" },
    label: " 操作 ",
    content: "",
    style: { bg: "black" },
  });

  const promptLabel = blessed.box({
    parent: screen,
    bottom: 1,
    left: 2,
    height: 1,
    width: 8,
    hidden: true,
    tags: false,
    content: "",
    style: { fg: "cyan", bg: "black" },
  });

  const input = blessed.textbox({
    parent: screen,
    bottom: 1,
    left: 10,
    height: 1,
    width: "100%-12",
    inputOnFocus: true,
    keys: true,
    hidden: true,
    style: { bg: "black", fg: "white" },
  });

  let prompting = false;
  let chatting = false;
  let chatWelcomeFor: string | undefined;
  const CHAT_LABEL = "聊天: ";

  function setInputGrab(on: boolean): void {
    (input as { grabKeys?: boolean }).grabKeys = on;
  }

  function log(msg: string): void {
    logBox.log(msg);
    if (state.mode === "mahjong" || state.mode === "tenhalf" || state.mode === "room") {
      chatBox.log(`{white-fg}* ${msg}{/}`);
    }
    screen.render();
  }

  function appendChatLine(username: string, text: string, self: boolean): void {
    const safe = text.replace(/[{}]/g, "");
    const name = self ? `{green-fg}${username}{/}` : `{cyan-fg}${username}{/}`;
    chatBox.log(`${name} ${safe}`);
    screen.render();
  }

  function occupancyOf(room: RoomSummary): Array<{ userId: string; username: string; isBot: boolean }> {
    return room.seats
      .filter((s) => s.userId)
      .map((s) => ({ userId: s.userId!, username: s.username, isBot: s.isBot }));
  }

  function logRoomOccupancy(room: RoomSummary): void {
    const occ = occupancyOf(room);
    if (room.roomId !== lastOccRoomId) {
      lastOccRoomId = room.roomId;
      lastOcc = occ;
      log(`已加入房间 ${room.name}`);
      return;
    }
    const oldIds = new Set(lastOcc.map((s) => s.userId));
    const newIds = new Set(occ.map((s) => s.userId));
    for (const s of occ) {
      if (!oldIds.has(s.userId)) {
        log(`${s.username}${s.isBot ? "[人机]" : ""} 加入了房间`);
      }
    }
    for (const s of lastOcc) {
      if (!newIds.has(s.userId)) {
        log(`${s.username}${s.isBot ? "[人机]" : ""} 离开了房间`);
      }
    }
    lastOcc = occ;
  }

  function setStatus(s: string): void {
    state.status = s;
    render();
  }

  function enterLobby(refreshRooms = true): void {
    state.room = undefined;
    state.game = undefined;
    state.mode = "lobby";
    lastMatchId = undefined;
    lastJustDrewId = undefined;
    lastEventSeq = 0;
    lastOccRoomId = undefined;
    lastOcc = [];
    mjFx = null;
    board.hideFx();
    board.hideClaim();
    closeScoreModal();
    endChat();
    chatBox.setContent("");
    chatWelcomeFor = undefined;
    if (refreshRooms) client.send("lobby.listRooms", {});
  }

  function maxRoundsOf(room?: RoomSummary): number {
    if (!room) return 0;
    if (room.gameType === "mahjong") return (room.config as MahjongRoomConfig).maxRounds;
    return (room.config as TenhalfRoomConfig).maxRounds;
  }

  function allRoundsDone(room?: RoomSummary, settled = false): boolean {
    if (!room || !settled) return false;
    const max = maxRoundsOf(room);
    return max > 0 && room.roundIndex >= max;
  }

  function layoutSidePanel(): void {
    if (state.mode === "mahjong") {
      logBox.hide();
      discardBox.top = 3;
      discardBox.height = "50%-3";
      discardBox.show();
      chatBox.top = "50%";
      chatBox.height = "50%-3";
      chatBox.show();
    } else if (state.mode === "tenhalf" || state.mode === "room") {
      logBox.hide();
      discardBox.setContent("");
      discardBox.hide();
      chatBox.top = 3;
      chatBox.height = "100%-6";
      chatBox.show();
    } else {
      chatBox.hide();
      discardBox.setContent("");
      discardBox.hide();
      logBox.show();
    }
  }

  function openScoreModal(): void {
    const room = state.room;
    if (!room) return;
    scoreModal.setContent(formatScoreBoard(room));
    scoreModal.show();
    scoreModal.setFront();
    scoreModal.setScroll(0);
    scoreModal.focus();
    scoreModalOpen = true;
    screen.render();
  }

  function closeScoreModal(): void {
    if (!scoreModalOpen) return;
    scoreModal.setContent("");
    scoreModal.hide();
    scoreModalOpen = false;
  }

  function scrollScoreModal(delta: number): boolean {
    if (!scoreModalOpen) return false;
    scoreModal.scroll(delta);
    screen.render();
    return true;
  }

  function maybeShowFinalScores(settled: boolean): void {
    if (!allRoundsDone(state.room, settled)) return;
    const key = `${state.room?.roomId}:${state.room?.matchId ?? ""}:${state.room?.roundIndex}`;
    if (key === lastScoreModalKey) return;
    lastScoreModalKey = key;
    openScoreModal();
  }

  function renderHeader(): void {
    header.setContent(
      ` {bold}${state.username || "未登录"}{/bold}  |  ${state.status}  |  o退出登录  q退出  Esc取消输入`,
    );
  }

  function relSlot(selfSeat: number, seat: number): MjSeatSlot {
    const rel = (seat - selfSeat + 4) % 4;
    if (rel === 1) return "right";
    if (rel === 2) return "top";
    if (rel === 3) return "left";
    return "bottom";
  }

  function triggerMjFx(kind: MjFxKind, title: string, sub?: string, ms = 1400): void {
    mjFx = { kind, title, sub, until: Date.now() + ms };
    board.showFx(kind, title, sub);
    screen.render();
    if (fxHideTimer) clearTimeout(fxHideTimer);
    fxHideTimer = setTimeout(() => {
      mjFx = null;
      board.hideFx();
      screen.render();
    }, ms);
  }

  function handleTableEvent(
    ev: TableEvent | undefined,
    players: Array<{ seat: number; username: string }>,
  ): void {
    if (!ev || ev.seq === lastEventSeq) return;
    lastEventSeq = ev.seq;
    const name = players.find((p) => p.seat === ev.seat)?.username ?? `座位${ev.seat + 1}`;
    if (ev.kind === "discard") {
      const art = ev.tile ? renderTiles([ev.tile], "last", { cols: 20 }) : "";
      triggerMjFx("discard", `${name} 出牌`, art, 1800);
      return;
    }
    if (ev.kind === "peng") triggerMjFx("peng", `${name} 碰`, ev.text, 1600);
    else if (ev.kind === "mingGang" || ev.kind === "anGang" || ev.kind === "buGang") {
      triggerMjFx("gang", `${name} 杠`, ev.text, 1800);
    } else if (ev.kind === "hu" || ev.kind === "zimo") {
      triggerMjFx("hu", ev.kind === "zimo" ? `${name} 自摸` : `${name} 胡牌`, ev.text, 4000);
    } else if (ev.kind === "liuju") {
      triggerMjFx("liuju", "流局", ev.text, 2500);
    }
  }

  function claimKeyHint(action: string): string {
    switch (action) {
      case "peng":
        return "p";
      case "mingGang":
        return "g";
      case "hu":
        return "h";
      case "pass":
        return "n";
      case "anGang":
        return "a";
      case "buGang":
        return "b";
      default:
        return "?";
    }
  }

  function paintMahjongTurn(
    selfSeat: number,
    currentSeat: number | undefined,
    phase: string | undefined,
    claimSeats: number[],
  ): void {
    const slots: MjSeatSlot[] = ["top", "left", "right", "bottom"];
    for (const slot of slots) {
      board.setMjBorder(slot, MJ_REST_BORDER[slot], false);
    }
    board.setMjBorder("center", MJ_REST_BORDER.center, false);

    if (phase === "settled" || phase === "liuju") return;

    if (phase === "claim" && claimSeats.length) {
      for (const seat of claimSeats) {
        const slot = relSlot(selfSeat, seat);
        const flash = pulseOn ? "red" : "magenta";
        board.setMjBorder(slot, flash, true);
      }
      board.setMjBorder("center", pulseOn ? "cyan" : "white", false);
      return;
    }

    if (currentSeat === undefined) return;
    const slot = relSlot(selfSeat, currentSeat);
    const hot = slot === "bottom" ? (pulseOn ? "green" : "white") : pulseOn ? "red" : "yellow";
    board.setMjBorder(slot, hot, true);
  }

  function renderMahjong(): void {
    board.showMahjong();
    screen.render();
    const g = state.game as {
      players?: Array<{
        seat: number;
        username: string;
        isBot?: boolean;
        handCount: number;
        discards: Array<{ id?: string; suit: string; rank: number }>;
        melds: Array<{ type: string; tiles: Array<{ id?: string; suit: string; rank: number }> }>;
        hand?: Array<{ id?: string; suit: string; rank: number }>;
        score: number;
        ready?: boolean;
      }>;
      selfHand?: Array<{ id: string; suit: string; rank: number }>;
      selfSeat?: number;
      justDrew?: { id: string; suit: string; rank: number };
      dealerSeat?: number;
      currentSeat?: number;
      wallRemaining?: number;
      deadWall?: number;
      phase?: string;
      availableActions?: string[];
      lastDiscard?: { id?: string; suit: string; rank: number };
      lastDiscardSeat?: number;
      roundIndex?: number;
      maxRounds?: number;
      matchId?: string;
      claimOptions?: Array<{ seat: number; actions: string[] }>;
      claimResponses?: Record<string, string>;
      turnDeadlineAt?: number;
      lastEvent?: TableEvent;
    };
    if (!g?.players) {
      board.mj.center.setContent("等待对局状态…");
      return;
    }
    if (g.matchId && g.matchId !== lastMatchId) {
      lastMatchId = g.matchId;
      lastEventSeq = 0;
      const n = (g.roundIndex ?? 0) + 1;
      triggerMjFx("wait", `第 ${n} 局开始`, "", 1600);
    }
    handleTableEvent(g.lastEvent, g.players);

    const self = g.selfSeat ?? 0;
    const order = [0, 1, 2, 3].map((i) => (self + i) % 4);
    const bySeat = (rel: number) => g.players!.find((p) => p.seat === order[rel])!;
    const top = bySeat(2);
    const left = bySeat(3);
    const right = bySeat(1);
    const bottom = bySeat(0);

    const hand = g.selfHand ?? [];
    if (state.cursor >= hand.length) state.cursor = Math.max(0, hand.length - 1);

    const winds = ["东", "南", "西", "北"];
    const seatWind = (seat: number) => winds[seat % 4] ?? "";
    const pendingClaims = (g.claimOptions ?? [])
      .filter((o) => !g.claimResponses?.[String(o.seat)])
      .map((o) => o.seat);
    const dots = ".".repeat((waitTick % 4) + 1).padEnd(4, " ");
    const humanCount = g.players.filter((p) => !p.isBot).length;
    const clockActive = humanCount >= 2 && !!g.turnDeadlineAt && g.phase !== "settled" && g.phase !== "liuju";
    const clockText = (): string => {
      if (!clockActive || !g.turnDeadlineAt) return "";
      const sec = Math.max(0, Math.ceil((g.turnDeadlineAt - Date.now()) / 1000));
      const col = sec <= 10 ? "red-fg" : "yellow-fg";
      return `{${col}}{bold}倒计时 ${sec}s{/}`;
    };

    const sw = Number(screen.width);
    const sh = Number(screen.height);
    const boardCols = Math.max(40, Math.floor((Number.isFinite(sw) && sw > 0 ? sw : 80) * 0.7) - 2);
    const boardRows = Math.max(16, (Number.isFinite(sh) && sh > 0 ? sh : 30) - 6);
    const innerCols = (fraction: number) => Math.max(16, Math.floor(boardCols * fraction) - 2);
    const boxSize = (
      box: { width: string | number; height: string | number; lpos?: { xi: number; xl: number; yi: number; yl: number } },
      fallbackCols: number,
      fallbackRows: number,
    ) => {
      const lp = box.lpos;
      const cols =
        lp && lp.xl - lp.xi > 6
          ? lp.xl - lp.xi - 2
          : typeof box.width === "number" && box.width > 6
            ? box.width - 2
            : fallbackCols;
      const rows =
        lp && lp.yl - lp.yi > 4
          ? lp.yl - lp.yi - 2
          : typeof box.height === "number" && box.height > 4
            ? box.height - 2
            : fallbackRows;
      return { cols, rows };
    };

    const settled = g.phase === "settled" || g.phase === "liuju";
    const roundDone = state.room?.roundIndex ?? g.roundIndex ?? 0;
    const maxR = state.room ? maxRoundsOf(state.room) : (g.maxRounds ?? 0);
    const allDone = settled && maxR > 0 && roundDone >= maxR;
    const currentName = g.players.find((p) => p.seat === g.currentSeat)?.username ?? "";
    const myTurn = g.currentSeat === self && (g.phase === "discard" || g.phase === "draw");
    const myClaim = g.phase === "claim" && pendingClaims.includes(self);
    const myActs = g.availableActions ?? [];
    const claimActs = myActs.filter((a) =>
      ["peng", "mingGang", "hu", "pass", "anGang", "buGang"].includes(a),
    );

    const fmtOther = (
      p: (typeof top),
      tag: string,
      box: typeof board.mj.top,
      fallbackCols: number,
      fallbackRows: number,
    ) => {
      const dealer = g.dealerSeat === p.seat ? "{yellow-fg}庄{/}" : "";
      const isTurn = g.currentSeat === p.seat && g.phase !== "claim";
      const isClaim = g.phase === "claim" && pendingClaims.includes(p.seat);
      const turnMark = isTurn
        ? "{black-fg}{red-bg} 出牌 {/} "
        : isClaim
          ? "{black-fg}{magenta-bg} 可鸣 {/} "
          : "";
      const name = isTurn || isClaim ? `{bold}{red-fg}${p.username}{/}` : p.username;
      const waitHint = isTurn ? `{red-fg}等待出牌${dots}{/}` : isClaim ? `{magenta-fg}等待响应${dots}{/}` : "";
      const clock = !p.isBot && (isTurn || isClaim) ? clockText() : "";
      const { cols, rows } = boxSize(box, fallbackCols, fallbackRows);
      const waitLine = [waitHint, clock].filter(Boolean).join("  ");
      box.setLabel(` ${tag} - ${seatWind(p.seat)}风 `);
      box.setContent(
        [
          `${turnMark}${dealer} ${name}  分${p.score}${waitLine ? `  ${waitLine}` : ""}`,
          renderOtherSeat(p.melds, p.handCount, p.hand, cols, Math.max(2, rows - 1)),
        ].join("\n"),
      );
    };

    fmtOther(top, "对家", board.mj.top, innerCols(1), Math.max(4, Math.floor(boardRows * 0.24) - 1));
    fmtOther(left, "上家", board.mj.left, innerCols(0.3), Math.max(4, Math.floor(boardRows * 0.36) - 1));
    fmtOther(right, "下家", board.mj.right, innerCols(0.3), Math.max(4, Math.floor(boardRows * 0.36) - 1));

    let turnLine: string;
    if (settled) {
      turnLine = allDone ? "{green-fg}全部局结束{/}" : "本局已结束，等待真人准备";
    } else if (g.phase === "claim") {
      turnLine = myClaim
        ? `{magenta-fg}{bold}可碰 / 杠 / 胡${dots}{/}`
        : `{cyan-fg}等待其他玩家响应鸣牌${dots}{/}`;
    } else if (myTurn) {
      turnLine = `{green-fg}{bold}轮到你出牌${dots}{/}`;
    } else {
      turnLine = `{yellow-fg}等待 {bold}${currentName}{/bold} 出牌${dots}{/}`;
    }

    const readyLine =
      settled && !allDone
        ? (state.room?.seats ?? [])
            .filter((s) => s.userId && !s.isBot)
            .map((s) => `${s.username}${s.ready ? "{green-fg}✓{/}" : "{red-fg}…{/}"}`)
            .join("  ")
        : "";

    board.mj.center.setContent(
      [
        `进度: 第 {bold}${Math.min(roundDone + (settled ? 0 : 1), maxR || 1)}{/} / ${maxR || "?"} 局`,
        `阶段: {cyan-fg}${mahjongPhaseName(g.phase)}{/}   牌墙: {cyan-fg}${g.wallRemaining}{/}  死牌: ${g.deadWall}`,
        turnLine,
        readyLine ? `准备: ${readyLine}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const discSize = boxSize(
      discardBox,
      Math.max(12, Math.floor((Number.isFinite(sw) && sw > 0 ? sw : 80) * 0.3) - 2),
      Math.max(6, Math.floor(boardRows / 2) - 1),
    );
    discardBox.setContent(
      renderDiscardRiver(
        [top, left, right, bottom].map((p, i) => ({
          name: `${["对家", "上家", "下家", "自家"][i]} ${p.username}`,
          discards: p.discards,
        })),
        discSize.cols,
        discSize.rows,
      ),
    );

    const bottomSize = boxSize(board.mj.bottom, innerCols(1), Math.max(6, Math.floor(boardRows * 0.4) - 1));
    const handArt = renderBigHand(
      hand,
      state.cursor,
      state.lockedTileId,
      g.justDrew?.id,
      bottomSize.cols,
      Math.max(4, bottomSize.rows - 6),
    );

    const dealer = g.dealerSeat === bottom.seat ? "{yellow-fg}庄{/}" : "";
    const myBanner = myTurn
      ? "{black-fg}{green-bg} 你的回合 {/} "
      : myClaim
        ? "{black-fg}{magenta-bg} 可鸣牌 {/} "
        : "";
    const name = myTurn || myClaim ? `{bold}{green-fg}${bottom.username}{/}` : bottom.username;
    const myMelds = renderMelds(bottom.melds, bottomSize.cols, "hand", 4);

    let bottomExtra = "";
    if (allDone) {
      bottomExtra = "\n{bold}全部局结束{/bold}  v查看积分  x回等待房  l离开";
    } else if (settled) {
      const meReady = state.room?.seats.find((s) => s.seat === self)?.ready;
      bottomExtra = meReady
        ? "\n已准备，等待其他真人按 y"
        : "\n{yellow-fg}按 y 准备下一局{/}  （全体真人准备后开始）";
    } else if (myTurn) {
      bottomExtra = state.lockedTileId
        ? "\n已锁定，再按空格出牌 / Esc取消"
        : "\n←→选牌  空格锁定  再空格出牌";
    } else if (myClaim) {
      bottomExtra = "";
    } else {
      bottomExtra = `\n{yellow-fg}等待中${dots} 当前由 ${currentName} 行动{/}`;
    }
    bottomExtra += "\n{cyan-fg}Enter聊天  Esc退出聊天  l离开  q退出{/}";

    const myClock = !bottom.isBot && (myTurn || myClaim) ? clockText() : "";
    board.mj.bottom.setLabel(` 自家 - ${seatWind(bottom.seat)}风 `);
    board.mj.bottom.setContent(
      [
        `${myBanner}${dealer} ${name}  分${bottom.score}  ${myClock}`,
        "副露",
        myMelds,
        "手牌",
        handArt,
        `可选 ${formatMahjongActions(g.availableActions)}`,
        bottomExtra.trim(),
      ].join("\n"),
    );

    if ((myClaim || (myTurn && claimActs.some((a) => a !== "discard"))) && claimActs.length) {
      const lines = [
        "{bold}请选择{/}",
        ...claimActs.map((a) => ` {yellow-fg}${claimKeyHint(a)}{/}  ${mahjongActionName(a)}`),
      ];
      board.showClaim(lines);
    } else {
      board.hideClaim();
    }

    paintMahjongTurn(self, g.currentSeat, g.phase, pendingClaims);
    if (mjFx && Date.now() < mjFx.until) {
      board.showFx(mjFx.kind, mjFx.title, mjFx.sub);
    }

    maybeShowFinalScores(settled);

    footer.setContent(
      allDone
        ? "{bold}麻将{/bold}  全部局结束 | v积分  x回等待  l离开  Enter聊天  q退出"
        : settled
          ? "{bold}麻将{/bold}  本局结束 | y准备下一局  v积分  l离开  Enter聊天  q退出"
          : `{bold}麻将{/bold}  ${mahjongPhaseName(g.phase)} | 空格出牌 | p碰 g明杠 h胡 | Enter聊天  l离开  q退出`,
    );
  }

  function strengthText(kind?: string): string {
    if (kind === "wulong") return "{magenta-fg}五龙{/}";
    if (kind === "tenhalf") return "{yellow-fg}十点半{/}";
    if (kind === "bust") return "{red-fg}炸{/}";
    if (kind === "points") return "点数";
    return "";
  }

  function renderTenhalf(): void {
    const g = state.game as {
      players?: Array<{
        seat: number;
        username: string;
        open: Array<{ suit: string; rank: number }>;
        hole?: { suit: string; rank: number } | null;
        points?: number;
        stopped: boolean;
        busted: boolean;
        score: number;
        strength?: string;
      }>;
      phase?: string;
      mode?: string;
      potTotal?: number;
      currentSeat?: number;
      availableActions?: string[];
      bankerSeat?: number;
    };
    const players = g?.players ?? [];
    board.showTenhalf(Math.max(players.length, 2));

    if (!players.length) {
      board.th.info.setContent("等待十点半状态…");
      return;
    }

    const settled = g.phase === "settled";
    const modeLabel = g.mode === "banker" ? "打庄" : "通比";
    const roundDone = state.room?.roundIndex ?? 0;
    const maxR = maxRoundsOf(state.room);
    const allDone = settled && maxR > 0 && roundDone >= maxR;
    const phaseLabel = settled
      ? allDone
        ? "{green-fg}全部局结束{/}"
        : "{green-fg}本局已结算{/}"
      : g.phase === "draw_tie"
        ? "{yellow-fg}抽牌决胜{/}"
        : "要牌中";

    board.th.info.setContent(
      ` {bold}${modeLabel}{/bold}  ${phaseLabel}  锅底 {yellow-fg}${g.potTotal}{/}  进度 ${Math.min(roundDone + (settled ? 0 : 1), maxR || 1)}/${maxR || "?"} `,
    );

    for (let i = 0; i < board.th.seats.length; i++) {
      const box = board.th.seats[i]!;
      const p = players[i];
      if (!p) {
        box.setContent("");
        continue;
      }
      const turn = !settled && g.currentSeat === p.seat ? "{green-fg}>{/}" : " ";
      const showBank = g.mode === "banker" && g.bankerSeat === p.seat;
      const st = p.busted ? "{red-fg}炸{/}" : p.stopped ? "停" : "…";
      const hole = p.hole ? colorPoker(p.hole) : "??";
      const open = p.open.map(colorPoker).join(" ");
      const scoreStr =
        p.score > 0
          ? `{green-fg}+${p.score}{/}`
          : p.score < 0
            ? `{red-fg}${p.score}{/}`
            : `${p.score}`;
      const roomScore = state.room?.seats.find((s) => s.seat === p.seat)?.score;
      box.setLabel(` ${p.username}${showBank ? "·庄" : ""} `);
      box.setContent(
        [
          `${turn}${st} ${strengthText(p.strength)} ${p.points ?? "?"}点  本局${scoreStr}  累计${roomScore ?? 0}`,
          `牌 ${hole} ${open}`,
        ].join("\n"),
      );
    }

    if (allDone) {
      board.th.hint.setContent("{bold}全部局结束{/bold}  v查看积分  |  x回等待房  l离开");
      footer.setContent("{bold}十点半{/bold}  全部结束 | v积分  x回等待  l离开  Enter聊天");
      maybeShowFinalScores(true);
    } else if (settled) {
      board.th.hint.setContent("本局结束，即将自动下一局…  (也可按 n)");
      footer.setContent("{bold}十点半{/bold}  结算中 | n续局  x回等待  l离开  Enter聊天");
    } else {
      board.th.hint.setContent(
        `可选 ${(g.availableActions ?? []).join(",") || "-"}   h要牌  s停牌  Enter聊天  r刷新`,
      );
      footer.setContent("{bold}十点半{/bold}  h要牌 s停牌 | Enter聊天  l离开  q退出");
    }
  }

  function renderLobby(): void {
    board.showText();
    const lines = state.rooms.length
      ? state.rooms.map((r, i) => {
          const occupied = r.seats.filter((s) => s.userId).length;
          return ` ${i + 1}. [${gameTypeName(r.gameType)}] ${r.name}  ${phaseName(r.phase)}  ${occupied}/${r.maxSeats}人  局${r.roundIndex}/${maxRoundsOf(r)}  房主:${hostName(r)}  id:${r.roomId}`;
        })
      : [" （暂无房间）"];
    main.setContent(
      [
        "{bold}玩法大厅{/bold}",
        "  1) 创建陕西麻将房（3人机）",
        "  2) 创建十点半通比房（3人机）",
        "  3) 创建十点半打庄房（1人机）",
        "  r) 刷新房间列表",
        "  j) 加入房间（输入6位房间号）",
        "",
        "房间列表:",
        ...lines,
      ].join("\n"),
    );
    footer.setContent("大厅: 1/2/3创建  j加入  r刷新  o退出登录  q退出");
  }

  function renderRoom(): void {
    board.showText();
    const r = state.room;
    if (!r) {
      main.setContent("无房间");
      return;
    }
    const cfgLines = formatRoomConfig(r.gameType, r.config)
      .map((x) => `  · ${x}`)
      .join("\n");
    const seats = r.seats
      .map((s) => {
        if (!s.userId) return `  座位${s.seat + 1}: （空）`;
        const tags = [
          s.userId === r.hostUserId ? "{yellow-fg}房主{/}" : "",
          s.isBot ? "[人机]" : "",
          s.ready ? "{green-fg}已准备{/}" : "{red-fg}未准备{/}",
          s.connected ? "在线" : "离线",
          `累计分${s.score}`,
        ]
          .filter(Boolean)
          .join(" ");
        return `  座位${s.seat + 1}: ${s.username}  ${tags}`;
      })
      .join("\n");

    const finished = r.phase === "settled" && r.roundIndex >= maxRoundsOf(r);
    const hasScores = (r.roundResults?.length ?? 0) > 0;
    main.setContent(
      [
        `{bold}房间 ${r.name}{/bold}  (${r.roomId})`,
        `玩法: {cyan-fg}${gameTypeName(r.gameType)}{/}    阶段: ${phaseName(r.phase)}`,
        `房主: {yellow-fg}${hostName(r)}{/}    进度: 已完成 ${r.roundIndex} / ${maxRoundsOf(r)} 局`,
        "配置:",
        cfgLines,
        "",
        "座位:",
        seats,
        "",
        finished
          ? "{bold}全部局已结束{/bold}  按 v 查看排名与分局明细"
          : hasScores
            ? "按 v 可查看上一场积分  |  等待中可按 {yellow-fg}c{/} 配置玩法  |  {yellow-fg}Enter{/} 聊天"
            : "提示: 等待中可按 {yellow-fg}c{/} 配置玩法（局数/牌数/锅底等），{yellow-fg}Enter{/} 聊天",
        "y准备  u取消准备  b加人机  d移除人机  t转让房主  k踢人  c配置",
        "s开始  n续局/统分后回等待  x回等待  l离开  Enter聊天  o退出登录",
      ].join("\n"),
    );
    footer.setContent(
      hasScores
        ? "房间: v积分  c配置  y/u准备  b/d人机  t房主  k踢人  s开始  Enter聊天  l离开  o登出"
        : "房间: c配置  y/u准备  b/d人机  t房主  k踢人  s开始  Enter聊天  l离开  o登出",
    );
  }

  function renderLogin(): void {
    board.showText();
    main.setContent(
      [
        "{bold}登录{/bold}",
        "",
        "按 Enter 输入用户名并登录",
        "若本地已有 sessionToken 将尝试恢复会话",
        "",
        `服务器: ${cfg.serverUrl}`,
      ].join("\n"),
    );
    footer.setContent("登录: Enter 输入用户名   q退出");
  }

  let lastPaintMode: ScreenMode | undefined;

  function render(): void {
    renderHeader();
    layoutSidePanel();
    if (state.mode === "login") renderLogin();
    else if (state.mode === "lobby") renderLobby();
    else if (state.mode === "room") renderRoom();
    else if (state.mode === "mahjong") renderMahjong();
    else if (state.mode === "tenhalf") renderTenhalf();
    if (scoreModalOpen) {
      scoreModal.setFront();
      scoreModal.focus();
    }
    if (prompting || chatting) {
      footer.setContent("");
      promptLabel.setFront();
      input.setFront();
      if (screen.focused !== input) input.focus();
    }
    if (winTui && lastPaintMode !== state.mode) {
      screen.realloc();
    }
    lastPaintMode = state.mode;
    screen.render();
  }

  let lastDroppedLogAt = 0;
  client.onDropped(() => {
    const now = Date.now();
    if (now - lastDroppedLogAt < 1500) return;
    lastDroppedLogAt = now;
    log("尚未连上服务器，正在重连…");
  });

  client.onStatus((s, detail) => {
    if (s === "reconnecting") {
      setStatus(`连接断开，正在重连${detail ? ` (${detail})` : ""}…`);
      log("连接断开，正在重连");
      return;
    }
    if (s === "open") {
      setStatus("已连接");
      log("已重新连上服务器");
      if (cfg.sessionToken) client.send("auth.hello", { sessionToken: cfg.sessionToken });
      else if (state.mode === "login") setStatus("按 Enter 登录");
      else if (state.mode === "lobby") client.send("lobby.listRooms", {});
    }
  });

  client.on("sys.error", (env) => {
    const p = env.payload as { message?: string; code?: string };
    log(`错误[${p.code}]: ${p.message}`);
    setStatus(p.message ?? "错误");
    if (p.code === "AUTH_INVALID" || p.code === "AUTH_EXPIRED") {
      delete cfg.sessionToken;
      saveConfig(cfg);
      if (state.mode !== "login") resetToLogin(p.message ?? "请重新登录");
    }
  });

  client.on("sys.kicked", (env) => {
    const p = env.payload as { reason?: string };
    delete cfg.sessionToken;
    saveConfig(cfg);
    resetToLogin(p.reason ?? "已登出");
  });

  client.on("room.kicked", (env) => {
    const p = env.payload as { reason?: string };
    log(p.reason ?? "被房主移出房间");
  });

  client.on("auth.ok", (env) => {
    const p = env.payload as {
      sessionToken: string;
      userId: string;
      username: string;
      expiresAt: number;
    };
    state.username = p.username;
    state.userId = p.userId;
    cfg.sessionToken = p.sessionToken;
    cfg.username = p.username;
    saveConfig(cfg);
    log(`登录成功，会话空闲 ${Math.round((p.expiresAt - Date.now()) / 3600000)} 小时后过期`);
    if (state.mode === "login") {
      state.mode = "lobby";
      client.send("lobby.listRooms", {});
    }
    render();
  });

  client.on("lobby.rooms", (env) => {
    const p = env.payload as { rooms: RoomSummary[] };
    state.rooms = p.rooms;
    render();
  });

  client.on("room.update", (env) => {
    const room = env.payload as RoomSummary;
    if (
      state.userId &&
      !room.seats.some((s) => s.userId === state.userId && !s.isBot)
    ) {
      log(`已离开房间 ${room.name}`);
      lastOccRoomId = undefined;
      lastOcc = [];
      enterLobby();
      render();
      return;
    }
    logRoomOccupancy(room);
    state.room = room;
    if (chatWelcomeFor !== room.roomId) {
      chatWelcomeFor = room.roomId;
      chatBox.log("{yellow-fg}等待和对局中都可聊天：Enter 输入，Esc 退出{/}");
    }
    if (room.phase === "playing") {
      if (state.mode === "lobby" || state.mode === "login" || state.mode === "room") {
        state.mode = room.gameType === "mahjong" ? "mahjong" : "tenhalf";
      }
    } else if (room.phase === "waiting") {
      state.mode = "room";
    } else if (room.phase === "settled") {
      if (!(state.mode === "mahjong" || state.mode === "tenhalf") || !state.game) {
        state.mode = "room";
      }
    } else if (state.mode === "lobby" || state.mode === "login") {
      state.mode = "room";
    }
    render();
  });

  client.on("room.chatMessage", (env) => {
    const p = env.payload as {
      userId?: string;
      username?: string;
      text?: string;
    };
    if (!p.text) return;
    appendChatLine(p.username ?? "玩家", p.text, p.userId === state.userId);
  });

  client.on("room.left", (env) => {
    const p = (env.payload ?? {}) as { reason?: string };
    if (p.reason) log(p.reason);
    else if (state.room) log(`已离开房间 ${state.room.name}`);
    lastOccRoomId = undefined;
    lastOcc = [];
    enterLobby();
    render();
  });

  client.on("game.state", (env) => {
    if (!state.room) return;
    state.game = env.payload as Record<string, unknown>;
    const payload = env.payload as {
      gameType?: string;
      selfHand?: unknown[];
      justDrew?: { id: string };
    };
    const gt = payload.gameType;
    state.mode = gt === "tenhalf" ? "tenhalf" : "mahjong";
    const hand = payload.selfHand;
    const drewId = payload.justDrew?.id;
    if (drewId && drewId !== lastJustDrewId) {
      lastJustDrewId = drewId;
      if (hand?.length) state.cursor = hand.length - 1;
    }
    if (!drewId) lastJustDrewId = undefined;
    if (hand && state.cursor >= hand.length) state.cursor = Math.max(0, hand.length - 1);
    render();
  });

  function resetToLogin(reason?: string): void {
    state.mode = "login";
    state.userId = undefined;
    state.username = cfg.username ?? "";
    state.room = undefined;
    state.game = undefined;
    state.rooms = [];
    lastOccRoomId = undefined;
    lastOcc = [];
    lastMatchId = undefined;
    lastJustDrewId = undefined;
    lastEventSeq = 0;
    mjFx = null;
    board.hideFx();
    board.hideClaim();
    closeScoreModal();
    endChat();
    chatBox.setContent("");
    if (reason) log(reason);
    setStatus(reason ?? "按 Enter 登录");
  }

  function canChat(): boolean {
    return Boolean(state.room) && state.mode !== "login" && state.mode !== "lobby";
  }

  function layoutChatInput(): void {
    const cols = Math.max(1, displayWidth(CHAT_LABEL));
    promptLabel.setContent(CHAT_LABEL);
    promptLabel.width = cols;
    promptLabel.left = 2;
    promptLabel.show();
    input.left = 2 + cols;
    input.width = `100%-${4 + cols}`;
    input.setValue("");
    input.show();
    promptLabel.setFront();
    input.setFront();
    setInputGrab(true);
    input.focus();
    screen.render();
  }

  function onChatSubmit(val: string): void {
    const text = String(val ?? "")
      .replace(/[\r\n\t]/g, " ")
      .replace(/[{}]/g, "")
      .trim()
      .slice(0, 200);
    if (text) client.send("room.chat", { text });
    if (!chatting) return;
    setImmediate(() => {
      if (chatting) layoutChatInput();
    });
  }

  function onChatCancel(): void {
    endChat();
  }

  function detachChatInput(): void {
    input.removeListener("submit", onChatSubmit);
    input.removeListener("cancel", onChatCancel);
  }

  function beginChat(): void {
    if (chatting || prompting) return;
    if (!canChat()) return;
    chatting = true;
    prompting = true;
    detachChatInput();
    input.on("submit", onChatSubmit);
    input.on("cancel", onChatCancel);
    layoutChatInput();
  }

  function endChat(): void {
    if (!chatting) return;
    chatting = false;
    detachChatInput();
    setInputGrab(false);
    input.hide();
    promptLabel.hide();
    prompting = false;
    screen.render();
    render();
  }

  function prompt(label: string): Promise<string | null> {
    return new Promise((resolve) => {
      if (chatting) endChat();
      prompting = true;
      const cols = Math.max(1, displayWidth(label));
      promptLabel.setContent(label);
      promptLabel.width = cols;
      promptLabel.left = 2;
      promptLabel.show();
      input.left = 2 + cols;
      input.width = `100%-${4 + cols}`;
      input.show();
      input.setValue("");
      promptLabel.setFront();
      input.setFront();
      setInputGrab(true);
      input.focus();
      screen.render();

      const finish = (val: string | null) => {
        setInputGrab(false);
        input.hide();
        promptLabel.hide();
        screen.render();
        resolve(val === null ? null : val.trim());
        setImmediate(() => {
          prompting = false;
          render();
        });
      };

      const onSubmit = (val: string) => {
        input.removeListener("cancel", onCancel);
        finish(val);
      };
      const onCancel = () => {
        input.removeListener("submit", onSubmit);
        finish(null);
      };
      input.once("submit", onSubmit);
      input.once("cancel", onCancel);
    });
  }

  async function doLogin(): Promise<void> {
    if (prompting) return;
    const name = await prompt("用户名: ");
    if (!name) {
      setStatus("按 Enter 登录");
      return;
    }
    delete cfg.sessionToken;
    saveConfig(cfg);
    state.username = name;
    client.send("auth.login", { username: name });
  }

  async function doLogout(): Promise<void> {
    if (prompting || state.mode === "login") return;
    client.send("auth.logout", {});
    delete cfg.sessionToken;
    saveConfig(cfg);
    resetToLogin("已退出登录");
    await doLogin();
  }

  async function doKick(): Promise<void> {
    if (state.mode !== "room" && state.mode !== "mahjong" && state.mode !== "tenhalf") return;
    if (!state.room) return;
    const raw = await prompt("踢出座位号(1起): ");
    if (raw == null) return;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 1) {
      log("座位号无效");
      return;
    }
    client.send("room.kick", { seat: n - 1 });
  }

  async function configureRoom(): Promise<void> {
    const r = state.room;
    if (!r || r.phase !== "waiting") {
      log("仅等待中可由房主配置");
      return;
    }
    if (r.gameType === "mahjong") {
      const cur = r.config as MahjongRoomConfig;
      const tileRaw = await prompt(`牌数 112或144 (当前${cur.tileCount}): `);
      if (tileRaw == null) return;
      const baseRaw = await prompt(`底分 (当前${cur.baseScore}): `);
      if (baseRaw == null) return;
      const roundsRaw = await prompt(`总局数 (当前${cur.maxRounds}): `);
      if (roundsRaw == null) return;
      const patch: Partial<MahjongRoomConfig> = {};
      if (tileRaw === "112" || tileRaw === "144") patch.tileCount = Number(tileRaw) as 112 | 144;
      if (baseRaw && Number.isFinite(Number(baseRaw))) patch.baseScore = Number(baseRaw);
      if (roundsRaw && Number.isFinite(Number(roundsRaw))) patch.maxRounds = Number(roundsRaw);
      client.send("room.updateConfig", { config: patch });
      log("已提交麻将配置");
      return;
    }
    const cur = r.config as TenhalfRoomConfig;
    const modeRaw = await prompt(`模式 1打庄 2通比 (当前${cur.mode === "banker" ? "打庄" : "通比"}): `);
    if (modeRaw == null) return;
    const potRaw = await prompt(`每人锅底 (当前${cur.potPerPlayer}): `);
    if (potRaw == null) return;
    const roundsRaw = await prompt(`总局数 (当前${cur.maxRounds}): `);
    if (roundsRaw == null) return;
    const maxRaw = await prompt(`人数上限2-6 (当前${cur.maxPlayers}): `);
    if (maxRaw == null) return;
    const patch: Partial<TenhalfRoomConfig> = {};
    if (modeRaw === "1") patch.mode = "banker";
    if (modeRaw === "2") patch.mode = "free";
    if (potRaw && Number.isFinite(Number(potRaw))) patch.potPerPlayer = Number(potRaw);
    if (roundsRaw && Number.isFinite(Number(roundsRaw))) patch.maxRounds = Number(roundsRaw);
    if (maxRaw && Number.isFinite(Number(maxRaw))) patch.maxPlayers = Number(maxRaw);
    client.send("room.updateConfig", { config: patch });
    log("已提交十点半配置");
  }

  const pulseTimer = setInterval(() => {
    if (state.mode !== "mahjong") return;
    waitTick = (waitTick + 1) % 4;
    pulseOn = !pulseOn;
    render();
  }, 420);

  screen.on("resize", () => {
    render();
  });

  function bindKey(keys: string | string[], handler: () => void | Promise<void>): void {
    screen.key(keys, () => {
      if (prompting) return;
      void handler();
    });
  }

  function quitApp(): void {
    clearInterval(pulseTimer);
    if (fxHideTimer) clearTimeout(fxHideTimer);
    client.close();
    process.exit(0);
  }

  screen.key(["C-c"], () => quitApp());
  bindKey(["q"], () => quitApp());

  bindKey(["up"], () => {
    if (scrollScoreModal(-1)) return;
  });
  bindKey(["k"], () => {
    if (scrollScoreModal(-1)) return;
    void doKick();
  });
  bindKey(["down"], () => {
    if (scrollScoreModal(1)) return;
  });
  bindKey(["pageup"], () => {
    if (scrollScoreModal(-8)) return;
  });
  bindKey(["pagedown"], () => {
    if (scrollScoreModal(8)) return;
  });

  screen.key(["escape"], () => {
    if (prompting) return;
    if (scoreModalOpen) {
      closeScoreModal();
      screen.render();
      return;
    }
    if (state.lockedTileId) {
      state.lockedTileId = null;
      render();
    }
  });

  bindKey(["o"], () => {
    void doLogout();
  });

  bindKey(["r"], () => {
    if (state.mode === "lobby") client.send("lobby.listRooms", {});
    else if (state.room) client.send("game.sync", {});
  });

  bindKey(["enter", "return"], async () => {
    if (scoreModalOpen) {
      closeScoreModal();
      screen.render();
      return;
    }
    if (state.mode === "login") {
      await doLogin();
      return;
    }
    if (canChat()) beginChat();
  });

  bindKey(["left"], () => {
    if (scoreModalOpen) return;
    if (state.mode !== "mahjong") return;
    state.cursor = Math.max(0, state.cursor - 1);
    render();
  });

  bindKey(["right"], () => {
    if (scoreModalOpen) return;
    if (state.mode !== "mahjong") return;
    const hand = (state.game as { selfHand?: unknown[] })?.selfHand ?? [];
    state.cursor = Math.min(hand.length - 1, state.cursor + 1);
    render();
  });

  bindKey(["space"], () => {
    if (scoreModalOpen) return;
    if (state.mode !== "mahjong") return;
    const g = state.game as {
      selfHand?: Array<{ id: string }>;
      availableActions?: string[];
    };
    const hand = g?.selfHand ?? [];
    const tile = hand[state.cursor];
    if (!tile) return;
    if (!state.lockedTileId) {
      state.lockedTileId = tile.id;
      render();
      return;
    }
    if (state.lockedTileId !== tile.id) {
      state.lockedTileId = tile.id;
      render();
      return;
    }
    if (!(g.availableActions ?? []).includes("discard")) {
      return;
    }
    client.send("game.action", { action: "discard", data: { tileId: tile.id } });
    state.lockedTileId = null;
  });

  bindKey(["p"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "peng", data: {} });
  });
  bindKey(["g"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "mingGang", data: {} });
  });
  bindKey(["a"], () => {
    if (state.mode !== "mahjong") return;
    const hand = (state.game as { selfHand?: Array<{ id: string }> })?.selfHand;
    const id = state.lockedTileId ?? hand?.[state.cursor]?.id;
    client.send("game.action", { action: "anGang", data: { tileId: id } });
  });
  bindKey(["b"], () => {
    if (state.mode === "room") {
      client.send("room.addBot", { count: 1 });
      return;
    }
    if (state.mode === "mahjong") {
      const hand = (state.game as { selfHand?: Array<{ id: string }> })?.selfHand;
      const id = state.lockedTileId ?? hand?.[state.cursor]?.id;
      const acts = (state.game as { availableActions?: string[] }).availableActions ?? [];
      if (acts.includes("buGang")) {
        client.send("game.action", { action: "buGang", data: { tileId: id } });
      }
    }
  });

  bindKey(["c"], () => {
    if (state.mode !== "room") return;
    void configureRoom();
  });

  bindKey(["d"], () => {
    if (state.mode !== "room") return;
    void (async () => {
      const raw = await prompt("移除人机座位号(1起，空=最后一个): ");
      if (raw == null) return;
      if (!raw) {
        client.send("room.removeBot", {});
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        log("座位号无效");
        return;
      }
      client.send("room.removeBot", { seat: n - 1 });
    })();
  });

  bindKey(["t"], () => {
    if (state.mode !== "room") return;
    void (async () => {
      const raw = await prompt("转让房主到座位号(1起): ");
      if (raw == null) return;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        log("座位号无效");
        return;
      }
      client.send("room.setHost", { seat: n - 1 });
    })();
  });

  bindKey(["n"], () => {
    if (scoreModalOpen) return;
    if (state.mode === "mahjong") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled" || phase === "liuju") return;
      client.send("game.action", { action: "pass", data: {} });
      return;
    }
    if (state.mode === "tenhalf") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled") client.send("room.nextRound", {});
      return;
    }
    if (state.mode === "room") client.send("room.nextRound", {});
  });

  bindKey(["s"], () => {
    if (state.mode === "tenhalf") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled") return;
      client.send("game.action", { action: "stand", data: {} });
      return;
    }
    if (state.mode === "room") client.send("room.start", {});
  });

  bindKey(["h"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "hu", data: {} });
    else if (state.mode === "tenhalf") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled") return;
      client.send("game.action", { action: "hit", data: {} });
    }
  });

  bindKey(["y"], () => {
    if (state.mode === "room") {
      client.send("room.ready", { ready: true });
      return;
    }
    if (state.mode === "mahjong") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled" || phase === "liuju") {
        client.send("room.ready", { ready: true });
      }
    }
  });
  bindKey(["v"], () => {
    if (scoreModalOpen) {
      closeScoreModal();
      screen.render();
      return;
    }
    if (state.room && (state.room.roundResults?.length || state.room.phase === "settled")) {
      openScoreModal();
    }
  });
  bindKey(["u"], () => {
    if (state.mode === "room") client.send("room.ready", { ready: false });
  });
  bindKey(["l", "e"], () => {
    if (state.mode === "room" || state.mode === "mahjong" || state.mode === "tenhalf") {
      client.send("room.leave", {});
    }
  });
  bindKey(["x"], () => {
    if (state.mode === "room" || state.mode === "mahjong" || state.mode === "tenhalf") {
      client.send("room.back", {});
    }
  });

  bindKey(["1"], () => {
    if (state.mode !== "lobby") return;
    client.send("room.create", {
      gameType: "mahjong",
      config: { tileCount: 112, baseScore: 1, maxRounds: 4, botCount: 3 },
    });
  });
  bindKey(["2"], () => {
    if (state.mode !== "lobby") return;
    client.send("room.create", {
      gameType: "tenhalf",
      config: { mode: "free", potPerPlayer: 10, botCount: 3, maxPlayers: 4, maxRounds: 4 },
    });
  });
  bindKey(["3"], () => {
    if (state.mode !== "lobby") return;
    client.send("room.create", {
      gameType: "tenhalf",
      config: { mode: "banker", potPerPlayer: 10, botCount: 1, maxPlayers: 2, maxRounds: 4 },
    });
  });
  bindKey(["j"], async () => {
    if (scrollScoreModal(1)) return;
    if (state.mode !== "lobby") return;
    const id = await prompt("房间号: ");
    if (id) client.send("room.join", { roomId: id });
  });

  render();
  log(`已连接 ${cfg.serverUrl}`);

  if (cfg.sessionToken) {
    client.send("auth.hello", { sessionToken: cfg.sessionToken });
  } else {
    setStatus("按 Enter 登录");
  }
}
