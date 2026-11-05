import { apiCors } from "./cors.js";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { config, AppError } from "./config.js";
import {
  validatePostURL,
  parseURL,
  resolvePublic,
  safeGet,
  createEgressProxy,
} from "./security.js";
import { extractors } from "./extractors/index.js";
import { normalize, publicMedia } from "./normalize.js";
import { get, save } from "./store.js";
import { withTemp } from "./temp.js";
import { prepare, zipFiles, limiter } from "./download.js";
import { createSlots } from "./slots.js";
export function createApp() {
  const app = express();
  let active = 0;
  const previewSlot = createSlots(4);
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    "/api",
    apiCors(
      (process.env.FRONTEND_ORIGINS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  app.use(express.json({ limit: "8kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: 40,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "Too many requests. Try again in a minute." },
    }),
  );
  app.get("/api/v1/health", (_req, res) => res.json({ status: "ok" }));
  const job =
    (fn, preview = false) =>
    async (req, res, next) => {
      if (!preview && active >= config.jobs)
        return next(
          new AppError(
            "All processing slots are busy. Try again shortly.",
            503,
          ),
        );
      if (!preview) active++;
      let release;
      const c = new AbortController(),
        timer = setTimeout(() => c.abort(), config.timeout);
      const close = () => {
        if (!res.writableEnded) c.abort();
      };
      res.on("close", close);
      try {
        if (preview) release = await previewSlot(c.signal);
        await fn(req, res, c.signal);
      } catch (e) {
        next(
          c.signal.aborted
            ? new AppError("Request timed out or was cancelled.", 408)
            : e,
        );
      } finally {
        clearTimeout(timer);
        res.off("close", close);
        if (!preview) active--;
        release?.();
      }
    };
  app.post(
    "/api/v1/media/analyze",
    job(async (req, res, signal) => {
      const url = req.body?.url;
      if (typeof url !== "string" || url.length > 2048)
        throw new AppError("Enter a valid media URL.");
      const platform = validatePostURL(url);
      let parsed = parseURL(url);
      if (
        ["pin.it", "fb.watch"].includes(parsed.hostname) ||
        (platform === "Facebook" && parsed.pathname.startsWith("/share/"))
      ) {
        const response = await safeGet(parsed.href, signal);
        const finalUrl = response.finalUrl;
        response.destroy();
        if (validatePostURL(finalUrl) !== platform)
          throw new AppError(
            "The short link redirects to an unsupported post.",
          );
        parsed = parseURL(finalUrl);
      }
      if (!parsed.pathname || parsed.pathname === "/")
        throw new AppError("Paste a link to a specific post or video.");
      await resolvePublic(parsed.hostname);
      const proxy = await createEgressProxy();
      try {
        const raw = await extractors[platform](parsed.href, proxy.url, signal);
        res.json(publicMedia(save(normalize(raw, platform, parsed.href))));
      } finally {
        proxy.close();
      }
    }),
  );
  app.get(
    "/api/v1/media/:id/preview/:item",
    job(async (req, res, signal) => {
      const item = get(req.params.id).items.find(
        (i) => i.id === req.params.item,
      );
      if (!item?.thumbnail) throw new AppError("Preview unavailable.", 404);
      const source = await safeGet(item.thumbnail, signal);
      const mime = source.headers["content-type"]?.split(";")[0];
      if (
        !["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mime)
      ) {
        source.destroy();
        throw new AppError("Preview unavailable.", 415);
      }
      res.set("Cross-Origin-Resource-Policy", "cross-origin");
      res.type(mime);
      res.set("Cache-Control", "private, max-age=120");
      await pipeline(source, limiter({ bytes: 0, max: 8 * 1024 * 1024 }), res, {
        signal,
      });
    }, true),
  );
  app.post(
    "/api/v1/media/download",
    job(async (req, res, signal) => {
      const media = get(req.body?.mediaId),
        selections = req.body?.selections;
      if (
        !Array.isArray(selections) ||
        !selections.length ||
        selections.length > 30
      )
        throw new AppError("Select between 1 and 30 media items.");
      const ids = new Set();
      const formats = selections.map((s) => {
        if (!s || ids.has(s.itemId))
          throw new AppError("Invalid or duplicate selection.");
        ids.add(s.itemId);
        const item = media.items.find((i) => i.id === s.itemId),
          format = item?.formats.find((f) => f.id === s.formatId);
        if (!format)
          throw new AppError("Invalid media format. Analyze the link again.");
        return format;
      });
      await withTemp(async (dir) => {
        const files = [],
          budget = { bytes: 0, max: config.maxBytes };
        for (const [index, format] of formats.entries())
          files.push({
            path: await prepare(format, dir, index, signal, budget),
            name: `Crazibox-${index + 1}.${format.extension}`,
          });
        const zipped = req.body.archive === true || files.length > 1;
        const path = zipped
          ? await zipFiles(files, dir, signal)
          : files[0].path;
        await new Promise((resolve, reject) =>
          res.download(path, zipped ? "Crazibox.zip" : files[0].name, (e) =>
            e ? reject(e) : resolve(),
          ),
        );
      });
    }),
  );
  app.use("/api", (_req, _res, next) =>
    next(new AppError("Endpoint not found.", 404)),
  );
  const dist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
  app.use(express.static(dist));
  app.get("/", (_req, res) => res.sendFile(dist + "index.html"));
  app.use((err, _req, res, _next) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err.message);
    res.status(status).json({
      error:
        status === 500
          ? "Something went wrong. Please try again."
          : err.message,
    });
  });
  return app;
}
