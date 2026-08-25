# oc-tg-plugin

[English](README.md) | **繁體中文** | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

[opencode](https://opencode.ai) 的 Telegram 私訊橋接外掛 — 移植自
[badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)。

把 Telegram 私訊變成 opencode session 的遙控介面：從手機送出指令、即時串流回覆、雙向傳檔。

## 功能

- **配對** — 第一個私訊機器人的 Telegram 使用者即成為唯一授權使用者
- **轉發** — Telegram 訊息會以 `[telegram]` 前綴送進最近使用的 opencode session
- **串流預覽** — 模型生成時即時編輯訊息（有節流，並依 Telegram 4096 字元上限切分）
- **附件接收** — 照片、文件、語音、影片、貼圖會下載到本地再交給模型（圖片內嵌 + 文字附暫存路徑）；媒體群組會合併去抖
- **附件回傳** — 模型可呼叫 `telegram_attach` 工具，把檔案隨最終回覆傳回（照片以照片傳送，其他以文件傳送）
- **佇列** — opencode 忙碌時收到的訊息會排隊等候
- **指令** — `/help`、`/start`、`/status`、`stop`（中止目前回合）

## 安裝設定

1. 到 [@BotFather](https://t.me/BotFather) 建立機器人並複製 token。
2. 啟用外掛並提供 token（擇一即可）：
   - 在環境變數設定 `TELEGRAM_BOT_TOKEN`，**或**
   - 建立 `~/.config/opencode/telegram.json`：

   ```json
   {
     "botToken": "123456:AA...",
     "botUsername": "yourbot",
     "botId": 123456
   }
   ```

3. 在 `opencode.json` 加入外掛：

   ```json
   {
     "plugin": ["oc-tg-plugin"]
   }
   ```

   本地開發可直接指向原始檔：

   ```json
   {
     "plugin": ["/absolute/path/to/oc-tg-plugin/src/index.ts"]
   }
   ```

4. 重啟 opencode。只要有 token，輪詢會自動啟動。
5. 在 Telegram 私訊你的機器人並傳送 `/start` 來配對帳號。

## 使用方式

直接私訊機器人。訊息會送進目前使用的 opencode session，回覆則傳回 Telegram。opencode 工作中時，後續訊息會排入佇列。

| 指令      | 效果                     |
| --------- | ------------------------ |
| `/start`  | 配對帳號 / 顯示說明      |
| `/help`   | 顯示說明                 |
| `/status` | 機器人、session、佇列狀態 |
| `stop`    | 中止目前回合             |

## 注意事項與邊界

- 互動式 TUI 工具（選項選擇器、權限對話框）在 Telegram 上看不到；模型會被引導改用純文字編號選項提問。
- 每個 bot token 同時只能有一個輪詢者：多個 opencode 執行個體會爭搶 `getUpdates`（輸家會被 Telegram 409 拒絕）。
- 設定與狀態存放在 `~/.config/opencode/telegram.json`（`lastUpdateId`、`allowedUserId` 會自動管理）。
- 本專案從 pi 的擴充 API 移植到 opencode 的外掛 API（`event` 匯流排 + `client.session.promptAsync`）；pi 的草稿串流 API 在 Telegram 沒有對應機制，因此預覽改用 `sendMessage` + `editMessageText`。

## 開發

```bash
npm install
npm run typecheck
npm run build
```

## 授權條款

MIT
