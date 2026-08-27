import type {
  GameType,
  MahjongRoomConfig,
  RoomConfig,
  RoomPhase,
  RoomSummary,
  TenhalfRoomConfig,
} from "@yifun/qipai-shared";

/** 终端显示宽度：CJK / 花色符号按双宽处理，避免框线被挤歪 */
export function visibleWidth(text: string): number {
  const plain = text.replace(/\{[^}]*\}/g, "");
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0)!;
    if (isWideCp(cp)) w += 2;
    else w += 1;
  }
  return w;
}

function isWideCp(cp: number): boolean {
  // 扑克花色 / 麻将牌面在 Windows 中文终端常按双宽渲染
  if (cp >= 0x2660 && cp <= 0x2667) return true;
  if (cp >= 0x1f000 && cp <= 0x1f02f) return true;
  if (cp >= 0x1100 && cp <= 0x115f) return true;
  if (cp >= 0x2e80 && cp <= 0xa4cf) return true;
  if (cp >= 0xac00 && cp <= 0xd7a3) return true;
  if (cp >= 0xf900 && cp <= 0xfaff) return true;
  if (cp >= 0xfe10 && cp <= 0xfe19) return true;
  if (cp >= 0xfe30 && cp <= 0xfe6f) return true;
  if (cp >= 0xff00 && cp <= 0xff60) return true;
  if (cp >= 0xffe0 && cp <= 0xffe6) return true;
  return false;
}

export function padVisible(text: string, width: number): string {
  const w = visibleWidth(text);
  if (w === width) return text;
  if (w < width) return text + " ".repeat(width - w);
  return truncateVisible(text, width);
}

export function truncateVisible(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  // 简单截断：逐字累加，保留标签块
  let out = "";
  let w = 0;
  const re = /(\{[^}]*\})|./gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const part = m[0]!;
    if (part.startsWith("{")) {
      out += part;
      continue;
    }
    const cw = isWideCp(part.codePointAt(0)!) ? 2 : 1;
    if (w + cw > width - 1) {
      out += "…";
      break;
    }
    out += part;
    w += cw;
  }
  // 补齐到 width（… 算 1）
  return padVisible(out, width);
}

export function gameTypeName(t: GameType): string {
  return t === "mahjong" ? "陕西麻将" : "十点半";
}

export function phaseName(p: RoomPhase): string {
  if (p === "waiting") return "等待中";
  if (p === "playing") return "对局中";
  return "已结算";
}

/** 麻将对局阶段 */
export function mahjongPhaseName(phase?: string): string {
  switch (phase) {
    case "draw":
      return "摸牌";
    case "discard":
      return "出牌";
    case "claim":
      return "鸣牌响应";
    case "settled":
      return "本局结算";
    case "liuju":
      return "流局";
    default:
      return phase || "-";
  }
}

/** 麻将可选动作 */
export function mahjongActionName(action: string): string {
  switch (action) {
    case "discard":
      return "出牌";
    case "peng":
      return "碰";
    case "mingGang":
      return "明杠";
    case "anGang":
      return "暗杠";
    case "buGang":
      return "补杠";
    case "hu":
      return "胡";
    case "pass":
      return "过";
    case "lockSelect":
      return "选牌";
    default:
      return action;
  }
}

export function formatMahjongActions(actions?: string[]): string {
  if (!actions?.length) return "无";
  return actions.map(mahjongActionName).join("、");
}

export function formatRoomConfig(gameType: GameType, config: RoomConfig): string[] {
  if (gameType === "mahjong") {
    const c = config as MahjongRoomConfig;
    return [
      `牌数 ${c.tileCount} 张`,
      `底分 ${c.baseScore}`,
      `总局数 ${c.maxRounds}`,
      `人机 ${c.botCount}`,
    ];
  }
  const c = config as TenhalfRoomConfig;
  return [
    `模式 ${c.mode === "banker" ? "打庄" : "通比"}`,
    `每人锅底 ${c.potPerPlayer}`,
    `总局数 ${c.maxRounds}`,
    `人数上限 ${c.maxPlayers}`,
    `人机 ${c.botCount}`,
    `人机停牌点 ${c.botStopAt}`,
  ];
}

export function hostName(room: RoomSummary): string {
  const host = room.seats.find((s) => s.userId === room.hostUserId);
  return host?.username || "未知";
}
