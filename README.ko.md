# oc-tg-plugin

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | **한국어**

[opencode](https://opencode.ai)용 Telegram DM 브리지 플러그인 —
[badlogic/pi-telegram](https://github.com/badlogic/pi-telegram)에서 포팅했습니다.

Telegram 개인 채팅을 opencode 세션의 원격 조종 인터페이스로 바꿔 줍니다: 휴대폰에서 프롬프트를 보내고, 응답을 실시간 스트리밍으로 받고, 파일도 양방향으로 주고받을 수 있습니다.

## 기능

- **페어링** — 봇에게 가장 먼저 DM을 보낸 Telegram 사용자가 유일한 허용 사용자가 됩니다
- **전달** — Telegram 메시지는 `[telegram]` 접두사와 함께 가장 최근에 활성화된 opencode 세션으로 전송됩니다
- **스트리밍 미리보기** — 모델이 생성하는 동안 메시지를 실시간으로 편집합니다(스로틀링 적용, Telegram 4096자 제한에 맞춰 분할)
- **첨부 파일 수신** — 사진, 문서, 음성, 동영상, 스티커는 로컬에 다운로드되어 모델에 전달됩니다(이미지는 인라인 + 텍스트에 임시 경로). 미디어 그룹은 디바운스로 묶습니다
- **첨부 파일 발신** — 모델이 `telegram_attach` 도구를 호출하여 최종 응답과 함께 파일을 보낼 수 있습니다(사진은 사진으로, 나머지는 문서로 전송)
- **대기열** — opencode가 작업 중일 때 도착한 메시지는 순서대로 대기합니다
- **명령어** — `/help`, `/start`, `/status`, `stop`(현재 턴 중단)

## 설정

1. [@BotFather](https://t.me/BotFather)에서 봇을 만들고 토큰을 복사합니다.
2. 플러그인을 활성화하고 토큰을 설정합니다(둘 중 하나만):
   - 환경 변수 `TELEGRAM_BOT_TOKEN` 설정, **또는**
   - `~/.config/opencode/telegram.json` 생성:

   ```json
   {
     "botToken": "123456:AA...",
     "botUsername": "yourbot",
     "botId": 123456
   }
   ```

3. `opencode.json`에 플러그인을 추가합니다:

   ```json
   {
     "plugin": ["oc-tg-plugin"]
   }
   ```

   로컬 개발 시에는 소스 파일을 직접 가리킬 수 있습니다:

   ```json
   {
     "plugin": ["/absolute/path/to/oc-tg-plugin/src/index.ts"]
   }
   ```

4. opencode를 재시작합니다. 토큰이 있으면 폴링이 자동으로 시작됩니다.
5. Telegram에서 봇에게 `/start`를 보내 계정을 페어링합니다.

## 사용법

봇에게 DM을 보내면 됩니다. 메시지는 활성 opencode 세션으로 전달되고, 응답은 Telegram으로 돌아옵니다. opencode가 작업 중일 때 온 메시지는 대기열에 추가됩니다.

| 명령어      | 효과                                                   |
| ----------- | ------------------------------------------------------ |
| `/start`    | 계정 페어링 / 도움말 표시                              |
| `/help`     | 도움말 표시                                            |
| `/new`      | 새 세션을 시작하고 전환                                |
| `/sessions` | 최근 세션 목록                                         |
| `/switch <n\|id>` | 대상 세션 전환(`/sessions`의 번호)               |
| `/model`    | 모델 오버라이드 표시(`/model <provider/id>` 설정, `clear` 해제) |
| `/compact`  | 세션 요약·압축                                         |
| `/share`    | 세션 공유 후 URL 받기                                  |
| `/status`   | 봇, 세션, 대기열 상태                                  |
| `stop`      | 현재 턴 중단                                           |

## 참고 사항 및 경계

- 대화형 TUI 도구(질문 선택기, 권한 대화상자)는 Telegram에서 보이지 않습니다. 모델은 번호가 매겨진 일반 텍스트 선택지로 질문하도록 안내됩니다.
- 봇 토큰당 폴러는 하나만 가능합니다: 여러 opencode 인스턴스가 `getUpdates`를 두고 경쟁합니다(진 쪽은 Telegram이 409로 거부합니다).
- 설정과 상태는 `~/.config/opencode/telegram.json`에 저장됩니다(`lastUpdateId`, `allowedUserId`는 자동 관리).
- pi의 확장 API에서 opencode의 플러그인 API(`event` 버스 + `client.session.promptAsync`)로 포팅되었습니다. pi의 초안 스트리밍 API에 해당하는 Telegram 기능이 없어 미리보기는 `sendMessage` + `editMessageText`를 사용합니다.

## 개발

```bash
npm install
npm run typecheck
npm run build
```

## 라이선스

MIT
