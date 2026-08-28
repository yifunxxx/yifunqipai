# @yifunxxx/qipai-cli

当前 npm 版本：**0.1.5**

终端棋牌大厅客户端。安装后命令：`yifunqipai`。

本包只含客户端。需要有人先把服务端跑起来，再在配置里填入 WebSocket 地址。

## 安装

```bash
npm i -g @yifunxxx/qipai-cli
```

已安装过，更新到最新版：

```bash
npm i -g @yifunxxx/qipai-cli@latest
```

需要 Node.js ≥ 20。

## 配置服务端地址

配置文件：`~/.yifunqipai/config.json`

```bash
yifunqipai config set serverUrl ws://你的服务器:8787
```

可选：

```bash
yifunqipai config set username 你的昵称
yifunqipai config show
yifunqipai config path
```

未配置时默认连 `ws://127.0.0.1:8787`。

## 启动

```bash
yifunqipai
```

进入 TUI 后用昵称登录（已登录过会尝试恢复会话）。大厅里创建/加入房间即可打牌。按 `o` 退出登录后可换用户名。
