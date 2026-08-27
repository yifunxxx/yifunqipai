import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Envelope } from "@yifun/qipai-shared";

type Handler = (env: Envelope) => void;
export type ConnStatus = "open" | "reconnecting" | "closed";

const PING_MS = 20_000;
const RECONNECT_MAX_MS = 15_000;

export class QipaiClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private anyHandlers = new Set<Handler>();
  private pending = new Map<string, { resolve: (v: Envelope) => void; reject: (e: Error) => void }>();
  private statusHandlers = new Set<(s: ConnStatus, detail?: string) => void>();
  private droppedHandlers = new Set<(type: string) => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private connectGeneration = 0;
  private everConnected = false;

  constructor(private url: string) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    this.closedByUser = false;
    return this.openSocket();
  }

  onStatus(handler: (s: ConnStatus, detail?: string) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  onDropped(handler: (type: string) => void): () => void {
    this.droppedHandlers.add(handler);
    return () => this.droppedHandlers.delete(handler);
  }

  close(): void {
    this.closedByUser = true;
    this.connectGeneration += 1;
    this.clearPing();
    this.clearReconnect();
    this.ws?.close();
    this.ws = null;
    this.emitStatus("closed");
  }

  on(type: string, handler: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  onAny(handler: Handler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  send(type: string, payload: unknown = {}, requestId?: string): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (type !== "sys.ping") {
        for (const h of this.droppedHandlers) h(type);
      }
      return false;
    }
    const env: Envelope = { type, payload, requestId };
    this.ws.send(JSON.stringify(env));
    return true;
  }

  request(type: string, payload: unknown = {}, timeoutMs = 8000): Promise<Envelope> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`请求超时: ${type}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject,
      });
      if (!this.send(type, payload, requestId)) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(new Error("未连接服务器"));
      }
    });
  }

  private openSocket(): Promise<void> {
    this.clearReconnect();
    const gen = ++this.connectGeneration;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.on("open", () => {
        if (gen !== this.connectGeneration || this.ws !== ws) return;
        settled = true;
        this.reconnectAttempt = 0;
        this.everConnected = true;
        this.startPing();
        this.emitStatus("open");
        resolve();
      });

      ws.on("error", (e) => {
        if (gen !== this.connectGeneration || this.ws !== ws) return;
        if (!settled) {
          settled = true;
          reject(e);
        }
      });

      ws.on("message", (data) => {
        if (this.ws !== ws) return;
        let env: Envelope;
        try {
          env = JSON.parse(String(data)) as Envelope;
        } catch {
          return;
        }
        if (env.requestId && this.pending.has(env.requestId)) {
          this.pending.get(env.requestId)!.resolve(env);
          this.pending.delete(env.requestId);
        }
        for (const h of this.anyHandlers) h(env);
        for (const h of this.handlers.get(env.type) ?? []) h(env);
      });

      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        this.clearPing();
        if (this.closedByUser || gen !== this.connectGeneration || !this.everConnected) return;
        this.emitStatus("closed");
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.closedByUser || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt += 1;
    this.emitStatus("reconnecting", String(this.reconnectAttempt));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.openSocket().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.ping();
      } catch {
        /* ignore */
      }
      this.send("sys.ping", { t: Date.now() });
    }, PING_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private emitStatus(s: ConnStatus, detail?: string): void {
    for (const h of this.statusHandlers) h(s, detail);
  }
}
