import blessed from "blessed";
import {
  type MahjongRoomConfig,
  type RoomSummary,
  type TenhalfRoomConfig,
} from "@yifun/qipai-shared";
import type { QipaiClient } from "../ws/client.js";
import { loadConfig, saveConfig } from "../config.js";
import {
  colorPoker,
  createGameBoard,
  MJ_REST_BORDER,
  renderBigHand,
  renderMelds,
  renderSeatTiles,
  renderTiles,
  type MjSeatSlot,
} from "./board.js";
import {
  formatMahjongActions,
  formatRoomConfig,
  gameTypeName,
  hostName,
  mahjongPhaseName,
  phaseName,
} from "./format.js";

type ScreenMode = "login" | "lobby" | "room" | "mahjong" | "tenhalf";

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

type MjFxKind = "peng" | "hu" | "gang" | "wait";

interface MjFx {
  kind: MjFxKind;
  title: string;
  sub?: string;
  until: number;
}

export async function runTui(client: QipaiClient): Promise<void> {
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
    smartCSR: true,
    title: "YiFun 棋牌大厅",
    fullUnicode: true,
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
  });

  const board = createGameBoard(screen);
  const main = board.textMain;

  let waitTick = 0;
  let pulseOn = false;
  let lastSeenLog: string | undefined;
  let lastMatchId: string | undefined;
  let lastJustDrewId: string | undefined;
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
    style: { border: { fg: "red" } },
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
  });

  const input = blessed.textbox({
    parent: screen,
    bottom: 0,
    left: 1,
    height: 1,
    width: "100%-4",
    inputOnFocus: true,
    hidden: true,
  });

  function log(msg: string): void {
    logBox.log(msg);
    screen.render();
  }

  function setStatus(s: string): void {
    state.status = s;
    render();
  }

  function enterLobby(refreshRooms = true): void {
    state.room = undefined;
    state.game = undefined;
    state.mode = "lobby";
    lastSeenLog = undefined;
    lastMatchId = undefined;
    lastJustDrewId = undefined;
    mjFx = null;
    board.hideFx();
    if (refreshRooms) client.send("lobby.listRooms", {});
  }

  function maxRoundsOf(room?: RoomSummary): number {
    if (!room) return 0;
    if (room.gameType === "mahjong") return (room.config as MahjongRoomConfig).maxRounds;
    return (room.config as TenhalfRoomConfig).maxRounds;
  }

  function renderHeader(): void {
    header.setContent(
      ` {bold}${state.username || "未登录"}{/bold}  |  ${state.status}  |  q退出  Esc取消输入`,
    );
  }

  function relSlot(selfSeat: number, seat: number): MjSeatSlot {
    const rel = (seat - selfSeat + 4) % 4;
    if (rel === 1) return "right";
    if (rel === 2) return "top";
    if (rel === 3) return "left";
    return "bottom";
  }

  function newMahjongLogs(logs: string[]): string[] {
    if (!logs.length) return [];
    if (!lastSeenLog) {
      lastSeenLog = logs[logs.length - 1];
      return [];
    }
    const idx = logs.lastIndexOf(lastSeenLog);
    const news = idx < 0 ? logs.slice(-6) : logs.slice(idx + 1);
    lastSeenLog = logs[logs.length - 1];
    return news;
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

  function detectMahjongFx(logs: string[]): void {
    for (const line of newMahjongLogs(logs)) {
      if (line.includes("自摸") || (line.includes("胡") && !line.includes("无法"))) {
        triggerMjFx("hu", "胡 牌", line, 5000);
      } else if (line.includes("暗杠") || line.includes("明杠") || line.includes("碰后杠")) {
        triggerMjFx("gang", "杠 牌", line, 4500);
      } else if (line.includes("碰")) {
        triggerMjFx("peng", "碰 牌", line, 4000);
      }
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
    const g = state.game as {
      players?: Array<{
        seat: number;
        username: string;
        isBot?: boolean;
        handCount: number;
        discards: Array<{ suit: string; rank: number }>;
        melds: Array<{ type: string; tiles: Array<{ suit: string; rank: number }> }>;
        score: number;
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
      lastDiscard?: { suit: string; rank: number };
      lastDiscardSeat?: number;
      roundIndex?: number;
      maxRounds?: number;
      logs?: string[];
      matchId?: string;
      claimOptions?: Array<{ seat: number; actions: string[] }>;
      claimResponses?: Record<string, string>;
      turnDeadlineAt?: number;
    };
    if (!g?.players) {
      board.mj.center.setContent("等待对局状态…");
      return;
    }
    if (g.matchId && g.matchId !== lastMatchId) {
      lastMatchId = g.matchId;
      lastSeenLog = undefined;
      const n = (g.roundIndex ?? 0) + 1;
      triggerMjFx("wait", `第 ${n} 局开始`, "请准备", 4000);
    }
    detectMahjongFx(g.logs ?? []);

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
    const boardCols = Math.max(40, Math.floor((Number.isFinite(sw) && sw > 0 ? sw : 80) * 0.7) - 2);
    const innerCols = (fraction: number) => Math.max(16, Math.floor(boardCols * fraction) - 2);
    const boxCols = (box: { width: string | number; lpos?: { xi: number; xl: number } }, fallback: number) => {
      const lp = box.lpos;
      if (lp && lp.xl - lp.xi > 6) return lp.xl - lp.xi - 2;
      const w = box.width;
      return typeof w === "number" && w > 6 ? w - 2 : fallback;
    };

    const fmtOther = (
      p: (typeof top),
      tag: string,
      box: typeof board.mj.top,
      fallbackCols: number,
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
      const cols = boxCols(box, fallbackCols);
      const waitLine = [waitHint, clock].filter(Boolean).join("  ");
      box.setLabel(` ${tag} - ${seatWind(p.seat)}风 `);
      box.setContent(
        [
          `${turnMark}${dealer} ${name}  分${p.score}  手牌${p.handCount}${waitLine ? `  ${waitLine}` : ""}`,
          renderSeatTiles(p.melds, p.discards, cols, tag === "对家" ? "row" : "stack"),
        ].join("\n"),
      );
    };

    fmtOther(top, "对家", board.mj.top, innerCols(1));
    fmtOther(left, "上家", board.mj.left, innerCols(0.3));
    fmtOther(right, "下家", board.mj.right, innerCols(0.3));

    const roundDone = state.room?.roundIndex ?? g.roundIndex ?? 0;
    const maxR = state.room ? maxRoundsOf(state.room) : (g.maxRounds ?? 0);
    const settled = g.phase === "settled" || g.phase === "liuju";
    const allDone = settled && maxR > 0 && roundDone >= maxR;
    const currentName = g.players.find((p) => p.seat === g.currentSeat)?.username ?? "";
    const myTurn = g.currentSeat === self && (g.phase === "discard" || g.phase === "draw");
    const myClaim = g.phase === "claim" && pendingClaims.includes(self);

    let turnLine: string;
    if (settled) {
      turnLine = "本局已结束";
    } else if (g.phase === "claim") {
      turnLine = myClaim
        ? `{magenta-fg}{bold}轮到你：可碰 / 杠 / 胡${dots}{/}`
        : `{cyan-fg}等待其他玩家响应鸣牌${dots}{/}`;
    } else if (myTurn) {
      turnLine = `{green-fg}{bold}轮到你出牌${dots}{/}`;
    } else {
      turnLine = `{yellow-fg}等待 {bold}${currentName}{/bold} 出牌${dots}{/}`;
    }

    const centerCols = boxCols(board.mj.center, innerCols(0.4));
    const bottomCols = boxCols(board.mj.bottom, innerCols(1));
    board.mj.center.setContent(
      [
        `进度: 第 {bold}${Math.min(roundDone + (settled ? 0 : 1), maxR || 1)}{/} / ${maxR || "?"} 局`,
        `阶段: {cyan-fg}${mahjongPhaseName(g.phase)}{/}   牌墙: {cyan-fg}${g.wallRemaining}{/}  死牌: ${g.deadWall}`,
        turnLine,
        "",
        "上一次出牌",
        g.lastDiscard ? renderTiles([g.lastDiscard], "last", { cols: centerCols }) : "-",
      ].join("\n"),
    );

    const handArt = renderBigHand(hand, state.cursor, state.lockedTileId, g.justDrew?.id, bottomCols);

    const dealer = g.dealerSeat === bottom.seat ? "{yellow-fg}庄{/}" : "";
    const myBanner = myTurn
      ? "{black-fg}{green-bg} 你的回合 {/} "
      : myClaim
        ? "{black-fg}{magenta-bg} 可鸣牌 {/} "
        : "";
    const name = myTurn || myClaim ? `{bold}{green-fg}${bottom.username}{/}` : bottom.username;
    const myMelds = renderMelds(bottom.melds, bottomCols);

    let bottomExtra = "";
    if (allDone) {
      bottomExtra = "\n{bold}全部局结束 — 累计分见座位分{/bold}\nx 回等待房   l 离开";
    } else if (settled) {
      bottomExtra = "\n本局结束，即将自动进入下一局…  (n手动续局)";
    } else if (myTurn) {
      bottomExtra = state.lockedTileId
        ? "\n已锁定，再按空格出牌 / Esc取消"
        : "\n←→选牌  空格锁定  再空格出牌  |  p碰 g明杠 h胡 a暗杠 b补杠 n过";
    } else if (myClaim) {
      bottomExtra = "\n{magenta-fg}可操作：p碰 g明杠 h胡 n过{/}";
    } else {
      bottomExtra = `\n{yellow-fg}等待中${dots} 当前由 ${currentName} 行动{/}`;
    }
    bottomExtra += "\n{cyan-fg}l 离开房间   q 退出游戏{/}";

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

    paintMahjongTurn(self, g.currentSeat, g.phase, pendingClaims);
    if (mjFx && Date.now() < mjFx.until) {
      board.showFx(mjFx.kind, mjFx.title, mjFx.sub);
    }

    footer.setContent(
      allDone
        ? "{bold}麻将{/bold}  全部局结束 | x回等待  l离开房间  q退出"
        : `{bold}麻将{/bold}  ${mahjongPhaseName(g.phase)} | 空格出牌 | p碰 g明杠 h胡 | l离开房间  q退出`,
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
      const bank = g.bankerSeat === p.seat ? "{yellow-fg}庄{/}" : "";
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
      box.setLabel(` ${p.username}${bank ? "·庄" : ""} `);
      box.setContent(
        [
          `${turn}${st} ${strengthText(p.strength)} ${p.points ?? "?"}点  本局${scoreStr}  累计${roomScore ?? 0}`,
          `牌 ${hole} ${open}`,
        ].join("\n"),
      );
    }

    if (allDone) {
      board.th.hint.setContent("{bold}全部局结束{/bold}  看累计分  |  x回等待房  l离开");
      footer.setContent("{bold}十点半{/bold}  全部结束 | x回等待  l离开");
    } else if (settled) {
      board.th.hint.setContent("本局结束，即将自动下一局…  (也可按 n)");
      footer.setContent("{bold}十点半{/bold}  结算中 | n续局  x回等待  l离开");
    } else {
      board.th.hint.setContent(
        `可选 ${(g.availableActions ?? []).join(",") || "-"}   h要牌  s停牌  r刷新`,
      );
      footer.setContent("{bold}十点半{/bold}  h要牌 s停牌 | l离开房间  q退出");
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
        "  j) 加入房间（输入房间ID）",
        "",
        "房间列表:",
        ...lines,
      ].join("\n"),
    );
    footer.setContent("大厅: 1/2/3创建  j加入  r刷新  q退出");
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
          ? "{bold}全部局已结束，上方为累计总分{/bold}"
          : "提示: 等待中可按 {yellow-fg}c{/} 配置玩法（局数/牌数/锅底等）",
        "y准备  u取消准备  b加人机  d移除人机  t转让房主  c配置",
        "s开始  n续局/统分后回等待  x回等待  l离开",
      ].join("\n"),
    );
    footer.setContent("房间: c配置  y/u准备  b/d人机  t房主  s开始  l离开");
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
    footer.setContent("登录: Enter 输入用户名");
  }

  function render(): void {
    renderHeader();
    if (state.mode === "login") renderLogin();
    else if (state.mode === "lobby") renderLobby();
    else if (state.mode === "room") renderRoom();
    else if (state.mode === "mahjong") renderMahjong();
    else if (state.mode === "tenhalf") renderTenhalf();
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
      else if (state.mode === "lobby") client.send("lobby.listRooms", {});
    }
  });

  client.on("sys.error", (env) => {
    const p = env.payload as { message?: string; code?: string };
    log(`错误[${p.code}]: ${p.message}`);
    setStatus(p.message ?? "错误");
  });

  client.on("sys.kicked", (env) => {
    const p = env.payload as { reason?: string };
    log(`被顶号: ${p.reason}`);
    setStatus("被顶号");
    client.close();
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
    log(`登录成功，会话至 ${new Date(p.expiresAt).toLocaleString()}`);
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
      enterLobby();
      render();
      return;
    }
    state.room = room;
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

  client.on("room.left", () => {
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

  function prompt(label: string): Promise<string> {
    return new Promise((resolve) => {
      input.setLabel(label);
      input.show();
      input.focus();
      input.setValue("");
      screen.render();
      input.once("submit", (val: string) => {
        input.hide();
        screen.render();
        resolve(val.trim());
      });
    });
  }

  async function doLogin(): Promise<void> {
    if (cfg.sessionToken) {
      client.send("auth.hello", { sessionToken: cfg.sessionToken });
    }
    const name = await prompt("用户名: ");
    if (!name) return;
    state.username = name;
    client.send("auth.login", { username: name });
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
      const baseRaw = await prompt(`底分 (当前${cur.baseScore}): `);
      const roundsRaw = await prompt(`总局数 (当前${cur.maxRounds}): `);
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
    const potRaw = await prompt(`每人锅底 (当前${cur.potPerPlayer}): `);
    const roundsRaw = await prompt(`总局数 (当前${cur.maxRounds}): `);
    const maxRaw = await prompt(`人数上限2-6 (当前${cur.maxPlayers}): `);
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

  screen.key(["q", "C-c"], () => {
    clearInterval(pulseTimer);
    if (fxHideTimer) clearTimeout(fxHideTimer);
    client.close();
    process.exit(0);
  });

  screen.key(["escape"], () => {
    if (state.lockedTileId) {
      state.lockedTileId = null;
      log("取消锁定");
      render();
    }
  });

  screen.key(["r"], () => {
    if (state.mode === "lobby") client.send("lobby.listRooms", {});
    else if (state.room) client.send("game.sync", {});
  });

  screen.key(["enter"], async () => {
    if (state.mode === "login") await doLogin();
  });

  screen.key(["left"], () => {
    if (state.mode !== "mahjong") return;
    state.cursor = Math.max(0, state.cursor - 1);
    render();
  });

  screen.key(["right"], () => {
    if (state.mode !== "mahjong") return;
    const hand = (state.game as { selfHand?: unknown[] })?.selfHand ?? [];
    state.cursor = Math.min(hand.length - 1, state.cursor + 1);
    render();
  });

  screen.key(["space"], () => {
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
      log(`锁定 ${tile.id}`);
      render();
      return;
    }
    if (state.lockedTileId !== tile.id) {
      state.lockedTileId = tile.id;
      log(`改锁 ${tile.id}`);
      render();
      return;
    }
    if (!(g.availableActions ?? []).includes("discard")) {
      log("当前不能出牌");
      return;
    }
    client.send("game.action", { action: "discard", data: { tileId: tile.id } });
    state.lockedTileId = null;
    log("出牌");
  });

  screen.key(["p"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "peng", data: {} });
  });
  screen.key(["g"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "mingGang", data: {} });
  });
  screen.key(["a"], () => {
    if (state.mode !== "mahjong") return;
    const hand = (state.game as { selfHand?: Array<{ id: string }> })?.selfHand;
    const id = state.lockedTileId ?? hand?.[state.cursor]?.id;
    client.send("game.action", { action: "anGang", data: { tileId: id } });
  });
  screen.key(["b"], () => {
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

  screen.key(["c"], () => {
    if (state.mode !== "room") return;
    void configureRoom();
  });

  screen.key(["d"], () => {
    if (state.mode !== "room") return;
    void (async () => {
      const raw = await prompt("移除人机座位号(1起，空=最后一个): ");
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

  screen.key(["t"], () => {
    if (state.mode !== "room") return;
    void (async () => {
      const raw = await prompt("转让房主到座位号(1起): ");
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1) {
        log("座位号无效");
        return;
      }
      client.send("room.setHost", { seat: n - 1 });
    })();
  });

  screen.key(["n"], () => {
    if (state.mode === "mahjong") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled" || phase === "liuju") {
        client.send("room.nextRound", {});
        return;
      }
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

  screen.key(["s"], () => {
    if (state.mode === "tenhalf") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled") return;
      client.send("game.action", { action: "stand", data: {} });
      return;
    }
    if (state.mode === "room") client.send("room.start", {});
  });

  screen.key(["h"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "hu", data: {} });
    else if (state.mode === "tenhalf") {
      const phase = (state.game as { phase?: string } | undefined)?.phase;
      if (phase === "settled") return;
      client.send("game.action", { action: "hit", data: {} });
    }
  });

  screen.key(["y"], () => {
    if (state.mode === "room") client.send("room.ready", { ready: true });
  });
  screen.key(["u"], () => {
    if (state.mode === "room") client.send("room.ready", { ready: false });
  });
  screen.key(["l", "e"], () => {
    if (state.mode === "room" || state.mode === "mahjong" || state.mode === "tenhalf") {
      client.send("room.leave", {});
    }
  });
  screen.key(["x"], () => {
    if (state.mode === "room" || state.mode === "mahjong" || state.mode === "tenhalf") {
      client.send("room.back", {});
    }
  });

  screen.key(["1"], () => {
    if (state.mode !== "lobby") return;
    client.send("room.create", {
      gameType: "mahjong",
      config: { tileCount: 112, baseScore: 1, maxRounds: 4, botCount: 3 },
    });
  });
  screen.key(["2"], () => {
    if (state.mode !== "lobby") return;
    client.send("room.create", {
      gameType: "tenhalf",
      config: { mode: "free", potPerPlayer: 10, botCount: 3, maxPlayers: 4, maxRounds: 4 },
    });
  });
  screen.key(["3"], () => {
    if (state.mode !== "lobby") return;
    client.send("room.create", {
      gameType: "tenhalf",
      config: { mode: "banker", potPerPlayer: 10, botCount: 1, maxPlayers: 2, maxRounds: 4 },
    });
  });
  screen.key(["j"], async () => {
    if (state.mode !== "lobby") return;
    const id = await prompt("房间ID: ");
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
