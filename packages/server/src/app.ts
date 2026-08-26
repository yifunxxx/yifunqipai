import http from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  GAME_CATALOG,
  type Envelope,
  type GameActionPayload,
  type RoomCreatePayload,
  type RoomJoinPayload,
  type RoomReadyPayload,
  type RoomAddBotPayload,
  type RoomUpdateConfigPayload,
  type AuthLoginPayload,
  type AuthHelloPayload,
} from "@yifun/qipai-shared";
import type { Store } from "./db/store.js";
import { SessionService } from "./session/session-service.js";
import { LobbyService } from "./lobby/lobby-service.js";
import { MatchManager } from "./games/match-manager.js";
import { MahjongEngine } from "./games/mahjong-engine.js";

interface ClientCtx {
  connectionId: string;
  userId?: string;
  username?: string;
  sessionToken?: string;
  roomId?: string;
}

function send(ws: WebSocket, type: string, payload: unknown, requestId?: string): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const env: Envelope = { type, payload, requestId };
  ws.send(JSON.stringify(env));
}

function err(ws: WebSocket, code: string, message: string, requestId?: string): void {
  send(ws, "sys.error", { code, message, requestId }, requestId);
}

export function createApp(opts: {
  store: Store;
  sessionTtlMs: number;
  port: number;
}): { server: http.Server; wss: WebSocketServer; close: () => void } {
  const sessions = new SessionService(opts.store, opts.sessionTtlMs);
  const lobby = new LobbyService(opts.store);

  const connections = new Map<string, WebSocket>();
  const ctxByWs = new WeakMap<WebSocket, ClientCtx>();

  const broadcastRoom = (roomId: string): void => {
    const room = lobby.get(roomId);
    if (!room) return;
    const summary = lobby.toSummary(room);
    const engine = matches.getByRoom(roomId);
    for (const [connId, ws] of connections) {
      const ctx = ctxByWs.get(ws);
      if (!ctx?.userId) continue;
      const inRoom = room.seats.some((s) => s.userId === ctx.userId);
      if (!inRoom) continue;
      send(ws, "room.update", summary);
      if (engine) {
        const snap =
          engine instanceof MahjongEngine
            ? engine.snapshotFor(ctx.userId)
            : engine.snapshotFor(ctx.userId);
        send(ws, "game.state", snap);
      }
    }
  };

  const matches = new MatchManager(opts.store, lobby, broadcastRoom);

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    const connectionId = randomUUID();
    connections.set(connectionId, ws);
    const ctx: ClientCtx = { connectionId };
    ctxByWs.set(ws, ctx);

    ws.on("message", (raw) => {
      let msg: Envelope;
      try {
        msg = JSON.parse(String(raw)) as Envelope;
      } catch {
        err(ws, "BAD_JSON", "无效 JSON");
        return;
      }
      try {
        handle(ws, ctx, msg);
      } catch (e) {
        const ex = e as Error & { code?: string };
        err(ws, ex.code ?? "INTERNAL", ex.message || "内部错误", msg.requestId);
      }
    });

    ws.on("close", () => {
      connections.delete(connectionId);
      if (ctx.userId) {
        sessions.clearConnection(ctx.userId, connectionId);
        lobby.setSeatConnected(ctx.userId, false);
        if (ctx.roomId) broadcastRoom(ctx.roomId);
      }
    });
  });

  function requireAuth(ctx: ClientCtx, requestId?: string): asserts ctx is ClientCtx & {
    userId: string;
    username: string;
    sessionToken: string;
  } {
    if (!ctx.sessionToken || !ctx.userId) {
      throw Object.assign(new Error("未登录"), { code: "AUTH_REQUIRED" });
    }
    sessions.requireValid(ctx.sessionToken);
  }

  function handle(ws: WebSocket, ctx: ClientCtx, msg: Envelope): void {
    const { type, requestId, payload } = msg;

    if (type === "auth.login") {
      const p = payload as AuthLoginPayload;
      const ok = sessions.login(p.username ?? "游客");
      bindAuth(ws, ctx, ok.sessionToken, ok.userId, ok.username);
      send(ws, "auth.ok", ok, requestId);
      resumeRoom(ws, ctx);
      return;
    }

    if (type === "auth.hello") {
      const p = payload as AuthHelloPayload;
      const ok = sessions.hello(p.sessionToken);
      if (!ok) {
        err(ws, "AUTH_INVALID", "会话无效或过期", requestId);
        return;
      }
      bindAuth(ws, ctx, ok.sessionToken, ok.userId, ok.username);
      send(ws, "auth.ok", ok, requestId);
      resumeRoom(ws, ctx);
      return;
    }

    requireAuth(ctx, requestId);

    switch (type) {
      case "lobby.listGames":
        send(ws, "lobby.games", { games: GAME_CATALOG }, requestId);
        break;
      case "lobby.listRooms":
        send(ws, "lobby.rooms", { rooms: lobby.listRooms() }, requestId);
        break;
      case "room.create": {
        const p = payload as RoomCreatePayload;
        const room = lobby.create(
          ctx.userId!,
          ctx.username!,
          p.gameType,
          p.name,
          p.config ?? {},
        );
        ctx.roomId = room.roomId;
        send(ws, "room.update", lobby.toSummary(room), requestId);
        broadcastRoom(room.roomId);
        break;
      }
      case "room.join": {
        const p = payload as RoomJoinPayload;
        const room = lobby.join(p.roomId, ctx.userId!, ctx.username!);
        ctx.roomId = room.roomId;
        send(ws, "room.update", lobby.toSummary(room), requestId);
        broadcastRoom(room.roomId);
        break;
      }
      case "room.leave": {
        if (!ctx.roomId) break;
        const rid = ctx.roomId;
        lobby.leave(rid, ctx.userId!);
        ctx.roomId = undefined;
        send(ws, "room.left", { roomId: rid }, requestId);
        broadcastRoom(rid);
        break;
      }
      case "room.ready": {
        const p = payload as RoomReadyPayload;
        if (!ctx.roomId) throw Object.assign(new Error("不在房间"), { code: "NOT_IN_ROOM" });
        const room = lobby.setReady(ctx.roomId, ctx.userId!, p.ready);
        broadcastRoom(room.roomId);
        break;
      }
      case "room.addBot": {
        const p = (payload ?? {}) as RoomAddBotPayload;
        if (!ctx.roomId) throw Object.assign(new Error("不在房间"), { code: "NOT_IN_ROOM" });
        const room = lobby.addBots(ctx.roomId, ctx.userId!, p.count ?? 1);
        broadcastRoom(room.roomId);
        break;
      }
      case "room.updateConfig": {
        const p = payload as RoomUpdateConfigPayload;
        if (!ctx.roomId) throw Object.assign(new Error("不在房间"), { code: "NOT_IN_ROOM" });
        const room = lobby.updateConfig(ctx.roomId, ctx.userId!, p.config ?? {});
        broadcastRoom(room.roomId);
        break;
      }
      case "room.start": {
        if (!ctx.roomId) throw Object.assign(new Error("不在房间"), { code: "NOT_IN_ROOM" });
        const room = lobby.get(ctx.roomId);
        if (!room) throw Object.assign(new Error("房间不存在"), { code: "ROOM_NOT_FOUND" });
        if (room.hostUserId !== ctx.userId) {
          throw Object.assign(new Error("仅房主可开始"), { code: "NOT_HOST" });
        }
        matches.start(room);
        broadcastRoom(room.roomId);
        break;
      }
      case "room.nextRound": {
        if (!ctx.roomId) throw Object.assign(new Error("不在房间"), { code: "NOT_IN_ROOM" });
        const room = lobby.get(ctx.roomId);
        if (!room) throw Object.assign(new Error("房间不存在"), { code: "ROOM_NOT_FOUND" });
        if (room.hostUserId !== ctx.userId) {
          throw Object.assign(new Error("仅房主可操作"), { code: "NOT_HOST" });
        }
        const eng = matches.nextRound(room);
        if (!eng) broadcastRoom(room.roomId);
        else broadcastRoom(room.roomId);
        break;
      }
      case "room.back": {
        if (!ctx.roomId) break;
        matches.returnToLobby(ctx.roomId);
        broadcastRoom(ctx.roomId);
        break;
      }
      case "game.action": {
        const p = payload as GameActionPayload;
        if (!ctx.roomId) throw Object.assign(new Error("不在房间"), { code: "NOT_IN_ROOM" });
        // 会话过期检查已在 requireAuth
        matches.action(ctx.roomId, ctx.userId!, p.action, p.data ?? {});
        break;
      }
      case "game.sync": {
        if (!ctx.roomId) break;
        broadcastRoom(ctx.roomId);
        break;
      }
      default:
        err(ws, "UNKNOWN_TYPE", `未知消息类型 ${type}`, requestId);
    }
  }

  function bindAuth(
    ws: WebSocket,
    ctx: ClientCtx,
    token: string,
    userId: string,
    username: string,
  ): void {
    const kicked = sessions.bindConnection(userId, ctx.connectionId);
    if (kicked) {
      const oldWs = connections.get(kicked);
      if (oldWs && oldWs !== ws) {
        send(oldWs, "sys.kicked", { reason: "账号在其他终端登录" });
        oldWs.close();
      }
    }
    ctx.sessionToken = token;
    ctx.userId = userId;
    ctx.username = username;
    lobby.setSeatConnected(userId, true);
  }

  function resumeRoom(ws: WebSocket, ctx: ClientCtx): void {
    if (!ctx.userId) return;
    const room = lobby.findRoomByUser(ctx.userId);
    if (!room) return;
    ctx.roomId = room.roomId;
    send(ws, "room.update", lobby.toSummary(room));
    const engine = matches.getByRoom(room.roomId);
    if (engine) {
      const snap =
        engine instanceof MahjongEngine
          ? engine.snapshotFor(ctx.userId)
          : engine.snapshotFor(ctx.userId);
      send(ws, "game.state", snap);
    }
  }

  return {
    server,
    wss,
    close: () => {
      wss.close();
      server.close();
    },
  };
}
