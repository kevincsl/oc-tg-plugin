# oc-tg-plugin

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **日本語** | [한국어](README.ko.md)

[opencode](https://opencode.ai) 用の Telegram DM ブリッジプラグイン —
[badlogic/pi-telegram](https://github.com/badlogic/pi-telegram) から移植。

Telegram の個別チャットを opencode セッションのリモート操作画面に変えます：スマホからプロンプトを送り、応答をリアルタイムストリーミングで受信、ファイルも双方向で送受信できます。

## 機能

- **ペアリング** — bot に最初に DM を送った Telegram ユーザーが、唯一の許可ユーザーになります
- **転送** — Telegram のメッセージは `[telegram]` プレフィックス付きで、最近アクティブな opencode セッションに送られます
- **ストリーミングプレビュー** — モデルの生成中にメッセージをライブ編集（スロットリング付き、Telegram の 4096 文字制限で分割）
- **受信添付** — 写真・ドキュメント・音声・動画・スタンプはローカルにダウンロードしてモデルに渡します（画像はインライン＋テキストに一時パス）。メディアグループはデバウンスでまとめます
- **送信添付** — モデルは `telegram_attach` ツールを呼び出して、最終応答と一緒にファイルを送り返せます（写真は写真として、それ以外はドキュメントとして送信）
- **キューイング** — opencode の処理中に届いたメッセージは順番に待機します
- **コマンド** — `/help`、`/start`、`/status`、`stop`（現在のターンを中断）

## セットアップ

1. [@BotFather](https://t.me/BotFather) で bot を作成し、トークンをコピーします。
2. プラグインを有効化してトークンを設定します（どちらか一方で OK）：
   - 環境変数 `TELEGRAM_BOT_TOKEN` を設定、**または**
   - `~/.config/opencode/telegram.json` を作成：

   ```json
   {
     "botToken": "123456:AA...",
     "botUsername": "yourbot",
     "botId": 123456
   }
   ```

3. `opencode.json` にプラグインを追加：

   ```json
   {
     "plugin": ["oc-tg-plugin"]
   }
   ```

   ローカル開発ではソースファイルを直接指定できます：

   ```json
   {
     "plugin": ["/absolute/path/to/oc-tg-plugin/src/index.ts"]
   }
   ```

4. opencode を再起動します。トークンがあればポーリングは自動で始まります。
5. Telegram であなたの bot に `/start` を送ってアカウントをペアリングします。

## 使い方

bot に DM を送るだけです。メッセージはアクティブな opencode セッションに届き、応答は Telegram に返ってきます。opencode の処理中に届いたメッセージはキューに入ります。

| コマンド  | 効果                                                       |
| --------- | ---------------------------------------------------------- |
| `/start`  | アカウントのペアリング / ヘルプ表示                        |
| `/help`   | ヘルプ表示                                                 |
| `/new`    | 新しいセッションを開始して切り替え                         |
| `/sessions` | 最近のセッション一覧                                     |
| `/switch <n\|id>` | 対象セッションを切り替え（`/sessions` の番号）      |
| `/model`  | モデル上書き表示（`/model <provider/id>` で設定、`clear` で解除） |
| `/compact`| セッションを要約・圧縮                                     |
| `/share`  | セッションを共有して URL を取得                            |
| `/status` | bot・セッション・キューの状態                              |
| `stop`    | 現在のターンを中断                                         |

## 注意事項と境界

- 対話型 TUI ツール（質問ピッカー、権限ダイアログ）は Telegram には表示されません。モデルは、番号付きの平文選択肢で質問するよう誘導されます。
- bot トークンごとにポーラーは 1 つだけ：複数の opencode インスタンスは `getUpdates` を取り合います（負けた側は Telegram に 409 で拒否されます）。
- 設定と状態は `~/.config/opencode/telegram.json` に保存されます（`lastUpdateId`、`allowedUserId` は自動管理）。
- pi の拡張 API から opencode のプラグイン API（`event` バス + `client.session.promptAsync`）へ移植しました。pi のドラフトストリーミング API に相当する Telegram 機能がないため、プレビューは `sendMessage` + `editMessageText` を使用します。

## 開発

```bash
npm install
npm run typecheck
npm run build
```

## ライセンス

MIT
