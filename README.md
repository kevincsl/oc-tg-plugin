# oc-tg-plugin

**English** | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md)

Telegram DM bridge plugin for [opencode](https://opencode.ai) — ported from
[badlogic/pi-telegram](https://github.com/badlogic/pi-telegram).

Turn a private Telegram DM into a remote surface for your opencode sessions:
prompts in from your phone, streamed replies back out, files both ways.

## Features

- **Pairing** — first Telegram user to DM the bot becomes the only allowed user
- **Forwarding** — Telegram messages are sent into your most recently active
  opencode session as `[telegram]` prompts
- **Streaming previews** — replies are edited live while the model generates
  (throttled, split at Telegram's 4096-char limit)
- **Attachments in** — photos, documents, voice, video, stickers are downloaded
  locally and passed to the model (images inline + temp paths in text);
  media groups are debounced
- **Attachments out** — the model can call the `telegram_attach` tool to send
  files back with its final reply (photos sent as photos, everything else as
  documents)
- **Queueing** — messages sent while opencode is busy are queued
- **Commands** — `/help`, `/start`, `/status`, `stop` (aborts the current turn)

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Enable the plugin and give it the token (either way works):
   - set `TELEGRAM_BOT_TOKEN` in your environment, **or**
   - create `~/.config/opencode/telegram.json`:

   ```json
   {
     "botToken": "123456:AA...",
     "botUsername": "yourbot",
     "botId": 123456
   }
   ```

3. Add the plugin to `opencode.json`:

   ```json
   {
     "plugin": ["oc-tg-plugin"]
   }
   ```

   Or for local development, point at the source file:

   ```json
   {
     "plugin": ["/absolute/path/to/oc-tg-plugin/src/index.ts"]
   }
   ```

4. Restart opencode. Polling starts automatically when a token is present.
5. Send `/start` to your bot in Telegram to pair your account.

## Usage

DM your bot. Messages land in the active opencode session; replies come back
to Telegram. While opencode is working, further messages are queued.

| Command   | Effect                                                       |
| --------- | ------------------------------------------------------------ |
| `/start`  | Pair account / show help                                     |
| `/help`   | Show help                                                    |
| `/new`    | Start a new session and target it                            |
| `/sessions` | List recent sessions                                       |
| `/switch <n\|id>` | Switch the target session (number from `/sessions`)  |
| `/model`  | Show model override (`/model <provider/id>` set, `clear` reset) |
| `/compact`| Summarize/compact the session                                |
| `/share`  | Share the session and get a URL                              |
| `/status` | Bot, session, queue status                                   |
| `stop`    | Abort the current turn                                       |

## Notes & boundaries

- Interactive TUI tools (question pickers, permission dialogs) are not visible
  on Telegram; the model is instructed to ask with numbered plain-text options
  instead.
- One poller per bot token: running multiple opencode instances makes them
  compete for `getUpdates` (Telegram 409s the loser).
- Config/state live in `~/.config/opencode/telegram.json`
  (`lastUpdateId`, `allowedUserId` are managed automatically).
- Ported from pi's extension API to opencode's plugin API
  (`event` bus + `client.session.promptAsync`); the pi draft-streaming API has
  no Telegram equivalent here, so previews use `sendMessage` + `editMessageText`.

## Development

```bash
npm install
npm run typecheck
npm run build
```

## License

MIT
