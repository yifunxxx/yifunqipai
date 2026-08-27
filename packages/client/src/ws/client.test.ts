import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { WebSocketServer } from "ws";
import { QipaiClient } from "./client.js";

describe("QipaiClient", () => {
  it("send while disconnected does not throw", () => {
    const client = new QipaiClient("ws://127.0.0.1:1");
    assert.equal(client.send("lobby.listRooms", {}), false);
  });

  it("reconnects after the server closes an idle socket", async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    let connections = 0;
    wss.on("connection", (ws) => {
      connections += 1;
      if (connections === 1) {
        setTimeout(() => ws.close(), 40);
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const client = new QipaiClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("did not reconnect")), 8000);
      client.onStatus((status) => {
        if (status === "open" && connections >= 2) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
