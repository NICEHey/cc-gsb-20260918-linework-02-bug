#!/usr/bin/env python3
"""线稿拓扑修复与路径提取工作台 — 纯标准库静态服务器。

默认监听 127.0.0.1:8080：
    python3 server.py
    python3 server.py --host 0.0.0.0 --port 8000

URL 映射：
    /                  -> static/index.html
    /<文件>            -> static/<文件>
    /fixtures/<文件>   -> fixtures/<文件>

仅使用标准库，无第三方包、CDN 或外部接口。
"""

import argparse
import os
import sys
from functools import partial
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
FIXTURES_DIR = os.path.join(BASE_DIR, "fixtures")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def resolve_url_path(url_path):
    """把 URL 路径映射到磁盘文件，防目录穿越。返回绝对路径或 None。"""
    parts = [p for p in unquote(url_path).split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return None

    if parts and parts[0] == "fixtures":
        rel = os.path.join(*parts[1:]) if len(parts) > 1 else ""
        candidate = os.path.normpath(os.path.join(FIXTURES_DIR, rel)) if rel else FIXTURES_DIR
        root = FIXTURES_DIR
    else:
        rel = os.path.join(*parts) if parts else "index.html"
        candidate = os.path.normpath(os.path.join(STATIC_DIR, rel))
        root = STATIC_DIR

    # 必须仍在对应根目录之内
    if not (candidate == root or candidate.startswith(root + os.sep)):
        return None
    if os.path.isdir(candidate):
        candidate = os.path.join(candidate, "index.html")
    return candidate


class WorkbenchHandler(BaseHTTPRequestHandler):
    server_version = "LineartWorkbench/1.0"

    def do_GET(self):
        path = urlsplit(self.path).path
        if path in ("/", ""):
            path = "/index.html"

        file_path = resolve_url_path(path)
        if file_path is None:
            self.send_error(HTTPStatus.FORBIDDEN, "Forbidden path")
            return
        if not os.path.isfile(file_path):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        try:
            with open(file_path, "rb") as fh:
                body = fh.read()
        except OSError:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "读取失败")
            return

        ext = os.path.splitext(file_path)[1].lower()
        ctype = CONTENT_TYPES.get(ext, "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def do_HEAD(self):
        # 与 GET 相同的头部，但不写正文
        path = urlsplit(self.path).path
        if path in ("/", ""):
            path = "/index.html"
        file_path = resolve_url_path(path)
        if file_path is None or not os.path.isfile(file_path):
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        ext = os.path.splitext(file_path)[1].lower()
        size = os.path.getsize(file_path)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(size))
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="线稿拓扑修复与路径提取工作台静态服务器")
    parser.add_argument("--host", default="127.0.0.1",
                        help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=8080,
                        help="监听端口（默认 8080）")
    args = parser.parse_args(argv)

    if not (0 <= args.port <= 65535):
        parser.error("端口必须在 0～65535 之间")

    for d in (STATIC_DIR, FIXTURES_DIR):
        if not os.path.isdir(d):
            sys.stderr.write("缺少目录: %s\n" % d)
            return 1

    handler = partial(WorkbenchHandler)
    httpd = ThreadingHTTPServer((args.host, args.port), handler)
    url_host = args.host if args.host not in ("0.0.0.0", "") else "127.0.0.1"
    print("线稿拓扑工作台已启动： http://%s:%d/" % (url_host, args.port))
    print("按 Ctrl+C 停止。")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭……")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
