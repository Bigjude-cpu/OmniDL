import { createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { join } from "node:path";
import archiver from "archiver";
import { config, AppError } from "./config.js";
import { safeGet } from "./security.js";
import { convertImage } from "./images.js";
import { run } from "./process.js";
export function limiter(budget) {
  return new Transform({
    transform(chunk, _enc, cb) {
      budget.bytes += chunk.length;
      cb(
        budget.bytes > budget.max
          ? new AppError("Media exceeds the download size limit.", 413)
          : null,
        chunk,
      );
    },
  });
}
async function fetchFile(options, path, signal, budget) {
  let source, failure;
  for (const option of options.slice(0, 4)) {
    try {
      source = await safeGet(
        option.url,
        signal,
        0,
        option.headers,
        option.anonymousCookie,
      );
      break;
    } catch (error) {
      if (signal.aborted || error.status === 400) throw error;
      failure = error;
    }
  }
  if (!source) throw failure;
  await pipeline(source, limiter(budget), createWriteStream(path), { signal });
}
export async function prepare(format, dir, index, signal, budget) {
  const inputs = [];
  for (const [n, url] of format.sources.entries()) {
    const path = join(dir, `${index}-source-${n}`);
    await fetchFile(
      format.sourceOptions?.[n] || [{ url }],
      path,
      signal,
      budget,
    );
    inputs.push(path);
  }
  const output = join(dir, `${index}.${format.extension}`);
  if (format.kind === "image")
    return convertImage(inputs[0], output, format.extension, signal);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-y",
    ...inputs.flatMap((path) => [
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      path,
    ]),
  ];
  if (format.kind === "audio")
    args.push(
      "-vn",
      "-map",
      "0:a:0",
      ...(format.extension === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", "192k"]
        : ["-c:a", "aac", "-b:a", "192k"]),
    );
  else
    args.push(
      "-map",
      "0:v:0",
      "-map",
      inputs.length > 1 ? "1:a:0" : "0:a?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
    );
  args.push("-fs", String(config.maxBytes + 1), output);
  await run(config.ffmpeg, args, { signal });
  if ((await stat(output)).size > config.maxBytes)
    throw new AppError("Processed media exceeds the size limit.", 413);
  return output;
}
export async function zipFiles(files, dir, signal) {
  const path = join(dir, "Crazibox.zip"),
    zip = archiver("zip", { zlib: { level: 0 } });
  const done = pipeline(
    zip,
    limiter({ bytes: 0, max: config.maxBytes }),
    createWriteStream(path),
    { signal },
  );
  for (const f of files) zip.file(f.path, { name: f.name });
  await Promise.all([zip.finalize(), done]);
  return path;
}
