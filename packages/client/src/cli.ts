import { loadConfig, setConfigKey, configPath } from "./config.js";
import { QipaiClient } from "./ws/client.js";
import { runTui } from "./tui/app.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "config") {
    if (args[1] === "path") {
      console.log(configPath());
      return;
    }
    if (args[1] === "show") {
      console.log(JSON.stringify(loadConfig(), null, 2));
      return;
    }
    if (args[1] === "set" && args[2] && args[3]) {
      const cfg = setConfigKey(args[2], args[3]);
      console.log(JSON.stringify(cfg, null, 2));
      return;
    }
    console.log(`用法:
  yifunqipai              启动 TUI
  yifunqipai config show
  yifunqipai config path
  yifunqipai config set serverUrl ws://host:8787
  yifunqipai config set username 昵称`);
    return;
  }

  const cfg = loadConfig();
  const client = new QipaiClient(cfg.serverUrl);
  console.error(`连接 ${cfg.serverUrl} …`);
  await client.connect();
  await runTui(client);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
