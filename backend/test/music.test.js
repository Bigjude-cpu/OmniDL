import test from "node:test";
import assert from "node:assert/strict";
import { recognizeAudio, MAX_RECOGNITION_BYTES } from "../src/music.js";

test("music recognition sends the clip to AudD and returns safe metadata", async () => {
  const input = Buffer.from("sample-audio");
  let request;
  const result = await recognizeAudio({
    buffer: input,
    mimeType: "audio/webm",
    token: "test-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        status: "success",
        result: {
          title: "Test Song",
          artist: "Test Artist",
          album: "Test Album",
          song_link: "https://lis.tn/example",
          spotify: { external_urls: { spotify: "https://open.spotify.com/track/example" } },
          apple_music: { url: "https://music.apple.com/song/example" },
        },
      }), { status: 200 });
    },
  });
  assert.equal(request.url, "https://api.audd.io/");
  assert.equal(request.options.body.get("api_token"), "test-token");
  assert.equal(request.options.body.get("file").size, input.length);
  assert.equal(result.title, "Test Song");
  assert.equal(result.artist, "Test Artist");
  assert.equal(result.songLink, "https://lis.tn/example");
  assert.equal(result.spotifyUrl, "https://open.spotify.com/track/example");
});

test("music recognition refuses to run without a provider token", async () => {
  await assert.rejects(
    () => recognizeAudio({ buffer: Buffer.from("audio"), token: "" }),
    (error) => error.status === 503,
  );
});

test("music recognition enforces size and media-type limits", async () => {
  await assert.rejects(
    () => recognizeAudio({
      buffer: Buffer.alloc(MAX_RECOGNITION_BYTES + 1),
      token: "test-token",
      mimeType: "audio/mpeg",
    }),
    (error) => error.status === 413,
  );
  await assert.rejects(
    () => recognizeAudio({
      buffer: Buffer.from("not audio"),
      token: "test-token",
      mimeType: "text/plain",
    }),
    (error) => error.status === 415,
  );
});

test("music recognition handles no match and provider failures", async () => {
  await assert.rejects(
    () => recognizeAudio({
      buffer: Buffer.from("audio"),
      token: "test-token",
      fetchImpl: async () => new Response(JSON.stringify({ status: "success", result: null })),
    }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () => recognizeAudio({
      buffer: Buffer.from("audio"),
      token: "test-token",
      fetchImpl: async () => new Response(JSON.stringify({ status: "error" }), { status: 200 }),
    }),
    (error) => error.status === 502,
  );
});
