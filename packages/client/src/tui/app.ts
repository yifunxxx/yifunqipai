import blessed from "blessed";
import { tileLabel, type RoomSummary } from "@yifun/qipai-shared";
import type { QipaiClient } from "../ws/client.js";
import { loadConfig, saveConfig } from "../config.js";

type ScreenMode = "login" | "lobby" | "room" | "mahjong" | "tenhalf";

interface AppState {
  mode: ScreenMode;
  username: string;
  rooms: RoomSummary[];
  room?: RoomSummary;
  game?: Record<string, unknown>;
  status: string;
  // mahjong UI
  cursor: number;
  lockedTileId: string | null;
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

  const main = blessed.box({
    parent: screen,
    top: 3,
    left: 0,
    width: "70%",
    height: "100%-6",
    tags: true,
    border: { type: "line" },
    label: " 主区 ",
    content: "",
  });

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

  function renderHeader(): void {
    header.setContent(
      ` {bold}${state.username || "未登录"}{/bold}  |  ${state.status}  |  q退出  Esc取消输入`,
    );
  }

  function renderMahjong(): void {
    const g = state.game as {
      players?: Array<{
        seat: number;
        username: string;
        handCount: number;
        discards: Array<{ suit: string; rank: number }>;
        melds: Array<{ type: string; tiles: Array<{ suit: string; rank: number }> }>;
        score: number;
      }>;
      selfHand?: Array<{ id: string; suit: string; rank: number }>;
      selfSeat?: number;
      dealerSeat?: number;
      currentSeat?: number;
      wallRemaining?: number;
      deadWall?: number;
      phase?: string;
      availableActions?: string[];
      lastDiscard?: { suit: string; rank: number };
    };
    if (!g?.players) {
      main.setContent("等待对局状态…");
      return;
    }
    const self = g.selfSeat ?? 0;
    const order = [0, 1, 2, 3].map((i) => (self + i) % 4);
    // order: bottom=self, right, top, left relative
    const bySeat = (rel: number) => g.players!.find((p) => p.seat === order[rel])!;

    const top = bySeat(2);
    const left = bySeat(3);
    const right = bySeat(1);
    const bottom = bySeat(0);

    const hand = g.selfHand ?? [];
    if (state.cursor >= hand.length) state.cursor = Math.max(0, hand.length - 1);

    const handLine = hand
      .map((t, i) => {
        const lab = tileLabel(t as never);
        const locked = state.lockedTileId === t.id;
        const cur = i === state.cursor;
        if (locked && cur) return `{yellow-bg}{black-fg}[${lab}]{/}`;
        if (locked) return `{yellow-fg}[${lab}]{/}`;
        if (cur) return `{cyan-bg}{black-fg} ${lab} {/}`;
        return ` ${lab} `;
      })
      .join("");

    const fmt = (p: typeof top, tag: string) => {
      const dealer = g.dealerSeat === p.seat ? "庄" : "  ";
      const turn = g.currentSeat === p.seat ? "▶" : " ";
      const melds = p.melds.map((m) => m.tiles.map((t) => tileLabel(t as never)).join("")).join(" | ");
      const disc = p.discards.slice(-8).map((t) => tileLabel(t as never)).join(" ");
      return `${turn}${dealer}[${tag}] ${p.username} 分${p.score} 手${p.handCount}\n  副露:${melds || "-"}\n  弃牌:${disc || "-"}`;
    };

    const center = [
      `阶段:${g.phase}  墙:${g.wallRemaining}  死牌区:${g.deadWall}`,
      g.lastDiscard ? `上一张出牌: ${tileLabel(g.lastDiscard as never)}` : "",
      `可选: ${(g.availableActions ?? []).join(",") || "-"}`,
      state.lockedTileId ? "已锁定，再按空格出牌 / Esc取消锁定" : "←→选牌  空格锁定  再空格出牌",
      "快捷: p碰 g明杠 h胡 a暗杠 b补杠 n过",
    ].join("\n");

    main.setContent(
      [
        fmt(top, "对家"),
        "",
        `${fmt(left, "上家")}          ${fmt(right, "下家")}`,
        "",
        "──────── 公区 ────────",
        center,
        "──────── 自家 ────────",
        fmt(bottom, "自己"),
        "",
        handLine || "(无手牌)",
      ].join("\n"),
    );

    footer.setContent(
      `{bold}麻将{/bold}  ${g.phase} | 空格出牌 | p/g/h/a/b/n | r刷新`,
    );
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
    if (!g?.players) {
      main.setContent("等待十点半状态…");
      return;
    }
    const lines = g.players.map((p) => {
      const turn = g.currentSeat === p.seat ? "▶" : " ";
      const bank = g.bankerSeat === p.seat ? "庄" : "  ";
      const hole = p.hole ? `${p.hole.suit}${p.hole.rank}` : "??";
      const open = p.open.map((c) => `${c.suit}${c.rank}`).join(" ");
      const st = p.busted ? "炸" : p.stopped ? "停" : "…";
      return `${turn}${bank}座位${p.seat} ${p.username} [${st}] 暗:${hole} 明:${open || "-"} 点:${p.points ?? "?"} ${p.strength ?? ""} 分${p.score}`;
    });
    main.setContent(
      [
        `十点半（${g.mode}） 阶段:${g.phase} 锅底:${g.potTotal}`,
        "",
        ...lines,
        "",
        `可选: ${(g.availableActions ?? []).join(",") || "-"}`,
        "h 要牌  s 停牌",
      ].join("\n"),
    );
    footer.setContent(`{bold}十点半{/bold}  h要牌 s停牌 | r刷新`);
  }

  function renderLobby(): void {
    const lines = state.rooms.length
      ? state.rooms.map(
          (r, i) =>
            ` ${i + 1}. [${r.gameType}] ${r.name} (${r.roomId}) ${r.phase} ${r.seats.filter((s) => s.userId).length}/${r.maxSeats}`,
        )
      : [" （暂无房间）"];
    main.setContent(
      [
        "{bold}玩法大厅{/bold}",
        "  1) 创建陕西麻将房（3人机）",
        "  2) 创建十点半通比房（3人机）",
        "  3) 创建十点半打庄房（1人机）",
        "  r) 刷新房间列表",
        "  j) 加入房间（输入 roomId）",
        "",
        "房间列表:",
        ...lines,
      ].join("\n"),
    );
    footer.setContent("大厅: 1/2/3创建  j加入  r刷新  q退出");
  }

  function renderRoom(): void {
    const r = state.room;
    if (!r) {
      main.setContent("无房间");
      return;
    }
    const seats = r.seats
      .map((s) => {
        if (!s.userId) return `  座位${s.seat}: (空)`;
        return `  座位${s.seat}: ${s.username}${s.isBot ? "[机]" : ""} ${s.ready ? "准备" : "未准备"} 分${s.score} ${s.connected ? "在线" : "离线"}`;
      })
      .join("\n");
    main.setContent(
      [
        `{bold}房间 ${r.name}{/bold} (${r.roomId})`,
        `玩法: ${r.gameType}  阶段: ${r.phase}`,
        `配置: ${JSON.stringify(r.config)}`,
        "",
        seats,
        "",
        "y准备  u取消准备  b加人机  s开始  n再来一局  x回大厅等待  l离开",
      ].join("\n"),
    );
    footer.setContent("房间: y/u准备  b人机  s开始  l离开");
  }

  function renderLogin(): void {
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

  client.on("sys.error", (env) => {
    const p = env.payload as { message?: string; code?: string };
    log(`错误[${p.code}]: ${p.message}`);
    setStatus(p.message ?? "错误");
  });

  client.on("sys.kicked", (env) => {
    const p = env.payload as { reason?: string };
    log(`被顶号: ${p.reason}`);
    setStatus("被顶号");
  });

  client.on("auth.ok", (env) => {
    const p = env.payload as {
      sessionToken: string;
      username: string;
      expiresAt: number;
    };
    state.username = p.username;
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
    state.room = room;
    if (room.phase === "playing") {
      state.mode = room.gameType === "mahjong" ? "mahjong" : "tenhalf";
    } else if (state.mode === "lobby" || state.mode === "login") {
      state.mode = "room";
    } else if (room.phase === "waiting" || room.phase === "settled") {
      if (state.mode === "mahjong" || state.mode === "tenhalf") {
        // 结算后仍显示房间，可看分
        state.mode = "room";
      } else {
        state.mode = "room";
      }
    }
    render();
  });

  client.on("room.left", () => {
    state.room = undefined;
    state.game = undefined;
    state.mode = "lobby";
    client.send("lobby.listRooms", {});
    render();
  });

  client.on("game.state", (env) => {
    state.game = env.payload as Record<string, unknown>;
    const gt = (env.payload as { gameType?: string }).gameType;
    state.mode = gt === "tenhalf" ? "tenhalf" : "mahjong";
    // 重置光标若手牌变化
    const hand = (env.payload as { selfHand?: unknown[] }).selfHand;
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
      // 若不成功用户可再 Enter
    }
    const name = await prompt("用户名: ");
    if (!name) return;
    state.username = name;
    client.send("auth.login", { username: name });
  }

  screen.key(["q", "C-c"], () => {
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

  // 麻将快捷键
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
  screen.key(["n"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "pass", data: {} });
    else if (state.mode === "room") client.send("room.nextRound", {});
  });
  screen.key(["S-h", "H"], () => {
    /* avoid conflict */
  });

  // tenhalf hit/stand — use keys when in tenhalf; mahjong hu uses capital or alternate
  screen.key(["s"], () => {
    if (state.mode === "tenhalf") client.send("game.action", { action: "stand", data: {} });
    else if (state.mode === "room") client.send("room.start", {});
  });

  // Use 'u' for hu in mahjong to free 'h' for tenhalf hit — plan said h for hu
  // Actually: in mahjong mode h=hu, in tenhalf h=hit
  screen.key(["h"], () => {
    if (state.mode === "mahjong") client.send("game.action", { action: "hu", data: {} });
    else if (state.mode === "tenhalf") client.send("game.action", { action: "hit", data: {} });
  });

  screen.key(["y"], () => {
    if (state.mode === "room") client.send("room.ready", { ready: true });
  });
  screen.key(["u"], () => {
    if (state.mode === "room") client.send("room.ready", { ready: false });
  });
  screen.key(["l"], () => {
    if (state.mode === "room" || state.mode === "mahjong" || state.mode === "tenhalf") {
      client.send("room.leave", {});
    }
  });
  screen.key(["x"], () => {
    if (state.mode === "room") client.send("room.back", {});
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
      config: { mode: "free", potPerPlayer: 10, botCount: 3, maxPlayers: 4 },
    });
  });
  screen.key(["3"], () => {
    if (state.mode !== "lobby") return;
    client.send("room.create", {
      gameType: "tenhalf",
      config: { mode: "banker", potPerPlayer: 10, botCount: 1, maxPlayers: 2 },
    });
  });
  screen.key(["j"], async () => {
    if (state.mode !== "lobby") return;
    const id = await prompt("房间ID: ");
    if (id) client.send("room.join", { roomId: id });
  });

  render();
  log(`已连接 ${cfg.serverUrl}`);

  // 自动尝试 hello
  if (cfg.sessionToken) {
    client.send("auth.hello", { sessionToken: cfg.sessionToken });
  } else {
    setStatus("按 Enter 登录");
  }
}
