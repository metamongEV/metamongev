import json
import re
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = 8000
ROOT = Path(__file__).resolve().parent

CLAWS_URL = "https://beezie-giyu.vercel.app/api/claws"
PHYGITALS_URL = "https://www.phygitals.com/claw/rookie-pack"
NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">([\s\S]*?)</script>'
)


def fetch_remote(url, accept="application/json"):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; metamongEV/1.0)",
            "Accept": accept,
        },
    )
    with urlopen(request, timeout=20) as response:
        return response.status, response.read()


def build_phygitals_payload():
    status, body = fetch_remote(PHYGITALS_URL, accept="text/html,application/xhtml+xml")
    if status != 200:
        return status, json.dumps({"error": "upstream_http_error", "status": status}).encode("utf-8")
    html = body.decode("utf-8", errors="replace")
    m = NEXT_DATA_RE.search(html)
    if not m:
        return 502, json.dumps({"error": "next_data_not_found"}).encode("utf-8")
    data = json.loads(m.group(1))
    all_claws = data.get("props", {}).get("pageProps", {}).get("allClaws", []) or []
    packs = [
        c for c in all_claws
        if c.get("category") == "pokemon"
        or "pokemon" in (c.get("categories") or [])
    ]
    return 200, json.dumps({"packs": packs, "timestamp": int(time.time() * 1000)}).encode("utf-8")


class MetamongHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/claws":
            self.proxy(CLAWS_URL)
            return
        if parsed.path == "/api/phygitals":
            self.proxy_phygitals()
            return
        if parsed.path == "/api/presence":
            self.mock_presence()
            return
        super().do_GET()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/presence":
            # Drain any body so the connection closes cleanly
            length = int(self.headers.get("Content-Length", "0") or "0")
            if length:
                try:
                    self.rfile.read(length)
                except Exception:
                    pass
            self.mock_presence()
            return
        self.send_response(405)
        self.end_headers()

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path in ("/api/claws", "/api/phygitals", "/api/presence"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        super().do_HEAD()

    def mock_presence(self):
        """Local dev: return mock count of 1 (just you). The real presence
        counter only works on the deployed Vercel app where Upstash creds are
        injected as env vars. Run `vercel env pull` if you want real data
        locally."""
        import time as _t
        body = json.dumps({"count": 1, "timestamp": int(_t.time() * 1000), "mock": True}).encode("utf-8")
        self._send_json(200, body)

    def _send_json(self, status, payload):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def proxy(self, url):
        try:
            status, payload = fetch_remote(url)
        except HTTPError as error:
            payload = error.read() if error.fp else b""
            self._send_json(error.code, payload)
            return
        except URLError as error:
            body = json.dumps({"error": "upstream_unreachable", "message": str(error.reason)}).encode("utf-8")
            self._send_json(502, body)
            return
        self._send_json(status, payload)

    def proxy_phygitals(self):
        try:
            status, payload = build_phygitals_payload()
            self._send_json(status, payload)
        except HTTPError as error:
            payload = json.dumps({"error": "upstream_http_error", "status": error.code}).encode("utf-8")
            self._send_json(error.code, payload)
        except URLError as error:
            body = json.dumps({"error": "upstream_unreachable", "message": str(error.reason)}).encode("utf-8")
            self._send_json(502, body)
        except (ValueError, KeyError) as error:
            self._send_json(502, json.dumps({"error": "parse_failed", "message": str(error)}).encode("utf-8"))


def main():
    server = ThreadingHTTPServer((HOST, PORT), MetamongHandler)
    print(f"metamongEV running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
