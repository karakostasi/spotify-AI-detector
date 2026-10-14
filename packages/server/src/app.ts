import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import type { ScoreService } from "./service.js";

const UUID = /^[0-9a-f-]{16,64}$/i;
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const MAX_BATCH = 50;
const BATCH_CONCURRENCY = 6;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

export interface AppOptions {
  /** Directory with the built web app to serve at / */
  staticDir?: string;
  /** Trust X-Forwarded-For for client IPs (only behind a reverse proxy you control) */
  trustProxy?: boolean;
  /** Requests per minute per client for the expensive endpoints */
  rateLimitPerMin?: number;
}

class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number) {}
  allow(key: string, now = Date.now()): boolean {
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + 60_000 });
      return true;
    }
    return ++h.n <= this.max;
  }
}

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
    if (xff) return xff;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function serveStatic(dir: string, pathname: string, res: ServerResponse): Promise<boolean> {
  const rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  const file = join(dir, rel);
  if (!file.startsWith(dir + sep)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, x-user-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

export function createApp(svc: ScoreService, opts: AppOptions = {}): Server {
  const limiter = new RateLimiter(opts.rateLimitPerMin ?? 40);
  const staticDir = opts.staticDir ? normalize(opts.staticDir) : undefined;
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "OPTIONS") return send(res, 204, "");

      if (!url.pathname.startsWith("/api/")) {
        if (staticDir && req.method === "GET" && (await serveStatic(staticDir, url.pathname, res))) return;
        throw new HttpError(404, "Not found");
      }
      const limited = url.pathname === "/api/check" || url.pathname.startsWith("/api/score") || url.pathname === "/api/vote";
      if (limited && !limiter.allow(clientIp(req, opts.trustProxy ?? false))) throw new HttpError(429, "Too many requests, slow down a little");

      if (url.pathname === "/api/health") return send(res, 200, { ok: true });

      if (req.method === "GET" && url.pathname === "/api/check") {
        const track = url.searchParams.get("deezerTrack");
        if (track !== null) {
          if (!/^\d{1,12}$/.test(track)) throw new HttpError(400, "Invalid deezerTrack");
          return send(res, 200, await svc.checkDeezerTrack(Number(track)));
        }
        const artist = url.searchParams.get("deezerArtist");
        if (artist !== null) {
          if (!/^\d{1,12}$/.test(artist)) throw new HttpError(400, "Invalid deezerArtist");
          return send(res, 200, await svc.checkDeezerArtist(Number(artist)));
        }
        const q = (url.searchParams.get("q") ?? "").slice(0, 300);
        if (!q.trim()) throw new HttpError(400, "q required (a Spotify/YouTube link or artist name)");
        return send(res, 200, await svc.check(q));
      }

      if (req.method === "GET" && url.pathname === "/api/score") {
        const isrc = (url.searchParams.get("isrc") ?? "").toUpperCase();
        if (!ISRC.test(isrc)) throw new HttpError(400, "Valid isrc required");
        const report = await svc.scoreIsrc(isrc);
        return send(res, report ? 200 : 404, report ?? { error: "Track not found" });
      }

      if (req.method === "POST" && url.pathname === "/api/score/batch") {
        const body = await readJson(req);
        const tracks: { isrc: string }[] = Array.isArray(body.tracks) ? body.tracks : [];
        if (tracks.length > MAX_BATCH) throw new HttpError(400, `At most ${MAX_BATCH} tracks per request`);
        const valid = tracks.filter((t) => typeof t?.isrc === "string" && ISRC.test(t.isrc.toUpperCase()));
        const results: Record<string, unknown> = {};
        await pool(valid, BATCH_CONCURRENCY, async (t) => {
          const isrc = t.isrc.toUpperCase();
          results[isrc] = await svc.scoreIsrc(isrc).catch(() => null);
        });
        return send(res, 200, { results });
      }

      if (req.method === "POST" && url.pathname === "/api/vote") {
        const userId = String(req.headers["x-user-id"] ?? "");
        if (!UUID.test(userId)) throw new HttpError(401, "X-User-Id header required");
        const body = await readJson(req);
        if (typeof body.artistKey !== "string" || !/^deezer:\d{1,12}$/.test(body.artistKey)) throw new HttpError(400, "Valid artistKey required");
        if (body.vote !== "ai" && body.vote !== "human") throw new HttpError(400, 'vote must be "ai" or "human"');
        svc.crowd.castVote(userId, body.artistKey, body.vote);
        return send(res, 200, { ok: true, crowd: svc.crowd.forArtist(body.artistKey) ?? null });
      }

      if (req.method === "GET" && url.pathname === "/api/blocklist") {
        const list = svc.crowd.blocklist();
        if (url.searchParams.get("format") === "txt") {
          return send(res, 200, list.map((a) => `${a.key}\t${a.name}`).join("\n") + "\n", "text/plain; charset=utf-8");
        }
        return send(res, 200, { artists: list });
      }

      throw new HttpError(404, "Not found");
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: "Internal error" });
    }
  });
}
