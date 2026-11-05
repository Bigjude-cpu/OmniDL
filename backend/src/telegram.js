import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { withTemp } from "./temp.js";
import { prepare } from "./download.js";
import { config, AppError } from "./config.js";
import {
  validatePostURL,
  parseURL,
  resolvePublic,
  createEgressProxy,
  safeGet,
} from "./security.js";
import { extractors } from "./extractors/index.js";
import { normalize } from "./normalize.js";
import { recognizeAudio } from "./music.js";

const FILE_RECOGNITION_LIMIT = 10 * 1024 * 1024;
const TELEGRAM_UPLOAD_LIMIT = 50 * 1024 * 1024;

export function verifyWebhookSecret(received, expected) {
  if (typeof received !== "string" || typeof expected !== "string") return false;
  if (expected.length < 16 || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function verifyTelegramWebhook(received) {
  return Boolean(
    process.env.TELEGRAM_BOT_TOKEN &&
      verifyWebhookSecret(received, process.env.TELEGRAM_WEBHOOK_SECRET),
  );
}

function apiRoot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new AppError("The Telegram bot is not configured.", 503);
  return `https://api.telegram.org/bot${token}`;
}

async function botRequest(method, params, signal) {
  const response = await fetch(`${apiRoot()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new AppError("Telegram could not complete the bot request.", 502);
  }
  return payload.result;
}

async function sendText(chatId, text, signal) {
  return botRequest("sendMessage", {
    chat_id: chatId,
    text: String(text).slice(0, 3900),
    link_preview_options: { is_disabled: true },
  }, signal);
}

async function getTelegramFile(fileId, signal) {
  const info = await botRequest("getFile", { file_id: fileId }, signal);
  if (!info?.file_path) throw new AppError("Telegram could not provide that file.", 422);
  if (info.file_size && info.file_size > FILE_RECOGNITION_LIMIT) {
    throw new AppError("For music recognition, send an audio or video clip up to 10 MB.");
  }
  const response = await fetch(
    `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.file_path}`,
    { signal },
  );
  if (!response.ok) throw new AppError("Telegram file download failed.", 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!bytes.length || bytes.length > FILE_RECOGNITION_LIMIT) {
    throw new AppError("For music recognition, send an audio or video clip up to 10 MB.");
  }
  return bytes;
}

async function sendMediaFile(chatId, format, path, index, platform, signal) {
  const data = await readFile(path);
  if (data.length > TELEGRAM_UPLOAD_LIMIT) {
    throw new AppError("A media item is too large to send through Telegram.", 413);
  }
  const ext = /^[a-z0-9]{2,5}$/i.test(format.extension)
    ? format.extension.toLowerCase()
    : "bin";
  const types = {
    mp4: ["sendVideo", "video", "video/mp4"],
    m4v: ["sendVideo", "video", "video/mp4"],
    mp3: ["sendAudio", "audio", "audio/mpeg"],
    m4a: ["sendAudio", "audio", "audio/mp4"],
    jpg: ["sendPhoto", "photo", "image/jpeg"],
    jpeg: ["sendPhoto", "photo", "image/jpeg"],
    png: ["sendPhoto", "photo", "image/png"],
    webp: ["sendDocument", "document", "image/webp"],
  };
  const [method, field, mimeType] =
    types[ext] || ["sendDocument", "document", "application/octet-stream"];
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    field,
    new Blob([data], { type: mimeType }),
    `Crazibox-${index + 1}.${ext}`,
  );
  form.append("caption", `Crazibox · ${platform} · item ${index + 1}`);

  const response = await fetch(`${apiRoot()}/${method}`, {
    method: "POST",
    body: form,
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new AppError(
      "Telegram could not send this media item. Try downloading it on the Crazibox website.",
      502,
    );
  }
}

async function analyzeTelegramLink(chatId, value, signal) {
  let url = parseURL(value);
  let platform = validatePostURL(url.href);
  if (
    ["pin.it", "fb.watch"].includes(url.hostname) ||
    (platform === "Facebook" && url.pathname.startsWith("/share/"))
  ) {
    const response = await safeGet(url.href, signal);
    const finalUrl = response.finalUrl;
    response.destroy();
    if (validatePostURL(finalUrl) !== platform) {
      throw new AppError("That short link redirects to an unsupported media post.");
    }
    url = parseURL(finalUrl);
  }
  await resolvePublic(url.hostname);
  const proxy = await createEgressProxy();
  let raw;
  try {
    raw = await extractors[platform](url.href, proxy.url, signal);
  } finally {
    proxy.close();
  }

  const media = normalize(raw, platform, url.href);
  const items = media.items.slice(0, 10);
  if (!items.length) throw new AppError("No downloadable media was found in that post.");
  await sendText(
    chatId,
    `Crazibox found ${media.items.length} media item(s) from ${platform}. Sending up to ${items.length} item(s)…`,
    signal,
  );
  const budget = { bytes: 0, max: config.maxBytes };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const format =
      item.formats.find((candidate) => candidate.kind === "video") ||
      item.formats.find((candidate) => candidate.kind === "image") ||
      item.formats.find((candidate) => candidate.kind === "audio");
    if (!format) continue;
    await withTemp(async (dir) => {
      const path = await prepare(format, dir, index, signal, budget);
      await sendMediaFile(chatId, format, path, index, platform, signal);
    });
  }
  if (media.items.length > items.length) {
    await sendText(
      chatId,
      "This post contains more items. Open Crazibox in your browser to select the full carousel.",
      signal,
    );
  }
}

function incomingMedia(message) {
  if (message.voice) return { file: message.voice, mimeType: "audio/ogg" };
  if (message.audio) return { file: message.audio, mimeType: message.audio.mime_type || "audio/mpeg" };
  if (message.video) return { file: message.video, mimeType: message.video.mime_type || "video/mp4" };
  if (message.video_note) return { file: message.video_note, mimeType: "video/mp4" };
  if (
    message.document &&
    /^(audio|video)\//i.test(message.document.mime_type || "")
  ) {
    return { file: message.document, mimeType: message.document.mime_type };
  }
  return null;
}

export async function processTelegramUpdate(update) {
  const message = update?.message || update?.edited_message;
  const chatId = message?.chat?.id;
  if (!chatId || !process.env.TELEGRAM_BOT_TOKEN) return;
  const signal = AbortSignal.timeout(120000);
  const text = String(message.text || message.caption || "").trim();

  try {
    if (/^\/(start|help)(?:@[^\s]+)?(?:\s|$)/i.test(text)) {
      await sendText(
        chatId,
        "Welcome to Crazibox. Send a public TikTok, Instagram, YouTube, Pinterest, Facebook, X, or Likee post link to download its media. Send a short audio or video file to identify its music. Public links only.",
        signal,
      );
      return;
    }

    const media = incomingMedia(message);
    if (media) {
      if (!process.env.AUDD_API_TOKEN) {
        await sendText(chatId, "Music recognition is not enabled yet. The Crazibox owner must configure the AudD API token.", signal);
        return;
      }
      const buffer = await getTelegramFile(media.file.file_id, signal);
      const result = await recognizeAudio({
        buffer,
        mimeType: media.mimeType,
        signal,
      });
      await sendText(
        chatId,
        `🎵 ${result.title}\nArtist: ${result.artist}${result.album ? `\nAlbum: ${result.album}` : ""}${result.songLink ? `\nSong details: ${result.songLink}` : ""}`,
        signal,
      );
      return;
    }

    const match = text.match(/https?:\/\/[^\s<>]+/i);
    if (match) {
      const url = match[0].replace(/[),.!?]+$/, "");
      await analyzeTelegramLink(chatId, url, signal);
      return;
    }

    await sendText(
      chatId,
      "Paste a public media post link, or send a short audio/video clip for music recognition. Use /help for details.",
      signal,
    );
  } catch (error) {
    const messageText =
      error instanceof AppError
        ? error.message
        : "Crazibox could not process that message. Try another public link or a smaller file.";
    try {
      await sendText(chatId, messageText, signal);
    } catch {
      // Do not let a failed fallback message create a webhook retry loop.
    }
  }
}
