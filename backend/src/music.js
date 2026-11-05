import { AppError } from "./config.js";

export const MAX_RECOGNITION_BYTES = 10 * 1024 * 1024;

function secureLink(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export async function recognizeAudio({
  buffer,
  mimeType = "application/octet-stream",
  signal,
  token = process.env.AUDD_API_TOKEN,
  fetchImpl = fetch,
}) {
  if (!token) throw new AppError("Music recognition is not configured yet.", 503);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError("Choose a non-empty audio or video file.");
  }
  if (
    !/^(?:audio|video)\/[a-z0-9.+-]+$/i.test(mimeType) &&
    mimeType !== "application/octet-stream"
  ) {
    throw new AppError("Only audio and video files can be identified.", 415);
  }
  if (buffer.length > MAX_RECOGNITION_BYTES) {
    throw new AppError("Music recognition files must be 10 MB or smaller.", 413);
  }

  const form = new FormData();
  form.append("api_token", token);
  form.append("file", new Blob([buffer], { type: mimeType }), "crazibox-upload");
  form.append("return", "apple_music,spotify");

  let response;
  try {
    response = await fetchImpl("https://api.audd.io/", {
      method: "POST",
      body: form,
      signal,
    });
  } catch {
    if (signal?.aborted) throw new AppError("Music recognition was cancelled.", 408);
    throw new AppError("The music-recognition service could not be reached.", 502);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.status !== "success") {
    throw new AppError(
      "The music-recognition service rejected this clip. Check the provider token or try another file.",
      502,
    );
  }
  const result = payload.result;
  if (!result) throw new AppError("No matching song was found in this clip.", 404);

  return {
    title: typeof result.title === "string" ? result.title : "Unknown title",
    artist: typeof result.artist === "string" ? result.artist : "Unknown artist",
    album: typeof result.album === "string" ? result.album : null,
    releaseDate: typeof result.release_date === "string" ? result.release_date : null,
    label: typeof result.label === "string" ? result.label : null,
    timecode: typeof result.timecode === "string" ? result.timecode : null,
    songLink: secureLink(result.song_link),
    appleMusicUrl: secureLink(result.apple_music?.url),
    spotifyUrl: secureLink(
      result.spotify?.external_urls?.spotify || result.spotify?.url,
    ),
  };
}
