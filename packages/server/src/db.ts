import { DatabaseSync } from "node:sqlite";

export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS votes (
      user_id TEXT NOT NULL,
      artist_key TEXT NOT NULL,
      vote TEXT NOT NULL CHECK (vote IN ('ai','human')),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, artist_key)
    );
    CREATE INDEX IF NOT EXISTS votes_artist ON votes(artist_key);
    CREATE TABLE IF NOT EXISTS artists (
      artist_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      label TEXT
    );
    CREATE INDEX IF NOT EXISTS artists_label ON artists(label);
    CREATE TABLE IF NOT EXISTS cache (
      k TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      ts INTEGER NOT NULL
    );
  `);
  return db;
}

export function cacheGet<T>(db: DatabaseSync, key: string, maxAgeMs: number, now = Date.now()): T | undefined {
  const row = db.prepare("SELECT json, ts FROM cache WHERE k = ?").get(key) as { json: string; ts: number } | undefined;
  if (!row || now - row.ts > maxAgeMs) return undefined;
  return JSON.parse(row.json) as T;
}

export function cacheSet(db: DatabaseSync, key: string, value: unknown, now = Date.now()): void {
  db.prepare("INSERT OR REPLACE INTO cache (k, json, ts) VALUES (?, ?, ?)").run(key, JSON.stringify(value), now);
}

/** Like cacheGet, but also returns when the entry was written so callers can apply their own expiry. */
export function cacheEntry<T>(db: DatabaseSync, key: string): { value: T; ts: number } | undefined {
  const row = db.prepare("SELECT json, ts FROM cache WHERE k = ?").get(key) as { json: string; ts: number } | undefined;
  return row ? { value: JSON.parse(row.json) as T, ts: row.ts } : undefined;
}
