import path from "node:path";
import { Store } from "./db/store.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = process.env.DATA_DIR ?? path.resolve("data");
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS ?? 24 * 60 * 60 * 1000);

const store = new Store(path.join(DATA_DIR, "qipai.db"));
const { server } = createApp({ store, sessionTtlMs: SESSION_TTL_MS, port: PORT });

server.listen(PORT, () => {
  console.log(`[qipai-server] http+ws on :${PORT} data=${DATA_DIR}`);
});
