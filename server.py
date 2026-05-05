import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

HOST = "127.0.0.1"
PORT = 8000
ROOT = Path(__file__).resolve().parent

CLAWS_URL = "https://beezie-giyu.vercel.app/api/claws"


def fetch_remote(url):
    request = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; BeezieEvMirror/1.0)",
            "Accept": "application/json",
        },
    )
    with urlopen(request, timeout=20) as response:
        return response.status, response.read()


class BeezieHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/claws":
            self.proxy(CLAWS_URL)
            return
        super().do_GET()

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/claws":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            return
        super().do_HEAD()

    def proxy(self, url):
        try:
            status, payload = fetch_remote(url)
        except HTTPError as error:
            payload = error.read() if error.fp else b""
            self.send_response(error.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        except URLError as error:
            body = json.dumps({"error": "upstream_unreachable", "message": str(error.reason)}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def main():
    server = ThreadingHTTPServer((HOST, PORT), BeezieHandler)
    print(f"Beezie EV mirror running at http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
