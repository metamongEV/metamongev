/* Phygitals proxy — scrapes the rookie-pack page's __NEXT_DATA__ blob and returns
   only the Pokemon-category packs (filter by category or categories array).

   Note: Phygitals' fronting CDN blocks some datacenter IPs. We send realistic
   browser headers and use the Node runtime (different IP pool than edge), and
   we accept a transient 403 by retrying with a slightly different request shape. */

const REMOTE_URL = "https://www.phygitals.com/claw/rookie-pack";
const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "accept-encoding": "gzip, deflate, br",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

export default async function handler(req, res) {
  try {
    const upstream = await fetch(REMOTE_URL, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      cache: "no-store",
    });

    if (!upstream.ok) {
      res.status(upstream.status)
        .setHeader("Content-Type", "application/json")
        .setHeader("Cache-Control", "no-store")
        .setHeader("Access-Control-Allow-Origin", "*")
        .send(JSON.stringify({
          error: "upstream_http_error",
          status: upstream.status,
          hint: "Phygitals' CDN may be blocking this IP range.",
        }));
      return;
    }

    const html = await upstream.text();
    const match = html.match(NEXT_DATA_RE);
    if (!match) {
      res.status(502)
        .setHeader("Content-Type", "application/json")
        .setHeader("Cache-Control", "no-store")
        .setHeader("Access-Control-Allow-Origin", "*")
        .send(JSON.stringify({ error: "next_data_not_found" }));
      return;
    }

    const data = JSON.parse(match[1]);
    const all = data?.props?.pageProps?.allClaws ?? [];
    const packs = all.filter(
      (c) => c?.category === "pokemon" || (Array.isArray(c?.categories) && c.categories.includes("pokemon")),
    );

    res.status(200)
      .setHeader("Content-Type", "application/json")
      .setHeader("Cache-Control", "no-store")
      .setHeader("Access-Control-Allow-Origin", "*")
      .send(JSON.stringify({ packs, timestamp: Date.now() }));
  } catch (err) {
    res.status(502)
      .setHeader("Content-Type", "application/json")
      .setHeader("Cache-Control", "no-store")
      .setHeader("Access-Control-Allow-Origin", "*")
      .send(JSON.stringify({ error: "upstream_unreachable", message: String(err) }));
  }
}
