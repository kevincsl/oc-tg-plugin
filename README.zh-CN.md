# oc-tg-plugin

[English](README.md) | [繁體中文](README.zh-TW.md) | **简体中文** | [日本語](README.ja.md) | [한국어](README.ko.md)

[opencode](https://opencode.ai) 的 Telegram 私信桥接插件 — 移植自
[badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)。

把 Telegram 私信变成 opencode session 的遥控界面：从手机发送指令、实时流式回复、双向传文件。

## 功能

- **配对** — 第一个私信机器人的 Telegram 用户即成为唯一授权用户
- **转发** — Telegram 消息会以 `[telegram]` 前缀送进最近使用的 opencode session
- **流式预览** — 模型生成时实时编辑消息（有节流，并按 Telegram 4096 字符上限切分）
- **附件接收** — 照片、文档、语音、视频、贴纸会下载到本地再交给模型（图片内嵌 + 文本附临时路径）；媒体组会合并去抖
- **附件回传** — 模型可调用 `telegram_attach` 工具，把文件随最终回复传回（照片以照片发送，其他以文档发送）
- **队列** — opencode 忙碌时收到的消息会排队等候
- **命令** — `/help`、`/start`、`/status`、`stop`（中止当前回合）

## 安装配置

1. 到 [@BotFather](https://t.me/BotFather) 创建机器人并复制 token。
2. 启用插件并提供 token（二选一即可）：
   - 在环境变量设置 `TELEGRAM_BOT_TOKEN`，**或**
   - 创建 `~/.config/opencode/telegram.json`：

   ```json
   {
     "botToken": "123456:AA...",
     "botUsername": "yourbot",
     "botId": 123456
   }
   ```

3. 在 `opencode.json` 中添加插件：

   ```json
   {
     "plugin": ["oc-tg-plugin"]
   }
   ```

   本地开发可直接指向源文件：

   ```json
   {
     "plugin": ["/absolute/path/to/oc-tg-plugin/src/index.ts"]
   }
   ```

4. 重启 opencode。只要有 token，轮询会自动启动。
5. 在 Telegram 私信你的机器人并发送 `/start` 来配对账号。

## 使用方式

直接私信机器人。消息会送进当前使用的 opencode session，回复则传回 Telegram。opencode 工作中时，后续消息会进入队列。

| 命令      | 效果                      |
| --------- | ------------------------- |
| `/start`  | 配对账号 / 显示帮助       |
| `/help`   | 显示帮助                  |
| `/status` | 机器人、session、队列状态 |
| `stop`    | 中止当前回合              |

## 注意事项与边界

- 交互式 TUI 工具（选项选择器、权限对话框）在 Telegram 上不可见；模型会被引导改用纯文本编号选项提问。
- 每个 bot token 同时只能有一个轮询者：多个 opencode 实例会争抢 `getUpdates`（输家会被 Telegram 409 拒绝）。
- 配置与状态存放在 `~/.config/opencode/telegram.json`（`lastUpdateId`、`allowedUserId` 会自动管理）。
- 本项目从 pi 的扩展 API 移植到 opencode 的插件 API（`event` 总线 + `client.session.promptAsync`）；pi 的草稿流式 API 在 Telegram 没有对应机制，因此预览改用 `sendMessage` + `editMessageText`。

## 开发

```bash
npm install
npm run typecheck
npm run build
```

## 许可证

MIT
