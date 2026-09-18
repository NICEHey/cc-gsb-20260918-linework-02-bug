#!/usr/bin/env python3
"""服务器冒烟自测（纯标准库）：启动 server.py，校验路由、MIME、目录穿越防护。"""

import http.client
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def request(port, raw_path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    conn.request("GET", raw_path)
    resp = conn.getresponse()
    body = resp.read()
    ctype = resp.getheader("Content-Type", "")
    conn.close()
    return resp.status, ctype, body


def main():
    port = free_port()
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", str(port)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    failures = []
    try:
        for _ in range(50):
            try:
                request(port, "/")
                break
            except OSError:
                time.sleep(0.1)
        else:
            failures.append("服务器未能在 5 秒内启动")

        if not failures:
            cases = [
                ("/", 200, "text/html"),
                ("/topology.js", 200, "text/javascript"),
                ("/app.js", 200, "text/javascript"),
                ("/workbench.js", 200, "text/javascript"),
                ("/app.css", 200, "text/css"),
                ("/fixtures/cases.json", 200, "application/json"),
                ("/fixtures/format.md", 200, "text/markdown"),
                ("/does-not-exist", 404, None),
                ("/../server.py", 403, None),
                ("/fixtures/..%2fserver.py", 403, None),
                ("/static/../server.py", 403, None),
            ]
            for path, want_status, want_ctype in cases:
                try:
                    status, ctype, body = request(port, path)
                except Exception as exc:  # 连接异常也算失败
                    failures.append(f"{path}: 请求异常 {exc}")
                    continue
                if status != want_status:
                    failures.append(f"{path}: 状态码 {status} != {want_status}")
                if want_ctype and want_ctype not in ctype:
                    failures.append(f"{path}: Content-Type {ctype!r} 不含 {want_ctype!r}")
                if path == "/" and b"topology.js" not in body:
                    failures.append("/: 首页未引用 topology.js")
                if path == "/fixtures/cases.json" and b"cross" not in body:
                    failures.append("cases.json 内容异常")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()

    if failures:
        print("服务器冒烟测试失败：")
        for f in failures:
            print("  ✗", f)
        return 1
    print("服务器冒烟测试全部通过（11 项）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
