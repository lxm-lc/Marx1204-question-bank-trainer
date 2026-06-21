from __future__ import annotations

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import argparse
import mimetypes


PROJECT_ROOT = Path(__file__).resolve().parent


class FixedMimeHandler(SimpleHTTPRequestHandler):
    # Force modern frontend file types to use safe MIME mappings even if the
    # local Windows registry or Python mimetypes database is misconfigured.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/markdown; charset=utf-8",
        ".svg": "image/svg+xml",
    }

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def build_handler(directory: Path):
    mimetypes.add_type("text/javascript", ".js")
    mimetypes.add_type("text/javascript", ".mjs")
    mimetypes.add_type("text/css", ".css")
    mimetypes.add_type("application/json", ".json")
    return partial(FixedMimeHandler, directory=str(directory))


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the local quiz app with fixed MIME types.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()

    handler = build_handler(PROJECT_ROOT)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving {PROJECT_ROOT} at http://{args.host}:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
