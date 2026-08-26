import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { Envelope } from "@yifun/qipai-shared";

type Handler = (env: Envelope) => void;

export class QipaiClient {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private anyHandlers = new Set<Handler>();
  private pending = new Map<string, { resolve: (v: Envelope) => void; reject: (e: Error) => void }>();

  constructor(private url: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => resolve());
      ws.on("error", (e) => reject(e));
      ws.on("message", (data) => {
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
        this.ws = null;
      });
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
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

  send(type: string, payload: unknown = {}, requestId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("未连接服务器");
    }
    const env: Envelope = { type, payload, requestId };
    this.ws.send(JSON.stringify(env));
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
      try {
        this.send(type, payload, requestId);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
}
