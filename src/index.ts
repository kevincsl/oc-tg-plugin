// Ported from badlogic/pi-telegram (core bridge) into an opencode plugin.
// Bridges a private Telegram DM to the active opencode session:
// prompts in, streamed previews out, file attachments both ways.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { homedir } from "node:os"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"

interface TelegramConfig {
  botToken?: string
  botUsername?: string
  botId?: number
  allowedUserId?: number
  lastUpdateId?: number
}

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
}

interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

interface TelegramChat {
  id: number
  type: string
}

interface TelegramPhotoSize {
  file_id: string
  file_size?: number
}

interface TelegramDocument {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

interface TelegramVideo {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

interface TelegramAudio {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

interface TelegramVoice {
  file_id: string
  mime_type?: string
  file_size?: number
}

interface TelegramAnimation {
  file_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

interface TelegramSticker {
  file_id: string
  emoji?: string
}

interface TelegramFileInfo {
  file_id: string
  fileName: string
  mimeType?: string
  isImage: boolean
}

interface TelegramMessage {
  message_id: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  caption?: string
  media_group_id?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  video?: TelegramVideo
  audio?: TelegramAudio
  voice?: TelegramVoice
  animation?: TelegramAnimation
  sticker?: TelegramSticker
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  data?: string
  message?: TelegramMessage
}

interface TelegramGetFileResult {
  file_path: string
}

interface TelegramSentMessage {
  message_id: number
}

interface DownloadedTelegramFile {
  path: string
  fileName: string
  isImage: boolean
  mimeType?: string
}

interface PendingTelegramTurn {
  chatId: number
  replyToMessageId: number
  queuedAttachments: QueuedAttachment[]
  promptText: string
  images: Array<{ data: string; mimeType: string; fileName: string }>
  historyText: string
}

interface QueuedAttachment {
  path: string
  fileName: string
}

interface PreviewState {
  messageId?: number
  pendingText: string
  lastSentText: string
  flushTimer?: ReturnType<typeof setTimeout>
}

interface MediaGroupState {
  messages: TelegramMessage[]
  flushTimer?: ReturnType<typeof setTimeout>
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "telegram.json")
const TEMP_DIR = join(homedir(), ".config", "opencode", "tmp", "telegram")
const TELEGRAM_PREFIX = "[telegram]"
const MAX_MESSAGE_LENGTH = 4096
const MAX_ATTACHMENTS_PER_TURN = 10
const PREVIEW_THROTTLE_MS = 750
const MEDIA_GROUP_DEBOUNCE_MS = 1200

const SYSTEM_PROMPT_SUFFIX = `

Telegram bridge plugin is active.
- Messages forwarded from Telegram are prefixed with "[telegram]".
- [telegram] messages may include local temp file paths for Telegram attachments. Read those files as needed.
- If the [telegram] user asked for a file or generated artifact, call the telegram_attach tool with the local file path so it is sent with your final reply. Mentioning a path in plain text does NOT send it to Telegram.
- Interactive TUI tools (question pickers) are NOT visible on Telegram. When the [telegram] user must choose something, ask in plain text with numbered options (e.g. "1) ... 2) ...") and let them reply with a number.`

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_")
}

function guessExtensionFromMime(mimeType: string | undefined, fallback: string): string {
  if (!mimeType) return fallback
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "audio/ogg": ".ogg",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
    "application/pdf": ".pdf",
  }
  return map[mimeType.toLowerCase()] ?? fallback
}

function guessMediaType(path: string): string | undefined {
  const map: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
  }
  return map[extname(path).toLowerCase()]
}

function isImageMimeType(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase().startsWith("image/") ?? false
}

function chunkParagraphs(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text]

  const normalized = text.replace(/\r\n/g, "\n")
  const paragraphs = normalized.split(/\n\n+/)
  const chunks: string[] = []
  let current = ""

  const flushCurrent = (): void => {
    if (current.trim().length > 0) chunks.push(current)
    current = ""
  }

  const splitLongBlock = (block: string): string[] => {
    if (block.length <= MAX_MESSAGE_LENGTH) return [block]
    const lineChunks: string[] = []
    let lineCurrent = ""
    for (const line of block.split("\n")) {
      const candidate = lineCurrent.length === 0 ? line : `${lineCurrent}\n${line}`
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        lineCurrent = candidate
        continue
      }
      if (lineCurrent.length > 0) {
        lineChunks.push(lineCurrent)
        lineCurrent = ""
      }
      if (line.length <= MAX_MESSAGE_LENGTH) {
        lineCurrent = line
        continue
      }
      for (let i = 0; i < line.length; i += MAX_MESSAGE_LENGTH) {
        lineChunks.push(line.slice(i, i + MAX_MESSAGE_LENGTH))
      }
    }
    if (lineCurrent.length > 0) lineChunks.push(lineCurrent)
    return lineChunks
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue
    for (const part of splitLongBlock(paragraph)) {
      const candidate = current.length === 0 ? part : `${current}\n\n${part}`
      if (candidate.length <= MAX_MESSAGE_LENGTH) {
        current = candidate
      } else {
        flushCurrent()
        current = part
      }
    }
  }
  flushCurrent()
  return chunks
}

async function readConfig(): Promise<TelegramConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, "utf8")) as TelegramConfig
  } catch {
    return {}
  }
}

async function writeConfig(config: TelegramConfig): Promise<void> {
  await mkdir(join(homedir(), ".config", "opencode"), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8")
}

export const TelegramPlugin: Plugin = async ({ client }) => {
  let config = await readConfig()
  if (!config.botToken && process.env.TELEGRAM_BOT_TOKEN) {
    config.botToken = process.env.TELEGRAM_BOT_TOKEN.trim()
  }

  let pollingController: AbortController | undefined
  let pollingPromise: Promise<void> | undefined
  let queuedTurns: PendingTelegramTurn[] = []
  let activeTurn: PendingTelegramTurn | undefined
  // Session we forward Telegram prompts into: whatever session in this
  // instance showed activity most recently.
  let sessionId: string | undefined
  // Telegram-side overrides for TUI-native controls.
  let modelOverride: string | undefined
  let listedSessions: Array<{ id: string; title: string }> = []
  let modelList: string[] = []
  let modelPage = 0
  let busyFromTelegram = false
  let typingInterval: ReturnType<typeof setInterval> | undefined
  let previewState: PreviewState | undefined
  let preserveQueuedAsHistory = false
  const mediaGroups = new Map<string, MediaGroupState>()
  const messageRoles = new Map<string, string>()
  const partTexts = new Map<string, Map<string, string>>()
  let lastAssistantMessageId: string | undefined

  function log(message: string, error?: unknown): void {
    const suffix = error instanceof Error ? ` (${error.message})` : ""
    void client.app
      .log({
        body: {
          level: error ? "error" : "info",
          service: "telegram",
          message: message + suffix,
          extra: {},
        },
      })
      .catch(() => undefined)
  }

  async function callTelegram<TResponse>(
    method: string,
    body: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<TResponse> {
    if (!config.botToken) throw new Error("Telegram bot token is not configured")
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    })
    const data = (await response.json()) as TelegramApiResponse<TResponse>
    if (!data.ok || data.result === undefined) {
      throw new Error(data.description || `Telegram API ${method} failed`)
    }
    return data.result
  }

  async function callTelegramMultipart<TResponse>(
    method: string,
    fields: Record<string, string>,
    fileField: string,
    filePath: string,
    fileName: string,
  ): Promise<TResponse> {
    if (!config.botToken) throw new Error("Telegram bot token is not configured")
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.set(key, value)
    form.set(fileField, new Blob([await readFile(filePath)]), fileName)
    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
      method: "POST",
      body: form,
    })
    const data = (await response.json()) as TelegramApiResponse<TResponse>
    if (!data.ok || data.result === undefined) {
      throw new Error(data.description || `Telegram API ${method} failed`)
    }
    return data.result
  }

  async function downloadTelegramFile(fileId: string, suggestedName: string): Promise<string> {
    if (!config.botToken) throw new Error("Telegram bot token is not configured")
    const file = await callTelegram<TelegramGetFileResult>("getFile", { file_id: fileId })
    await mkdir(TEMP_DIR, { recursive: true })
    const targetPath = join(TEMP_DIR, `${Date.now()}-${sanitizeFileName(suggestedName)}`)
    const response = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`)
    if (!response.ok) throw new Error(`Failed to download Telegram file: ${response.status}`)
    await writeFile(targetPath, Buffer.from(await response.arrayBuffer()))
    return targetPath
  }

  function startTypingLoop(chatId?: number): void {
    const targetChatId = chatId ?? activeTurn?.chatId
    if (typingInterval || targetChatId === undefined) return
    const sendTyping = async (): Promise<void> => {
      try {
        await callTelegram("sendChatAction", { chat_id: targetChatId, action: "typing" })
      } catch (error) {
        log("typing indicator failed", error)
      }
    }
    void sendTyping()
    typingInterval = setInterval(() => void sendTyping(), 4000)
  }

  function stopTypingLoop(): void {
    if (!typingInterval) return
    clearInterval(typingInterval)
    typingInterval = undefined
  }

  async function flushPreview(chatId: number): Promise<void> {
    const state = previewState
    if (!state) return
    state.flushTimer = undefined
    const text = state.pendingText.trim()
    if (!text || text === state.lastSentText) return
    const truncated = text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text
    try {
      if (state.messageId === undefined) {
        const sent = await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text: truncated })
        state.messageId = sent.message_id
      } else {
        await callTelegram("editMessageText", { chat_id: chatId, message_id: state.messageId, text: truncated })
      }
      state.lastSentText = truncated
    } catch (error) {
      log("preview flush failed", error)
    }
  }

  function schedulePreviewFlush(chatId: number): void {
    if (!previewState || previewState.flushTimer) return
    previewState.flushTimer = setTimeout(() => void flushPreview(chatId), PREVIEW_THROTTLE_MS)
  }

  async function clearPreview(): Promise<void> {
    const state = previewState
    if (!state) return
    if (state.flushTimer) clearTimeout(state.flushTimer)
    previewState = undefined
  }

  interface InlineButton {
    text: string
    callback_data: string
  }

  const MODELS_PER_PAGE = 20

  function buildModelPageButtons(page: number): { text: string; buttons: InlineButton[][] } {
    const totalPages = Math.max(1, Math.ceil(modelList.length / MODELS_PER_PAGE))
    const current = Math.min(Math.max(page, 0), totalPages - 1)
    const slice = modelList.slice(current * MODELS_PER_PAGE, (current + 1) * MODELS_PER_PAGE)
    const buttons: InlineButton[][] = slice.map((full) => [
      { text: `${full === modelOverride ? "✓ " : ""}${full}`.slice(0, 60), callback_data: `model:${full}`.slice(0, 64) },
    ])
    if (totalPages > 1) {
      buttons.push([
        { text: "◀ Prev", callback_data: `modelpage:${current - 1}` },
        { text: `${current + 1}/${totalPages}`, callback_data: "modelpage:noop" },
        { text: "Next ▶", callback_data: `modelpage:${current + 1}` },
      ])
    }
    const header = `Models (custom providers first) — page ${current + 1}/${totalPages}\nOverride: ${modelOverride ?? "none (session default)"}`
    return { text: header, buttons }
  }

  async function sendModelPage(chatId: number, editMessageId?: number): Promise<void> {
    const { text, buttons } = buildModelPageButtons(modelPage)
    try {
      if (editMessageId) {
        await callTelegram("editMessageText", { chat_id: chatId, message_id: editMessageId, text, reply_markup: { inline_keyboard: buttons } })
      } else {
        await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: chatId, text, reply_markup: { inline_keyboard: buttons } })
      }
    } catch (error) {
      log("failed to send model page", error)
    }
  }

  async function sendTextReply(chatId: number, text: string, buttons?: InlineButton[][]): Promise<void> {
    const chunks = chunkParagraphs(text)
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { chat_id: chatId, text: chunks[i] }
      if (buttons && i === chunks.length - 1) body.reply_markup = { inline_keyboard: buttons }
      try {
        await callTelegram<TelegramSentMessage>("sendMessage", body)
      } catch (error) {
        log("failed to send Telegram reply", error)
      }
    }
  }

  async function sendQueuedAttachments(turn: PendingTelegramTurn): Promise<void> {
    for (const attachment of turn.queuedAttachments) {
      try {
        const mediaType = guessMediaType(attachment.path)
        await callTelegramMultipart<TelegramSentMessage>(
          mediaType ? "sendPhoto" : "sendDocument",
          { chat_id: String(turn.chatId) },
          mediaType ? "photo" : "document",
          attachment.path,
          attachment.fileName,
        )
      } catch (error) {
        await sendTextReply(turn.chatId, `Failed to send attachment ${attachment.fileName}: ${error instanceof Error ? error.message : error}`)
      }
    }
  }

  function collectTelegramFileInfos(messages: TelegramMessage[]): TelegramFileInfo[] {
    const files: TelegramFileInfo[] = []
    for (const message of messages) {
      if (Array.isArray(message.photo) && message.photo.length > 0) {
        const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop()
        if (photo) {
          files.push({ file_id: photo.file_id, fileName: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", isImage: true })
        }
      }
      if (message.document) {
        files.push({
          file_id: message.document.file_id,
          fileName: message.document.file_name || `document-${message.message_id}${guessExtensionFromMime(message.document.mime_type, "")}`,
          mimeType: message.document.mime_type,
          isImage: isImageMimeType(message.document.mime_type),
        })
      }
      if (message.video) {
        files.push({
          file_id: message.video.file_id,
          fileName: message.video.file_name || `video-${message.message_id}${guessExtensionFromMime(message.video.mime_type, ".mp4")}`,
          mimeType: message.video.mime_type,
          isImage: false,
        })
      }
      if (message.audio) {
        files.push({
          file_id: message.audio.file_id,
          fileName: message.audio.file_name || `audio-${message.message_id}${guessExtensionFromMime(message.audio.mime_type, ".mp3")}`,
          mimeType: message.audio.mime_type,
          isImage: false,
        })
      }
      if (message.voice) {
        files.push({
          file_id: message.voice.file_id,
          fileName: `voice-${message.message_id}${guessExtensionFromMime(message.voice.mime_type, ".ogg")}`,
          mimeType: message.voice.mime_type,
          isImage: false,
        })
      }
      if (message.animation) {
        files.push({
          file_id: message.animation.file_id,
          fileName: message.animation.file_name || `animation-${message.message_id}${guessExtensionFromMime(message.animation.mime_type, ".mp4")}`,
          mimeType: message.animation.mime_type,
          isImage: false,
        })
      }
      if (message.sticker) {
        files.push({ file_id: message.sticker.file_id, fileName: `sticker-${message.message_id}.webp`, mimeType: "image/webp", isImage: true })
      }
    }
    return files
  }

  function formatTelegramHistoryText(rawText: string, files: DownloadedTelegramFile[]): string {
    let summary = rawText.length > 0 ? rawText : "(no text)"
    if (files.length > 0) {
      summary += "\nAttachments:"
      for (const file of files) summary += `\n- ${file.path}`
    }
    return summary
  }

  async function createTelegramTurn(messages: TelegramMessage[], historyTurns: PendingTelegramTurn[] = []): Promise<PendingTelegramTurn> {
    const firstMessage = messages[0]
    if (!firstMessage) throw new Error("Missing Telegram message for turn creation")
    const rawText = messages.map((m) => (m.text || m.caption || "").trim()).filter(Boolean).join("\n\n")
    const downloaded: DownloadedTelegramFile[] = []
    for (const file of collectTelegramFileInfos(messages)) {
      try {
        const path = await downloadTelegramFile(file.file_id, file.fileName)
        downloaded.push({ path, fileName: file.fileName, isImage: file.isImage, mimeType: file.mimeType })
      } catch (error) {
        log(`failed to download ${file.fileName}`, error)
      }
    }

    let prompt = `${TELEGRAM_PREFIX} ${rawText || "(media only)"}`
    if (historyTurns.length > 0) {
      prompt = `${TELEGRAM_PREFIX} Earlier Telegram messages arrived after an aborted turn. Treat them as prior user messages, in order:`
      for (const [index, turn] of historyTurns.entries()) {
        prompt += `\n\n${index + 1}. ${turn.historyText}`
      }
      prompt += `\n\nCurrent Telegram message:\n${rawText || "(media only)"}`
    }
    if (downloaded.length > 0) {
      prompt += "\n\nTelegram attachments were saved locally:"
      for (const file of downloaded) prompt += `\n- ${file.path}`
    }

    const images: Array<{ data: string; mimeType: string; fileName: string }> = []
    for (const file of downloaded) {
      if (!file.isImage) continue
      const mediaType = file.mimeType || guessMediaType(file.path)
      if (!mediaType) continue
      images.push({ data: (await readFile(file.path)).toString("base64"), mimeType: mediaType, fileName: file.fileName })
    }

    return {
      chatId: firstMessage.chat.id,
      replyToMessageId: firstMessage.message_id,
      queuedAttachments: [],
      promptText: prompt,
      images,
      historyText: formatTelegramHistoryText(rawText, downloaded),
    }
  }

  async function dispatchTurn(turn: PendingTelegramTurn): Promise<void> {
    if (!sessionId) {
      await sendTextReply(turn.chatId, "No active opencode session yet. Open opencode and send a message first, then try again.")
      return
    }
    activeTurn = turn
    busyFromTelegram = true
    previewState = { pendingText: "", lastSentText: "" }
    startTypingLoop(turn.chatId)
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: turn.promptText }]
    for (const image of turn.images) {
      parts.push({ type: "file", mime: image.mimeType, filename: image.fileName, url: `data:${image.mimeType};base64,${image.data}` })
    }
    const body: Record<string, unknown> = { parts }
    if (modelOverride) {
      const slash = modelOverride.indexOf("/")
      if (slash > 0) {
        body.model = { providerID: modelOverride.slice(0, slash), modelID: modelOverride.slice(slash + 1) }
      }
    }
    try {
      const result = await client.session.promptAsync({ path: { id: sessionId }, body: body as never })
      if (result.error) throw new Error(String(result.error))
    } catch (error) {
      busyFromTelegram = false
      stopTypingLoop()
      await clearPreview()
      activeTurn = undefined
      log("prompt dispatch failed", error)
      await sendTextReply(turn.chatId, `Failed to forward message to opencode: ${error instanceof Error ? error.message : error}`)
    }
  }

  async function finishActiveTurn(reason: "idle" | "aborted" | "error", errorText?: string): Promise<void> {
    const turn = activeTurn
    busyFromTelegram = false
    stopTypingLoop()
    activeTurn = undefined
    if (!turn) return

    let finalText: string | undefined
    if (lastAssistantMessageId) {
      const parts = partTexts.get(lastAssistantMessageId)
      if (parts && parts.size > 0) finalText = [...parts.values()].join("").trim() || undefined
    }
    await clearPreview()

    if (reason === "aborted") {
      await sendTextReply(turn.chatId, "Aborted current turn.")
    } else if (reason === "error") {
      await sendTextReply(turn.chatId, errorText || "opencode failed while processing the request.")
    } else if (finalText) {
      for (const chunk of chunkParagraphs(finalText)) {
        await callTelegram<TelegramSentMessage>("sendMessage", { chat_id: turn.chatId, text: chunk }).catch(() => undefined)
      }
    } else if (turn.queuedAttachments.length > 0) {
      await sendTextReply(turn.chatId, "Attached requested file(s).")
    }

    await sendQueuedAttachments(turn)

    if (queuedTurns.length > 0 && !preserveQueuedAsHistory) {
      const next = queuedTurns.shift()
      if (next) await dispatchTurn(next)
    }
  }

  async function dispatchAuthorizedMessages(messages: TelegramMessage[]): Promise<void> {
    const firstMessage = messages[0]
    if (!firstMessage) return
    const rawText = messages.map((m) => (m.text || m.caption || "").trim()).find((t) => t.length > 0) || ""
    const lower = rawText.toLowerCase()

    if (lower === "/help" || lower === "/start") {
      await sendTextReply(
        firstMessage.chat.id,
        `Send me a message and I will forward it to the active opencode session.
Commands:
/new - start a new session
/sessions - list recent sessions
/switch <n|id> - switch target session
/model - show model (/model <provider/id> to set, /model clear to reset)
/compact - summarize the session
/share - share session and get URL
/status - bridge status
stop - abort the current turn`,
      )
      if (config.allowedUserId === undefined && firstMessage.from) {
        config.allowedUserId = firstMessage.from.id
        await writeConfig(config)
        await sendTextReply(firstMessage.chat.id, "Telegram bridge paired with this account.")
      }
      return
    }

    if (lower === "/new") {
      try {
        const created = await client.session.create({})
        sessionId = (created.data as unknown as { id: string }).id
        modelOverride = undefined
        await sendTextReply(firstMessage.chat.id, `New session started: ${sessionId}`)
      } catch (error) {
        await sendTextReply(firstMessage.chat.id, `Failed to create session: ${error instanceof Error ? error.message : error}`)
      }
      return
    }

    if (lower === "/sessions") {
      try {
        const res = await client.session.list()
        const all = (res.data as unknown as Array<{ id: string; title?: string }>) ?? []
        listedSessions = all.slice(0, 10).map((s) => ({ id: s.id, title: s.title || "(untitled)" }))
        const lines = listedSessions.map((s, i) => {
          const marker = s.id === sessionId ? " ←" : ""
          return `${i + 1}. ${s.title}${marker}`
        })
        const buttons: InlineButton[][] = listedSessions.map((s, i) => [
          { text: `${i + 1}. ${s.title}`.slice(0, 60), callback_data: `switch:${s.id}` },
        ])
        await sendTextReply(firstMessage.chat.id, `Recent sessions — tap to switch:\n${lines.join("\n")}`, buttons)
      } catch (error) {
        await sendTextReply(firstMessage.chat.id, `Failed to list sessions: ${error instanceof Error ? error.message : error}`)
      }
      return
    }

    if (lower.startsWith("/switch")) {
      const arg = rawText.slice("/switch".length).trim()
      let target: string | undefined
      if (/^\d+$/.test(arg)) {
        const idx = Number(arg) - 1
        target = listedSessions[idx]?.id
      } else if (arg) {
        target = listedSessions.find((s) => s.id.startsWith(arg))?.id ?? (listedSessions.some((s) => s.id === arg) ? arg : undefined)
      }
      if (!target) {
        await sendTextReply(firstMessage.chat.id, `Usage: /switch <number from /sessions> or <session id prefix>`)
        return
      }
      sessionId = target
      const title = listedSessions.find((s) => s.id === target)?.title ?? ""
      await sendTextReply(firstMessage.chat.id, `Switched to: ${title} (${target})`)
      return
    }

    if (lower === "/model" || lower.startsWith("/model ")) {
      const arg = rawText.slice("/model".length).trim()
      if (arg.toLowerCase() === "clear") {
        modelOverride = undefined
        await sendTextReply(firstMessage.chat.id, "Model override cleared.")
        return
      }
      if (arg) {
        if (!arg.includes("/") || arg.startsWith("/") || arg.endsWith("/")) {
          await sendTextReply(firstMessage.chat.id, `Invalid model. Use <provider>/<model-id> or just /model for buttons`)
          return
        }
        modelOverride = arg
        await sendTextReply(firstMessage.chat.id, `Telegram model override set to ${arg}`)
        return
      }
      try {
        const res = await client.config.providers()
        const providers = (res.data as unknown as {
          providers?: Array<{ id: string; source?: string; models?: Record<string, unknown> }>
        }).providers ?? []
        const configured: string[] = []
        const builtin: string[] = []
        for (const provider of providers) {
          const isCustom = provider.source === "config" || provider.source === "custom" || provider.source === "env"
          for (const modelId of Object.keys(provider.models ?? {})) {
            const full = `${provider.id}/${modelId}`
            ;(isCustom ? configured : builtin).push(full)
          }
        }
        configured.sort()
        builtin.sort()
        modelList = [...configured, ...builtin]
        modelPage = 0
        await sendModelPage(firstMessage.chat.id)
      } catch (error) {
        await sendTextReply(firstMessage.chat.id, `Failed to list models: ${error instanceof Error ? error.message : error}`)
      }
      return
    }

    if (lower === "/compact") {
      if (busyFromTelegram || !sessionId) {
        await sendTextReply(firstMessage.chat.id, "Cannot compact now. Send stop first / no active session.")
        return
      }
      try {
        await client.session.summarize({ path: { id: sessionId } })
        await sendTextReply(firstMessage.chat.id, "Compaction started.")
      } catch (error) {
        await sendTextReply(firstMessage.chat.id, `Compaction failed: ${error instanceof Error ? error.message : error}`)
      }
      return
    }

    if (lower === "/share") {
      if (!sessionId) {
        await sendTextReply(firstMessage.chat.id, "No active session.")
        return
      }
      try {
        const res = await client.session.share({ path: { id: sessionId } })
        const share = (res.data as unknown as { share?: { url?: string }; shareUrl?: string }).share?.url
        await sendTextReply(firstMessage.chat.id, share ? `Shared: ${share}` : "Session shared (no URL returned).")
      } catch (error) {
        await sendTextReply(firstMessage.chat.id, `Share failed: ${error instanceof Error ? error.message : error}`)
      }
      return
    }

    if (lower === "stop" || lower === "/stop") {
      if (busyFromTelegram && sessionId) {
        if (queuedTurns.length > 0) preserveQueuedAsHistory = true
        try {
          await client.session.abort({ path: { id: sessionId } })
        } catch (error) {
          log("abort failed", error)
          await finishActiveTurn("aborted")
        }
      } else {
        await sendTextReply(firstMessage.chat.id, "No active turn.")
      }
      return
    }

    if (lower === "/status") {
      const status = [
        `bot: ${config.botUsername ? `@${config.botUsername}` : "not configured"}`,
        `polling: ${pollingPromise ? "running" : "stopped"}`,
        `session: ${sessionId ?? "none yet"}`,
        `busy: ${busyFromTelegram ? "yes" : "no"}`,
        `queued telegram turns: ${queuedTurns.length}`,
      ]
      await sendTextReply(firstMessage.chat.id, status.join("\n"))
      return
    }

    const historyTurns = preserveQueuedAsHistory ? queuedTurns.splice(0) : []
    preserveQueuedAsHistory = false
    const turn = await createTelegramTurn(messages, historyTurns)
    queuedTurns.push(turn)
    if (!busyFromTelegram) {
      queuedTurns.pop()
      await dispatchTurn(turn)
    }
  }

  async function handleMessage(message: TelegramMessage): Promise<void> {
    if (message.media_group_id) {
      const key = `${message.chat.id}:${message.media_group_id}`
      const existing = mediaGroups.get(key) ?? { messages: [] }
      existing.messages.push(message)
      if (existing.flushTimer) clearTimeout(existing.flushTimer)
      existing.flushTimer = setTimeout(() => {
        const state = mediaGroups.get(key)
        mediaGroups.delete(key)
        if (!state) return
        void dispatchAuthorizedMessages(state.messages)
      }, MEDIA_GROUP_DEBOUNCE_MS)
      mediaGroups.set(key, existing)
      return
    }
    await dispatchAuthorizedMessages([message])
  }

  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      const cq = update.callback_query
      if (!cq.from || cq.from.is_bot) return
      if (config.allowedUserId !== undefined && cq.from.id !== config.allowedUserId) {
        await callTelegram("answerCallbackQuery", { callback_query_id: cq.id, text: "Not authorized" }).catch(() => undefined)
        return
      }
      await callTelegram("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => undefined)
      const data = cq.data ?? ""
      if (data.startsWith("modelpage:")) {
        const arg = data.slice("modelpage:".length)
        if (arg !== "noop" && cq.message?.chat.id && cq.message.message_id) {
          const next = Number(arg)
          if (!Number.isNaN(next)) {
            modelPage = next
            await sendModelPage(cq.message.chat.id, cq.message.message_id)
          }
        }
        return
      }
      if (data.startsWith("model:")) {
        const model = data.slice("model:".length)
        modelOverride = model
        if (cq.message?.chat.id && cq.message.message_id) {
          const { text, buttons } = buildModelPageButtons(modelPage)
          await callTelegram("editMessageText", {
            chat_id: cq.message.chat.id,
            message_id: cq.message.message_id,
            text: `✓ Model override set to ${model}\n\n${text}`,
            reply_markup: { inline_keyboard: buttons },
          }).catch(() => undefined)
        }
        return
      }
      if (data.startsWith("switch:")) {
        const target = data.slice("switch:".length)
        sessionId = target
        const title = listedSessions.find((s) => s.id === target)?.title ?? ""
        if (cq.message?.chat.id) {
          await sendTextReply(cq.message.chat.id, `Switched to: ${title} (${target})`)
        }
        return
      }
      return
    }

    const message = update.message || update.edited_message
    if (!message || message.chat.type !== "private" || !message.from || message.from.is_bot) return

    if (config.allowedUserId === undefined) {
      config.allowedUserId = message.from.id
      await writeConfig(config)
      await sendTextReply(message.chat.id, "Telegram bridge paired with this account.")
    }

    if (message.from.id !== config.allowedUserId) {
      await sendTextReply(message.chat.id, "This bot is not authorized for your account.")
      return
    }

    await handleMessage(message)
  }

  async function pollLoop(signal: AbortSignal): Promise<void> {
    if (!config.botToken) return
    try {
      await callTelegram("deleteWebhook", { drop_pending_updates: false }, { signal })
    } catch {
      // ignore
    }

    if (config.lastUpdateId === undefined) {
      try {
        const updates = await callTelegram<TelegramUpdate[]>("getUpdates", { offset: -1, limit: 1, timeout: 0 }, { signal })
        const last = updates.at(-1)
        if (last) {
          config.lastUpdateId = last.update_id
          await writeConfig(config)
        }
      } catch {
        // ignore
      }
    }

    while (!signal.aborted) {
      try {
        const updates = await callTelegram<TelegramUpdate[]>(
          "getUpdates",
          {
            offset: config.lastUpdateId !== undefined ? config.lastUpdateId + 1 : undefined,
            limit: 10,
            timeout: 30,
            allowed_updates: ["message", "edited_message", "callback_query"],
          },
          { signal },
        )
        for (const update of updates) {
          config.lastUpdateId = update.update_id
          await writeConfig(config)
          await handleUpdate(update)
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof DOMException && error.name === "AbortError") return
        log("poll loop error, retrying in 3s", error)
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }
  }

  function startPolling(): void {
    if (!config.botToken || pollingPromise) return
    pollingController = new AbortController()
    pollingPromise = pollLoop(pollingController.signal).finally(() => {
      pollingPromise = undefined
      pollingController = undefined
    })
  }

  // Auto-connect when a token is available.
  if (config.botToken) {
    await mkdir(TEMP_DIR, { recursive: true })
    startPolling()
  }

  return {
    dispose: async () => {
      pollingController?.abort()
      pollingController = undefined
      stopTypingLoop()
      await clearPreview()
    },

    tool: {
      telegram_attach: tool({
        description:
          "Queue one or more local files to be sent to the Telegram user with the next reply. Only use this while handling a [telegram] request.",
        args: {
          paths: tool.schema.array(tool.schema.string().describe("Local file path to attach")).describe(`Files to attach (max ${MAX_ATTACHMENTS_PER_TURN})`),
        },
        execute: async (args) => {
          if (!activeTurn) {
            throw new Error("telegram_attach can only be used while replying to an active Telegram turn")
          }
          const added: string[] = []
          for (const inputPath of args.paths) {
            const stats = await stat(inputPath)
            if (!stats.isFile()) throw new Error(`Not a file: ${inputPath}`)
            if (activeTurn.queuedAttachments.length >= MAX_ATTACHMENTS_PER_TURN) {
              throw new Error(`Attachment limit reached (${MAX_ATTACHMENTS_PER_TURN})`)
            }
            activeTurn.queuedAttachments.push({ path: inputPath, fileName: basename(inputPath) })
            added.push(inputPath)
          }
          return {
            title: "telegram_attach",
            output: `Queued ${added.length} Telegram attachment(s):\n${added.join("\n")}`,
          }
        },
      }),
    },

    "chat.message": async (input) => {
      sessionId = input.sessionID
    },

    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(SYSTEM_PROMPT_SUFFIX)
    },

    event: async ({ event }) => {
      switch (event.type) {
        case "message.updated": {
          const info = event.properties.info as { id?: string; sessionID?: string; role?: string }
          if (!info.id || !info.sessionID) break
          sessionId = info.sessionID
          if (info.role === "assistant") {
            lastAssistantMessageId = info.id
            if (!partTexts.has(info.id)) partTexts.set(info.id, new Map())
            // Keep the map bounded.
            if (partTexts.size > 50) {
              for (const key of [...partTexts.keys()].slice(0, partTexts.size - 50)) partTexts.delete(key)
            }
          }
          break
        }
        case "message.part.updated": {
          const part = event.properties.part as {
            type?: string
            sessionID?: string
            messageID?: string
            id?: string
            text?: string
            synthetic?: boolean
            ignored?: boolean
          }
          if (!part.sessionID || !part.messageID || !part.id) break
          sessionId = part.sessionID
          if (part.type !== "text" || part.synthetic || part.ignored) break
          const role = messageRoles.get(part.messageID)
          if (role !== "assistant") {
            const messageId = part.messageID
            const partId = part.id
            void client.session
              .messages({ path: { id: part.sessionID } })
              .then((res) => {
                const messages = ((res.data as unknown as Array<{ info: { id: string; role: string } }> | undefined) ?? [])
                for (const m of messages) messageRoles.set(m.info.id, m.info.role)
                if (messageRoles.get(messageId) !== "assistant") return
                let parts = partTexts.get(messageId)
                if (!parts) {
                  parts = new Map()
                  partTexts.set(messageId, parts)
                }
                parts.set(partId, part.text ?? "")
                if (activeTurn) {
                  previewState ??= { pendingText: "", lastSentText: "" }
                  previewState.pendingText = [...parts.values()].join("")
                  schedulePreviewFlush(activeTurn.chatId)
                }
              })
              .catch(() => undefined)
            break
          }
          let parts = partTexts.get(part.messageID)
          if (!parts) {
            parts = new Map()
            partTexts.set(part.messageID, parts)
          }
          parts.set(part.id, part.text ?? "")
          if (activeTurn) {
            previewState ??= { pendingText: "", lastSentText: "" }
            previewState.pendingText = [...parts.values()].join("")
            schedulePreviewFlush(activeTurn.chatId)
          }
          break
        }
        case "session.status": {
          const props = event.properties as { sessionID?: string; status?: { type?: string } }
          if (!props.sessionID || !sessionId || props.sessionID !== sessionId) break
          if (props.status?.type === "idle" && busyFromTelegram) {
            await finishActiveTurn("idle")
          }
          break
        }
        case "session.error": {
          const props = event.properties as unknown as { sessionID?: string; error?: { message?: string } | string }
          if (!props.sessionID || !sessionId || props.sessionID !== sessionId || !busyFromTelegram) break
          const message = typeof props.error === "string" ? props.error : props.error?.message
          await finishActiveTurn("error", message || undefined)
          break
        }
      }
    },
  }
}

export default TelegramPlugin
