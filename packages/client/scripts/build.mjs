import { mkdirSync } from "node:fs";
import { build } from "esbuild";

mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: "dist/cli.js",
  // 运行时仍从 npm 安装；workspace 的 shared 打进这一份文件
  external: ["blessed", "ws"],
  logLevel: "info",
});
