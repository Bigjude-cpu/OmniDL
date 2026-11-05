import test from "node:test";
import assert from "node:assert/strict";
import { access, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  detectPlatform,
  validatePostURL,
  publicIP,
  parseURL,
  resolvePublic,
  createEgressProxy,
} from "../src/security.js";
import { normalize, publicMedia } from "../src/normalize.js";
import { withTemp } from "../src/temp.js";
import { run } from "../src/process.js";
import { zipFiles } from "../src/download.js";
import { createApp } from "../src/app.js";
import http from "node:http";
test("domains and network boundaries", async () => {
  assert.equal(detectPlatform("https://youtu.be/abc"), "YouTube");
  assert.equal(detectPlatform("https://vm.tiktok.com/a"), "TikTok");
  assert.equal(detectPlatform("https://likee.video/@creator/video/123456"), "Likee");
  for (const url of [
    "file:///etc/passwd",
    "https://youtube.com.evil.test/a",
    "https://evilinstagram.com/a",
    "https://user:pass@youtube.com/a",
  ])
    assert.throws(() => detectPlatform(url));
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "192.168.1.2",
    "100.64.0.1",
    "fc00::1",
  ])
    assert.equal(publicIP(ip), false, ip);
  assert.equal(publicIP("8.8.8.8"), true);
  await assert.rejects(() => resolvePublic("localhost"));
  assert.throws(() => parseURL("https://youtube.com:22/a"));
  assert.throws(() => validatePostURL("https://likee.video/@creator"));
});
test("proxy rejects internal HTTP and CONNECT destinations", async () => {
  const proxy = await createEgressProxy();
  try {
    await new Promise((resolve, reject) => {
      http
        .get(proxy.url, { path: "http://127.0.0.1/private" }, (res) => {
          assert.equal(res.statusCode, 403);
          res.resume();
          resolve();
        })
        .on("error", reject);
    });
    await new Promise((resolve, reject) => {
      const req = http.request(proxy.url, {
        method: "CONNECT",
        path: "127.0.0.1:443",
      });
      req.on("connect", (res, socket) => {
        assert.equal(res.statusCode, 403);
        socket.destroy();
        resolve();
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    proxy.close();
  }
});
test("mixed carousel normalizes and hides upstream URLs", () => {
  const result = normalize(
    {
      title: "Test",
      entries: [
        { ext: "jpg", url: "https://example.com/a.jpg" },
        { ext: "mp4", url: "https://example.com/v.mp4" },
      ],
    },
    "Instagram",
    "https://instagram.com/p/a",
  );
  assert.equal(result.type, "mixed");
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items[1].formats.map((f) => f.kind),
    ["video", "audio", "audio"],
  );
  assert.ok(!JSON.stringify(publicMedia(result)).includes("example.com"));
});
test("adaptive video pairs audio and excludes manifests and DRM", () => {
  const m = normalize(
    {
      formats: [
        {
          url: "https://example.com/v",
          ext: "mp4",
          vcodec: "avc1",
          acodec: "none",
          height: 1080,
        },
        {
          url: "https://example.com/a",
          ext: "m4a",
          vcodec: "none",
          acodec: "aac",
        },
        {
          url: "https://example.com/drm",
          ext: "mp4",
          vcodec: "avc1",
          has_drm: true,
        },
        { url: "https://example.com/v.m3u8", ext: "mp4", vcodec: "avc1" },
      ],
    },
    "YouTube",
    "https://youtu.be/abc",
  );
  assert.equal(m.items[0].formats[0].sources.length, 2);
  assert.equal(m.items[0].formats.filter((f) => f.kind === "video").length, 1);
});
test("temporary files are removed on failure", async () => {
  let dir;
  await assert.rejects(() =>
    withTemp(async (d) => {
      dir = d;
      await writeFile(join(d, "test"), "data");
      throw Error("failure");
    }),
  );
  await assert.rejects(() => access(dir));
});
test("FFmpeg audio conversion and ZIP produce real artifacts", async () => {
  await withTemp(async (dir) => {
    const wav = join(dir, "source.wav"),
      mp3 = join(dir, "audio.mp3");
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=0.2",
      wav,
    ]);
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      wav,
      "-c:a",
      "libmp3lame",
      mp3,
    ]);
    assert.ok((await readFile(mp3)).length > 100);
    const zip = await zipFiles(
      [{ path: mp3, name: "audio.mp3" }],
      dir,
      new AbortController().signal,
    );
    assert.equal((await readFile(zip)).subarray(0, 2).toString(), "PK");
  });
});
test("API rejects invalid input and expired handles", async () => {
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [path, body, status] of [
      ["analyze", { url: "http://localhost/test" }, 400],
      ["analyze", { url: "file:///tmp/test" }, 400],
      ["download", { mediaId: "expired", selections: [] }, 410],
    ]) {
      const r = await fetch(`${origin}/api/v1/media/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, status);
      assert.ok((await r.json()).error);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("images expose PNG by default plus JPG, JPEG and WebP", () => {
  const media = normalize(
    { ext: "webp", url: "https://example.com/photo.webp" },
    "Instagram",
    "https://instagram.com/p/example",
  );
  assert.deepEqual(
    media.items[0].formats.map((f) => f.extension),
    ["png", "jpg", "jpeg", "webp"],
  );
});

test("image conversion writes real target encodings without resizing", async () => {
  const { convertImage } = await import("../src/images.js");
  await withTemp(async (dir) => {
    const input = join(dir, "source.ppm");
    await writeFile(
      input,
      Buffer.concat([
        Buffer.from("P6\n24 18\n255\n"),
        Buffer.alloc(24 * 18 * 3, 120),
      ]),
    );
    for (const extension of ["png", "jpg", "jpeg", "webp"]) {
      const output = join(dir, `image.${extension}`);
      await convertImage(
        input,
        output,
        extension,
        new AbortController().signal,
      );
      const data = await readFile(output);
      if (extension === "png")
        assert.equal(data.subarray(1, 4).toString(), "PNG");
      else if (extension === "webp")
        assert.equal(data.subarray(8, 12).toString(), "WEBP");
      else assert.equal(data.subarray(0, 3).toString("hex"), "ffd8ff");
      const probe = JSON.parse(
        await run("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=width,height",
          "-of",
          "json",
          output,
        ]),
      );
      assert.equal(probe.streams[0].width, 24);
      assert.equal(probe.streams[0].height, 18);
    }
  });
});

test("preview slots queue bursts and remove cancelled waiters", async () => {
  const { createSlots } = await import("../src/slots.js");
  const acquire = createSlots(2);
  let running = 0,
    peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      const release = await acquire(new AbortController().signal);
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      release();
    }),
  );
  assert.equal(peak, 2);
  const one = createSlots(1);
  const release = await one(new AbortController().signal);
  const cancelled = new AbortController();
  const pending = one(cancelled.signal);
  cancelled.abort();
  await assert.rejects(pending, /cancelled/);
  release();
  (await one(new AbortController().signal))();
});

test("media requests preserve safe extractor headers without credentials", async () => {
  const { mediaHeaders } = await import("../src/security.js");
  assert.deepEqual(
    mediaHeaders({
      Referer: "https://www.tiktok.com/",
      "User-Agent": "test-agent",
      Cookie: "private",
      Authorization: "secret",
      Host: "localhost",
      "X-Test": "ignored",
    }),
    { Referer: "https://www.tiktok.com/", "User-Agent": "test-agent" },
  );
  assert.deepEqual(mediaHeaders({ Referer: "value\r\nInjected: yes" }), {});
});

test("alternate video CDNs and request headers stay server-side", () => {
  const media = normalize(
    {
      http_headers: { Referer: "https://www.tiktok.com/" },
      formats: [
        {
          url: "https://a.example/video",
          ext: "mp4",
          height: 720,
          vcodec: "h264",
          acodec: "aac",
        },
        {
          url: "https://b.example/video",
          ext: "mp4",
          height: 720,
          vcodec: "h264",
          acodec: "aac",
        },
      ],
    },
    "TikTok",
    "https://www.tiktok.com/@test/video/123",
  );
  const format = media.items[0].formats[0];
  assert.equal(format.sourceOptions[0].length, 2);
  assert.equal(
    format.sourceOptions[0][0].headers.Referer,
    "https://www.tiktok.com/",
  );
  assert.ok(!JSON.stringify(publicMedia(media)).includes("sourceOptions"));
  assert.ok(!JSON.stringify(publicMedia(media)).includes("a.example"));
});

test("anonymous cookies never cross redirect origins or reach the frontend", async () => {
  const { redirectCookie } = await import("../src/security.js");
  assert.equal(
    redirectCookie("session=test", "https://cdn.example/a", "/b"),
    "session=test",
  );
  for (const target of [
    "https://other.example/b",
    "http://cdn.example/b",
    "https://cdn.example:444/b",
  ])
    assert.equal(
      redirectCookie("session=test", "https://cdn.example/a", target),
      "",
    );
  const media = normalize(
    {
      formats: [
        {
          url: "https://cdn.example/v",
          ext: "mp4",
          vcodec: "h264",
          acodec: "aac",
          omnidl_cookie: "session=test",
        },
      ],
    },
    "TikTok",
    "https://www.tiktok.com/@test/video/123",
  );
  assert.equal(
    media.items[0].formats[0].sourceOptions[0][0].anonymousCookie,
    "session=test",
  );
  assert.ok(!JSON.stringify(publicMedia(media)).includes("session=test"));
});

test("post metadata separates username, caption and Unicode hashtags", async () => {
  const { postMetadata } = await import("../src/post-metadata.js");
  assert.deepEqual(
    postMetadata({
      uploader_id: "123456",
      channel: "buildwithdzarel",
      description: "Cerita hari ini\n#jalan_jalan #日本 #jalan_jalan",
    }),
    {
      username: "buildwithdzarel",
      caption: "Cerita hari ini",
      hashtags: ["jalan_jalan", "日本"],
    },
  );
  assert.equal(
    postMetadata({
      uploader: "Display Name",
      uploader_url: "https://www.tiktok.com/@bersiap.lah",
    }).username,
    "bersiap.lah",
  );
  assert.equal(postMetadata({ uploader: "Display Name" }).username, null);
});

test("new platform post links are accepted without allowing profiles or lookalike domains", async () => {
  const { validatePostURL } = await import("../src/security.js");
  for (const [url, platform] of [
    ["https://www.pinterest.com/pin/123/", "Pinterest"],
    ["https://www.pinterest.ca/pin/a-nice-photo--123/", "Pinterest"],
    ["https://pin.it/abc123", "Pinterest"],
    ["https://www.facebook.com/reel/123/", "Facebook"],
    ["https://m.facebook.com/watch/?v=123", "Facebook"],
    ["https://www.facebook.com/photo.php?fbid=123", "Facebook"],
    ["https://www.facebook.com/creator/videos/123/", "Facebook"],
    ["https://fb.watch/abc123/", "Facebook"],
    ["https://www.facebook.com/share/v/abc123/", "Facebook"],
    ["https://x.com/creator/status/123/photo/1", "X / Twitter"],
    ["https://twitter.com/i/web/status/123", "X / Twitter"],
  ])
    assert.equal(validatePostURL(url), platform, url);
  for (const url of [
    "https://pinterest.com/creator/board/",
    "https://facebook.com/creator",
    "https://x.com/home",
    "https://twitter.com/search?q=test",
    "https://pinterest.com.evil.test/pin/123",
    "https://notfacebook.com/reel/123",
    "https://x.com.evil.test/a/status/123",
  ])
    assert.throws(() => validatePostURL(url), undefined, url);
});

test("silent X animations expose MP4 without inventing audio", () => {
  const m = normalize(
    {
      silent_video: true,
      formats: [
        {
          url: "https://video.twimg.com/test.mp4",
          ext: "mp4",
          vcodec: "h264",
          acodec: "none",
        },
      ],
    },
    "X / Twitter",
    "https://x.com/test/status/123",
  );
  assert.deepEqual(
    m.items[0].formats.map((f) => f.kind),
    ["video"],
  );
});

test("progressive MP4 without codec metadata remains downloadable", () => {
  const m = normalize(
    {
      formats: [
        {
          url: "https://cdn.example/direct.mp4",
          ext: "mp4",
          protocol: "https",
        },
      ],
    },
    "Facebook",
    "https://facebook.com/reel/123",
  );
  assert.equal(m.items[0].formats[0].kind, "video");
  assert.equal(m.items[0].formats[0].extension, "mp4");
});

test("Netlify CORS permits only configured origins", async () => {
  const { apiCors } = await import("../src/cors.js");
  for (const [origin, expected] of [
    ["https://omnidl.netlify.app", 204],
    ["https://untrusted.example", 403],
  ]) {
    const headers = {};
    let status;
    const res = {
      vary() {},
      set(key, value) {
        headers[key] = value;
      },
      sendStatus(value) {
        status = value;
      },
    };
    apiCors(["https://omnidl.netlify.app"])(
      { method: "OPTIONS", headers: { origin } },
      res,
      () => assert.fail("Preflight should finish"),
    );
    assert.equal(status, expected);
    assert.equal(
      headers["Access-Control-Allow-Origin"],
      expected === 204 ? origin : undefined,
    );
    assert.equal(headers["Access-Control-Allow-Credentials"], undefined);
  }
});
