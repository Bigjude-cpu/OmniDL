import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { AppError } from "./config.js";
export function publicIP(value) {
  try {
    return ipaddr.process(value).range() === "unicast";
  } catch {
    return false;
  }
}
export function parseURL(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new AppError("Enter a valid media URL.");
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    (u.port && !["80", "443"].includes(u.port))
  )
    throw new AppError("Only public HTTP or HTTPS links are allowed.");
  return u;
}
export function detectPlatform(value) {
  const u = parseURL(value),
    h = u.hostname.toLowerCase();
  const belongs = (d) => h === d || h.endsWith("." + d);
  if (
    [
      "pinterest.com",
      "pinterest.co.uk",
      "pinterest.id",
      "pinterest.ca",
      "pinterest.com.au",
      "pinterest.de",
      "pinterest.fr",
      "pinterest.es",
      "pinterest.it",
      "pinterest.jp",
    ].some(belongs) ||
    h === "pin.it"
  )
    return "Pinterest";
  if (belongs("facebook.com") || h === "fb.watch") return "Facebook";
  if (belongs("x.com") || belongs("twitter.com")) return "X / Twitter";
  if (belongs("tiktok.com")) return "TikTok";
  if (belongs("instagram.com")) return "Instagram";
  if (belongs("likee.video")) return "Likee";
  if (belongs("youtube.com") || h === "youtu.be") return "YouTube";
  throw new AppError(
    "Use a TikTok, Instagram, YouTube, Pinterest, Facebook, X, or Likee media link.",
  );
}
export async function resolvePublic(host) {
  const records = await dns.lookup(host.replace(/^\[|\]$/g, ""), { all: true });
  if (!records.length || records.some((r) => !publicIP(r.address)))
    throw new AppError("Private or internal network addresses are blocked.");
  return records[0];
}
export function mediaHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) =>
        [
          "user-agent",
          "referer",
          "origin",
          "accept",
          "accept-language",
        ].includes(key.toLowerCase()) &&
        typeof value === "string" &&
        !/[\r\n]/.test(value),
    ),
  );
}
export function redirectCookie(cookie, from, to) {
  return new URL(from).origin === new URL(to, from).origin ? cookie : "";
}
export async function safeGet(
  value,
  signal,
  redirects = 0,
  headers = {},
  anonymousCookie = "",
) {
  const u = parseURL(value);
  const ip = await resolvePublic(u.hostname);
  if (redirects > 5) throw new AppError("Too many redirects.");
  return new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).get(
      u,
      {
        signal,
        lookup: (_h, options, cb) =>
          options.all ? cb(null, [ip]) : cb(null, ip.address, ip.family),
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "*/*",
          ...mediaHeaders(headers),
          ...(anonymousCookie && !/[\r\n]/.test(anonymousCookie)
            ? { Cookie: anonymousCookie }
            : {}),
        },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          if (!res.headers.location)
            return reject(new AppError("Invalid media redirect."));
          safeGet(
            new URL(res.headers.location, u).href,
            signal,
            redirects + 1,
            headers,
            redirectCookie(anonymousCookie, u.href, res.headers.location),
          ).then(resolve, reject);
        } else if (res.statusCode !== 200) {
          res.resume();
          reject(
            new AppError(
              [401, 403].includes(res.statusCode)
                ? "The platform denied access to the media file (HTTP " +
                    res.statusCode +
                    "). Try another public link or try again later."
                : "The media source is unavailable. Analyze the link again.",
              502,
            ),
          );
        } else {
          res.finalUrl = u.href;
          resolve(res);
        }
      },
    );
    req.on("error", reject);
  });
}
// All extractor requests pass this proxy; each destination is resolved and pinned.
export async function createEgressProxy() {
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const u = parseURL(req.url);
      const ip = await resolvePublic(u.hostname);
      const headers = { ...req.headers, host: u.host };
      delete headers["proxy-authorization"];
      delete headers["proxy-connection"];
      const upstream = http.request(
        u,
        {
          method: req.method,
          headers,
          lookup: (_h, options, cb) =>
            options.all ? cb(null, [ip]) : cb(null, ip.address, ip.family),
        },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        },
      );
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
    } catch {
      res.writeHead(403);
      res.end();
    }
  });
  server.on("connect", async (req, client, head) => {
    try {
      const u = new URL("https://" + req.url);
      if (u.port && u.port !== "443") throw Error();
      const ip = await resolvePublic(u.hostname);
      const remote = net.connect({ host: ip.address, port: 443 }, () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) remote.write(head);
        remote.pipe(client);
        client.pipe(remote);
      });
      remote.setTimeout(30000, () => remote.destroy());
      remote.on("error", () => client.destroy());
      client.on("close", () => remote.destroy());
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    s.setTimeout(30000, () => s.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

export function validatePostURL(value) {
  const u = parseURL(value),
    platform = detectPlatform(value),
    p = u.pathname;
  const validators = {
    Instagram: () => /^\/(p|reel|reels|tv)\/[^/]+\/?$/.test(p),
    Likee: () => /^\/(?:@[^/]+\/video\/[A-Za-z0-9_]+|v\/[A-Za-z0-9_]+)\/?$/.test(p),
    YouTube: () =>
      u.hostname === "youtu.be"
        ? /^\/[^/]+\/?$/.test(p)
        : /^\/(shorts|live)\/[^/]+\/?$/.test(p) ||
          (p === "/watch" && !!u.searchParams.get("v")),
    TikTok: () =>
      ["vm.tiktok.com", "vt.tiktok.com"].includes(u.hostname) ||
      /^\/(?:@[^/]+\/(?:video|photo)\/\d+|t\/[^/]+)\/?$/.test(p),
    Pinterest: () =>
      u.hostname === "pin.it"
        ? /^\/[A-Za-z0-9]+\/?$/.test(p)
        : /^\/pin\/(?:[a-zA-Z0-9_-]+--)?\d+\/?$/.test(p),
    Facebook: () =>
      u.hostname === "fb.watch"
        ? /^\/[A-Za-z0-9_-]+\/?$/.test(p)
        : /^\/(?:reel|share\/(?:r|v|p))\/[^/]+\/?$/.test(p) ||
          /^\/[^/]+\/(?:videos|posts)\/[^/]+\/?$/.test(p) ||
          /^\/[^/]+\/photos\/[^/]+(?:\/[^/]+)?\/?$/.test(p) ||
          (["/watch", "/watch/", "/video.php"].includes(p) &&
            !!u.searchParams.get("v")) ||
          (["/photo", "/photo/", "/photo.php"].includes(p) &&
            !!u.searchParams.get("fbid")) ||
          (["/permalink.php", "/story.php"].includes(p) &&
            !!u.searchParams.get("story_fbid")),
    "X / Twitter": () =>
      /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/\d+(?:\/(?:photo|video)\/\d+)?\/?$/.test(
        p,
      ),
  };
  const valid = validators[platform]();
  if (!valid)
    throw new AppError(
      "Paste a link to a specific post or video, not a profile or playlist.",
    );
  return platform;
}
