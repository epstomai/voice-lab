#!/usr/bin/env python3
"""本地静态服务器，用于运行「谐波」实时嗓音分析器。

getUserMedia（麦克风）要求安全上下文。http://localhost 被浏览器视为安全，
因此本脚本默认绑定 127.0.0.1，可直接获取麦克风权限——无需配置 HTTPS。

用法:
    python serve.py            # 启动并自动打开浏览器，端口 8000
    python serve.py 8080       # 指定端口
    python serve.py --no-open  # 不自动打开浏览器
"""
import http.server
import socketserver
import sys
import threading
import webbrowser
from functools import partial
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
    }

    def end_headers(self):
        # 禁用缓存，方便开发时即时看到改动
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 安静模式


def main():
    port = 8000
    auto_open = True
    for arg in sys.argv[1:]:
        if arg == "--no-open":
            auto_open = False
        elif arg.isdigit():
            port = int(arg)

    handler = partial(Handler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://localhost:{port}/"
        print(f"谐波分析器已启动: {url}")
        print("按 Ctrl+C 停止。")
        if auto_open:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")


if __name__ == "__main__":
    main()
