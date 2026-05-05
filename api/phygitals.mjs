/* Phygitals proxy — scrapes the rookie-pack page's __NEXT_DATA__ blob and returns
   only the Pokemon-category packs (filter by category or categories array). */

const REMOTE_URL = "https://www.phygitals.com/claw/rookie-pack";
const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

export const config = { runtime: "edge" };

export default async function handler() {
  try {
    const upstream = await fetch(REMOTE_URL, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; metamongEV/1.0)",
        "accept": "text/html,application/xhtml+xml",
      },
      cache: "no-store",
    });

    if (!upstream.ok) {
      return Response.json(
        { error: "upstream_http_error", status: upstream.status },
        { status: upstream.status, headers: corsHeaders() },
      );
    }

    const html = await upstream.text();
    const match = html.match(NEXT_DATA_RE);
    if (!match) {
      return Response.json(
        { error: "next_data_not_found" },
        { status: 502, headers: corsHeaders() },
      );
    }

    const data = JSON.parse(match[1]);
    const all = data?.props?.pageProps?.allClaws ?? [];
    const packs = all.filter(
      (c) => c?.category === "pokemon" || (Array.isArray(c?.categories) && c.categories.includes("pokemon")),
    );

    return new Response(
      JSON.stringify({ packs, timestamp: Date.now() }),
      { status: 200, headers: corsHeaders() },
    );
  } catch (err) {
    return Response.json(
      { error: "upstream_unreachable", message: String(err) },
      { status: 502, headers: corsHeaders() },
    );
  }
}

function corsHeaders() {
  return {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };
}
