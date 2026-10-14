import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { openDb } from "./db.js";
import { ScoreService, defaultDeps } from "./service.js";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const dbPath = process.env.DB_PATH ?? "aid.sqlite";
const defaultStatic = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticDir = process.env.STATIC_DIR ?? (existsSync(defaultStatic) ? defaultStatic : undefined);

const svc = new ScoreService(openDb(dbPath), defaultDeps());
createApp(svc, { staticDir, trustProxy: process.env.TRUST_PROXY === "1" }).listen(port, host, () =>
  console.log(`AI detector on http://${host}:${port} (db: ${dbPath}${staticDir ? `, web: ${staticDir}` : ", no web build found"})`),
);
