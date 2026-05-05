const REMOTE_URL = "https://beezie-giyu.vercel.app/api/claws";

export const config = { runtime: "edge" };

export default async function handler() {
  try {
    const upstream = await fetch(REMOTE_URL, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; BeezieEvMirror/1.0)",
        accept: "application/json",
      },
      cache: "no-store",
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "upstream_unreachable", message: String(err) }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
}
