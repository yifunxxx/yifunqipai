import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface SessionRow {
  user_id: string;
  session_token: string;
  username: string;
  expires_at: number;
  connection_id: string | null;
  created_at: number;
}

export interface MatchSnapshotRow {
  match_id: string;
  room_id: string;
  game_type: string;
  state_json: string;
  updated_at: number;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        user_id TEXT PRIMARY KEY,
        session_token TEXT UNIQUE NOT NULL,
        username TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        connection_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);

      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        data_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS match_snapshots (
        match_id TEXT PRIMARY KEY,
        room_id TEXT NOT NULL,
        game_type TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  upsertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (user_id, session_token, username, expires_at, connection_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           session_token=excluded.session_token,
           username=excluded.username,
           expires_at=excluded.expires_at,
           connection_id=excluded.connection_id`,
      )
      .run(
        row.user_id,
        row.session_token,
        row.username,
        row.expires_at,
        row.connection_id,
        row.created_at,
      );
  }

  getSessionByToken(token: string): SessionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE session_token = ?`)
      .get(token) as SessionRow | undefined;
  }

  getSessionByUserId(userId: string): SessionRow | undefined {
    return this.db.prepare(`SELECT * FROM sessions WHERE user_id = ?`).get(userId) as
      | SessionRow
      | undefined;
  }

  setConnection(userId: string, connectionId: string | null): void {
    this.db
      .prepare(`UPDATE sessions SET connection_id = ? WHERE user_id = ?`)
      .run(connectionId, userId);
  }

  touchSession(userId: string, expiresAt: number): void {
    this.db
      .prepare(`UPDATE sessions SET expires_at = ? WHERE user_id = ?`)
      .run(expiresAt, userId);
  }

  listExpiredSessions(now: number): SessionRow[] {
    return this.db
      .prepare(`SELECT * FROM sessions WHERE expires_at < ?`)
      .all(now) as unknown as SessionRow[];
  }

  deleteSession(userId: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(userId);
  }

  saveRoom(roomId: string, data: unknown): void {
    this.db
      .prepare(
        `INSERT INTO rooms (room_id, data_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`,
      )
      .run(roomId, JSON.stringify(data), Date.now());
  }

  deleteRoom(roomId: string): void {
    this.db.prepare(`DELETE FROM rooms WHERE room_id = ?`).run(roomId);
  }

  loadAllRooms(): Array<{ room_id: string; data_json: string }> {
    return this.db.prepare(`SELECT room_id, data_json FROM rooms`).all() as Array<{
      room_id: string;
      data_json: string;
    }>;
  }

  saveMatchSnapshot(row: MatchSnapshotRow): void {
    this.db
      .prepare(
        `INSERT INTO match_snapshots (match_id, room_id, game_type, state_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(match_id) DO UPDATE SET
           state_json=excluded.state_json,
           updated_at=excluded.updated_at`,
      )
      .run(row.match_id, row.room_id, row.game_type, row.state_json, row.updated_at);
  }

  getMatchByRoom(roomId: string): MatchSnapshotRow | undefined {
    return this.db
      .prepare(`SELECT * FROM match_snapshots WHERE room_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(roomId) as MatchSnapshotRow | undefined;
  }

  deleteMatch(matchId: string): void {
    this.db.prepare(`DELETE FROM match_snapshots WHERE match_id = ?`).run(matchId);
  }
}
