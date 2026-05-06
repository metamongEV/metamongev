/* Presence counter — uses the Upstash Redis REST API directly so we don't
   pull in the @vercel/kv SDK. Stores active sessions in a sorted set keyed
   by session id with the current timestamp as the score; cleanup happens
   inline on every request. */

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KEY = "presence:active";
const TTL_MS = 60_000;          // a session counts as "online" if heartbeat in last 60s
const KEY_TTL_SECONDS = 600;    // garbage-collect the whole key after 10m of total silence
const MAX_SID_LEN = 64;

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  // Fallback for raw streams (Node runtime, no auto-parse)
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

async function pipeline(commands) {
  const resp = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KV_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  return resp.json();
}

function commonHeaders(res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
}

export default async function handler(req, res) {
  commonHeaders(res);

  if (!KV_URL || !KV_TOKEN) {
    res.status(500).send(JSON.stringify({
      error: "missing_env",
      message: "KV_REST_API_URL / KV_REST_API_TOKEN env vars not set on this deployment.",
    }));
    return;
  }

  const now = Date.now();
  const cutoff = now - TTL_MS;

  try {
    let commands;
    if (req.method === "POST") {
      const body = await readJson(req);
      const sid = body?.sid;
      if (!sid || typeof sid !== "string" || sid.length > MAX_SID_LEN) {
        res.status(400).send(JSON.stringify({ error: "bad_sid" }));
        return;
      }
      commands = [
        ["ZADD", KEY, now.toString(), sid],
        ["ZREMRANGEBYSCORE", KEY, "0", cutoff.toString()],
        ["EXPIRE", KEY, KEY_TTL_SECONDS.toString()],
        ["ZCARD", KEY],
      ];
    } else if (req.method === "GET") {
      commands = [
        ["ZREMRANGEBYSCORE", KEY, "0", cutoff.toString()],
        ["ZCARD", KEY],
      ];
    } else {
      res.status(405).send(JSON.stringify({ error: "method_not_allowed" }));
      return;
    }

    const results = await pipeline(commands);
    const last = results[results.length - 1];
    const count = (last && (last.result ?? last)) ?? 0;
    res.status(200).send(JSON.stringify({
      count: Number.isFinite(Number(count)) ? Number(count) : 0,
      timestamp: now,
    }));
  } catch (err) {
    res.status(502).send(JSON.stringify({
      error: "upstream_error",
      message: String(err?.message || err),
    }));
  }
}
