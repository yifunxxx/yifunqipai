import { randomUUID } from "node:crypto";
import {
  DEFAULT_SESSION_TTL_MS,
  type AuthOkPayload,
} from "@yifun/qipai-shared";
import type { Store, SessionRow } from "../db/store.js";

export class SessionService {
  constructor(
    private store: Store,
    private ttlMs: number = DEFAULT_SESSION_TTL_MS,
  ) {}

  login(username: string): AuthOkPayload {
    const name = username.trim().slice(0, 32) || "游客";
    const userId = randomUUID();
    const sessionToken = randomUUID();
    const now = Date.now();
    const expiresAt = now + this.ttlMs;
    const row: SessionRow = {
      user_id: userId,
      session_token: sessionToken,
      username: name,
      expires_at: expiresAt,
      connection_id: null,
      created_at: now,
    };
    this.store.upsertSession(row);
    return {
      sessionToken,
      userId,
      username: name,
      expiresAt,
    };
  }

  getByToken(sessionToken: string): SessionRow | undefined {
    return this.store.getSessionByToken(sessionToken);
  }

  hello(sessionToken: string): AuthOkPayload | null {
    const row = this.store.getSessionByToken(sessionToken);
    if (!row) return null;
    if (row.expires_at < Date.now()) return null;
    const expiresAt = this.touch(row.user_id);
    return {
      sessionToken: row.session_token,
      userId: row.user_id,
      username: row.username,
      expiresAt,
    };
  }

  requireValid(sessionToken: string): SessionRow {
    const row = this.store.getSessionByToken(sessionToken);
    if (!row) throw Object.assign(new Error("会话无效"), { code: "AUTH_INVALID" });
    if (row.expires_at < Date.now()) {
      throw Object.assign(new Error("会话已过期，请重新登录"), { code: "AUTH_EXPIRED" });
    }
    return row;
  }

  /** 滑动过期：有活动则把过期时间推到 now + TTL */
  touch(userId: string): number {
    const expiresAt = Date.now() + this.ttlMs;
    this.store.touchSession(userId, expiresAt);
    return expiresAt;
  }

  listExpired(now = Date.now()): SessionRow[] {
    return this.store.listExpiredSessions(now);
  }

  delete(userId: string): void {
    this.store.deleteSession(userId);
  }

  bindConnection(userId: string, connectionId: string): string | null {
    const prev = this.store.getSessionByUserId(userId);
    const oldConn = prev?.connection_id ?? null;
    this.store.setConnection(userId, connectionId);
    return oldConn && oldConn !== connectionId ? oldConn : null;
  }

  clearConnection(userId: string, connectionId: string): void {
    const row = this.store.getSessionByUserId(userId);
    if (row?.connection_id === connectionId) {
      this.store.setConnection(userId, null);
    }
  }
}
