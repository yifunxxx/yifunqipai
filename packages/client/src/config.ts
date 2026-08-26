import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ClientConfig {
  serverUrl: string;
  sessionToken?: string;
  username?: string;
}

const DIR = path.join(os.homedir(), ".yifunqipai");
const FILE = path.join(DIR, "config.json");

export function configPath(): string {
  return FILE;
}

export function loadConfig(): ClientConfig {
  try {
    if (fs.existsSync(FILE)) {
      return { serverUrl: "ws://127.0.0.1:8787", ...JSON.parse(fs.readFileSync(FILE, "utf8")) };
    }
  } catch {
    /* ignore */
  }
  return { serverUrl: "ws://127.0.0.1:8787" };
}

export function saveConfig(cfg: ClientConfig): void {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), "utf8");
}

export function setConfigKey(key: string, value: string): ClientConfig {
  const cfg = loadConfig();
  if (key === "serverUrl") cfg.serverUrl = value;
  else if (key === "username") cfg.username = value;
  else if (key === "sessionToken") cfg.sessionToken = value;
  else throw new Error(`未知配置项: ${key}`);
  saveConfig(cfg);
  return cfg;
}
