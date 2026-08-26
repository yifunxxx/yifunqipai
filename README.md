# 终端棋牌大厅

TypeScript monorepo：WebSocket 服务端 + 终端客户端（`yifunqipai` / `@yifun/qipai-cli`）。

支持匿名会话登录、房间大厅、陕西麻将（112/144）、十点半（打庄/通比）、人机、断线重连与局内记分。

持久化使用 Node.js 22 内置 `node:sqlite`（需 `--experimental-sqlite`），避免本机编译 native 模块。

## 仓库结构

```text
packages/
  shared/   # 协议、牌面、规则工具
  server/   # HTTP /health + WebSocket + SQLite
  client/   # TUI 客户端 bin: yifunqipai
```

## 本地开发

要求：Node.js ≥ 20，[pnpm](https://pnpm.io/) 9。

```bash
# 安装
pnpm install

# 构建全部
pnpm build

# 启动服务端（默认 ws/http :8787，数据目录 ./data）
pnpm dev:server

# 另开终端启动客户端
pnpm dev:client
```

若本机无全局 pnpm，可用：`npm i pnpm@9 --prefix ./.tools`，再执行 `./.tools/node_modules/.bin/pnpm …`。

或使用已构建产物：

```bash
pnpm --filter @yifun/qipai-server start
pnpm --filter @yifun/qipai-cli start
```

### 客户端配置

配置文件：`~/.yifunqipai/config.json`

```bash
# 通过 CLI
pnpm --filter @yifun/qipai-cli start -- config set serverUrl ws://127.0.0.1:8787
pnpm --filter @yifun/qipai-cli start -- config show
```

全局安装本地包（开发自测）：

```bash
pnpm --filter @yifun/qipai-cli build
cd packages/client && pnpm pack
npm i -g ./yifun-qipai-cli-0.1.0.tgz
yifunqipai config set serverUrl ws://127.0.0.1:8787
yifunqipai
```

> 注意：本地 monorepo 依赖 `@yifun/qipai-shared`（workspace）。发布到 npm 前需先发布 shared，或将 shared 打进客户端包。

### 环境变量（服务端）

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8787` | HTTP + WS 端口 |
| `DATA_DIR` | `./data` | SQLite 目录 |
| `SESSION_TTL_MS` | `86400000` | 会话 TTL（24h） |

## Docker

```bash
docker compose up -d --build
# 健康检查
curl http://127.0.0.1:8787/health
```

数据卷挂载在 `/data`。客户端连接：

```bash
yifunqipai config set serverUrl ws://127.0.0.1:8787
yifunqipai
```

## 客户端操作（TUI）

| 场景 | 按键 |
|------|------|
| 登录 | Enter 输入用户名 |
| 大厅 | `1` 麻将三人机 / `2` 十点半通比 / `3` 打庄 / `j` 加入 / `r` 刷新 |
| 房间 | `y`/`u` 准备 / `b` 加人机 / `s` 开始 / `l` 离开 / `n` 再来一局 |
| 麻将 | `←`/`→` 选牌，空格锁定，再空格出牌；`p`碰 `g`明杠 `h`胡 `a`暗杠 `b`补杠 `n`过 |
| 十点半 | `h` 要牌 `s` 停牌 |
| 全局 | `q` 退出 |

身份以 `sessionToken` 为准（可重名）。同一会话新连接会顶掉旧连接（旧端收到 `sys.kicked`）。

## 玩法摘要

### 陕西麻将

- 112：万筒条 + 红中（非万能）；144：标准牌
- 可碰/杠/胡，不可吃
- 死牌区：112 底 14 / 144 底 20；奇数次补牌杠 → 底+1，偶数次回到底
- 计分 × 底分：平胡 1；清一色/七对/十三幺 2（十三幺仅 144）；明杠点炮者付 1；暗杠其余各付 2；碰后杠其余各付 1；庄家相关再翻倍
- 首局摇骰定庄；赢家坐庄；流局连庄

### 十点半

- A=1，2–10 面值，J/Q/K=0.5；2–6 人
- 强度：五龙 > 十点半 > 未炸点数；炸则输掉份额
- 通比：最大通吃；同档抽牌，两次仍和则平分
- 打庄：庄与各闲比；闲炸输给庄；庄炸对未炸闲赔付

## 测试

```bash
pnpm --filter @yifun/qipai-shared test
```

覆盖：死牌区奇偶杠、平胡/七对/十三幺/清一色、五龙优于十点半。

## 发布客户端到 npm（说明）

1. 确认拥有 `@yifun` npm org 权限。
2. 先发布 `@yifun/qipai-shared`（将 `private` 去掉并改依赖版本），或把 shared 源码打包进 cli。
3. 在 `packages/client`：`pnpm build && npm publish --access public`
4. 用户：`npm i -g @yifun/qipai-cli` → `yifunqipai`

## Git

仓库已 `git init`。请自行 commit / 添加 remote / push。勿提交 `.env`、SQLite 数据与密钥。
