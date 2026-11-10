#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一个假的 IMAP 服务器，用来在没有真实邮箱的情况下端到端测试 MailPin 的收取逻辑。

启动： python3 tests/fake_imap.py 11430
账号： test@example.com / secret
"""
import base64
import socketserver
import sys
import threading
from datetime import datetime, timedelta

USER = "test@example.com"
PASSWORD = "secret"


def b64(text: str, charset: str = "utf-8") -> str:
    return "=?%s?B?%s?=" % (charset.upper(), base64.b64encode(text.encode(charset)).decode())


def date_ago(days: float, hour: int = 9) -> str:
    moment = datetime.now() - timedelta(days=days)
    moment = moment.replace(hour=hour, minute=12, second=33)
    return moment.strftime("%a, %d %b %Y %H:%M:%S +0800")


def header(from_line: str, subject: str, date: str, charset: str = "utf-8") -> bytes:
    text = "From: %s\r\nSubject: %s\r\nDate: %s\r\n" % (from_line, subject, date)
    return text.encode(charset, "surrogateescape")


# 未读邮件：覆盖 UTF-8 Base64、GB2312 编码字、裸地址、以及未编码的 GB2312 原始字节
MESSAGES = {
    12: header(b64("张老师") + " <zhang.prof@university.edu.cn>",
               b64("关于毕业设计开题报告的修改意见"),
               date_ago(1)),
    13: header("\"=?gb2312?B?%s?=\" <newsletter@qq.com>" % base64.b64encode("李老师".encode("gb2312")).decode(),
               b64("本周课程安排已更新"),
               date_ago(3, hour=8)),
    14: header("notices@github.com",
               "[GitHub] A new sign-in to your account",
               date_ago(10, hour=22)),
    15: header("王老师 <wang@example.com>",
               "明天上午九点组会，请带上实验记录",
               date_ago(20, hour=17),
               charset="gb2312"),
}

SEEN = set()  # 已读的 UID


class Handler(socketserver.StreamRequestHandler):
    def send_line(self, text: str) -> None:
        self.wfile.write((text + "\r\n").encode())
        self.wfile.flush()

    def handle(self):
        self.send_line("* OK [CAPABILITY IMAP4rev1 ID] Fake IMAP ready")
        while True:
            line = self.rfile.readline()
            if not line:
                return
            text = line.decode("utf-8", "replace").rstrip("\r\n")
            if not text:
                continue
            parts = text.split(" ", 2)
            if len(parts) < 2:
                continue
            tag, command = parts[0], parts[1].upper()
            rest = parts[2] if len(parts) > 2 else ""

            if command == "CAPABILITY":
                self.send_line("* CAPABILITY IMAP4rev1 ID")
                self.send_line(f"{tag} OK CAPABILITY completed")
            elif command == "LOGIN":
                if USER in rest and PASSWORD in rest:
                    self.send_line(f"{tag} OK LOGIN completed")
                else:
                    self.send_line(f"{tag} NO [AUTHENTICATIONFAILED] Invalid credentials")
            elif command == "ID":
                self.send_line('* ID ("name" "FakeIMAP")')
                self.send_line(f"{tag} OK ID completed")
            elif command == "SELECT":
                self.send_line("* 42 EXISTS")
                self.send_line("* 0 RECENT")
                self.send_line("* OK [UIDVALIDITY 1] UIDs valid")
                self.send_line(f"{tag} OK [READ-WRITE] SELECT completed")
            elif command == "UID" and rest.upper().startswith("SEARCH"):
                ids = sorted(uid for uid in MESSAGES if uid not in SEEN)
                self.send_line("* SEARCH " + " ".join(str(i) for i in ids))
                self.send_line(f"{tag} OK SEARCH completed")
            elif command == "UID" and "FETCH" in rest.upper():
                requested = rest.split()[1]
                wanted = []
                for chunk in requested.split(","):
                    if "-" in chunk:
                        start, end = chunk.split("-")
                        wanted.extend(range(int(start), int(end) + 1))
                    else:
                        wanted.append(int(chunk))
                for index, uid in enumerate(wanted, start=1):
                    body = MESSAGES.get(uid)
                    if body is None:
                        continue
                    self.wfile.write(
                        ("* %d FETCH (UID %d BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {%d}\r\n"
                         % (index, uid, len(body))).encode()
                    )
                    self.wfile.write(body)
                    self.wfile.write(b")\r\n")
                    self.wfile.flush()
                self.send_line(f"{tag} OK FETCH completed")
            elif command == "UID" and "STORE" in rest.upper():
                # 把未读标记为已读
                ids = rest.split()[1].split(",")
                for chunk in ids:
                    try:
                        SEEN.add(int(chunk))
                    except ValueError:
                        pass
                self.send_line(f"{tag} OK STORE completed")
            elif command == "LOGOUT":
                self.send_line("* BYE logging out")
                self.send_line(f"{tag} OK LOGOUT completed")
                return
            elif command == "NOOP":
                self.send_line(f"{tag} OK NOOP completed")
            else:
                self.send_line(f"{tag} BAD Unsupported command {command}")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11430
    server = Server(("127.0.0.1", port), Handler)
    print(f"fake IMAP listening on 127.0.0.1:{port}", flush=True)
    threading.Timer(600, server.shutdown).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
