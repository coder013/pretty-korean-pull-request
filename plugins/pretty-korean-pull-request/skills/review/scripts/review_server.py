#!/usr/bin/env python3
"""review 스킬의 로컬 리뷰 페이지 서버와 명령줄 도구.

서버는 127.0.0.1에만 바인딩하고, 경로에 넣은 토큰이 맞는 요청에만 응답한다.
스킬은 아래 하위 명령으로 서버와 주고받는다. 모든 명령은 결과를 JSON 한 줄로 출력한다.

  start --repo <r> --viewer <login>      gh pr list 출력을 표준 입력으로 받아 서버를 띄우고 브라우저를 연다
  wait --dir <dir>                       페이지에서 사용자가 한 다음 동작을 기다린다
  reviewing --dir <dir> --number <n>     리뷰 중 화면으로 바꾼다
  feedback --dir <dir> --review <file> --diff <file>
                                         피드백 편집 화면을 보여 준다
  done --dir <dir> --url <url>           게시 결과를 보여 주고 서버를 끝낸다
  error --dir <dir> --message <text>     오류를 보여 주고 서버를 끝낸다
  stop --dir <dir>                       서버를 끝낸다
  ranges --diff <file>                   파일별로 코멘트를 달 수 있는 줄 범위를 출력한다

외부 패키지 없이 표준 라이브러리만 쓴다.
"""

import argparse
import json
import os
import re
import secrets
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAGE = HERE.parent / "assets" / "review.html"

SEVERITIES = ["버그", "제안", "질문", "사소"]
EVENTS = ["COMMENT", "REQUEST_CHANGES", "APPROVE"]
TERMINAL = {"done", "error", "closed"}

IDLE_SECONDS = float(os.environ.get("PKR_IDLE_SECONDS", 30 * 60))
LINGER_SECONDS = float(os.environ.get("PKR_LINGER_SECONDS", 5))
LINGER_MAX_SECONDS = float(os.environ.get("PKR_LINGER_MAX_SECONDS", 60))
MAX_BODY = 64 * 1024 * 1024

CSP = (
    "default-src 'self'; style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
)

HUNK = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)")


# ---------------------------------------------------------------- diff


def parse_diff(text):
    """unified diff를 {경로: [hunk]}로 나눈다. 삭제된 파일은 뺀다.

    hunk는 {header, newStart, newCount, lines: [{t, o, n, s}]}이고,
    t는 '+', '-', ' ' 가운데 하나, o와 n은 바뀌기 전과 뒤의 줄 번호(없으면 None)다.
    """
    files = {}
    path = None
    hunk = None
    old_left = new_left = 0
    old_no = new_no = 0
    for raw in text.splitlines():
        if hunk is not None and (old_left > 0 or new_left > 0):
            if raw.startswith("\\"):
                continue
            mark, body = (raw[:1] or " "), raw[1:]
            if mark == "+":
                hunk["lines"].append({"t": "+", "o": None, "n": new_no, "s": body})
                new_no += 1
                new_left -= 1
            elif mark == "-":
                hunk["lines"].append({"t": "-", "o": old_no, "n": None, "s": body})
                old_no += 1
                old_left -= 1
            else:
                hunk["lines"].append({"t": " ", "o": old_no, "n": new_no, "s": body})
                old_no += 1
                new_no += 1
                old_left -= 1
                new_left -= 1
            continue

        hunk = None
        if raw.startswith("diff --git "):
            path = None
        elif raw.startswith("+++ "):
            path = None if raw.strip() == "+++ /dev/null" else raw[6:]
        else:
            m = HUNK.match(raw)
            if m and path:
                old_no, new_no = int(m.group(1)), int(m.group(3))
                old_left = int(m.group(2) if m.group(2) is not None else 1)
                new_left = int(m.group(4) if m.group(4) is not None else 1)
                hunk = {
                    "header": raw,
                    "newStart": new_no,
                    "newCount": new_left,
                    "lines": [],
                }
                files.setdefault(path, []).append(hunk)
    return files


def ranges_of(files):
    """hunk에서 코멘트를 달 수 있는 줄 범위(바뀐 뒤 기준)를 구한다."""
    ranges = {}
    for path, hunks in files.items():
        for h in hunks:
            if h["newCount"]:
                ranges.setdefault(path, []).append([h["newStart"], h["newStart"] + h["newCount"] - 1])
    return ranges


def out_of_range(review, ranges):
    """diff 범위 밖을 가리키는 피드백을 '경로:줄' 목록으로 돌려준다."""
    bad = []
    for item in review.get("items", []):
        start = item.get("startLine") or item["line"]
        spans = ranges.get(item["path"], [])
        if not any(lo <= start and item["line"] <= hi for lo, hi in spans):
            bad.append(f"{item['path']}:{item['line']}")
    return bad


# ---------------------------------------------------------------- 게시 요청


class Invalid(ValueError):
    pass


def build_payload(review, choice):
    """페이지에서 받은 선택과 편집 내용으로 GitHub 리뷰 API 요청 본문을 만든다."""
    items = {item["id"]: item for item in review["items"]}
    comments = []
    for chosen in choice.get("comments", []):
        item = items.get(chosen.get("id"))
        if item is None:
            raise Invalid("없는 피드백을 게시하려고 했습니다.")
        body = str(chosen.get("body", "")).strip()
        if not body:
            raise Invalid(f"{item['path']}:{item['line']} 피드백의 본문이 비어 있습니다.")
        suggestion = str(chosen.get("suggestion", "")).rstrip("\n")
        text = f"**[{item['severity']}]** {body}"
        if suggestion.strip():
            text += f"\n\n```suggestion\n{suggestion}\n```"
        comment = {"path": item["path"], "line": item["line"], "side": "RIGHT", "body": text}
        start = item.get("startLine")
        if start and start != item["line"]:
            comment["start_line"] = start
            comment["start_side"] = "RIGHT"
        comments.append(comment)

    summary = str(choice.get("summary", "")).strip()
    if not comments and not summary:
        raise Invalid("게시할 피드백과 전체 의견이 없습니다.")
    event = "COMMENT" if review.get("isOwnPr") else choice.get("event")
    if event not in EVENTS:
        raise Invalid("리뷰 결과가 올바르지 않습니다.")

    payload = {"commit_id": review["headSha"], "event": event, "comments": comments}
    if summary:
        payload["body"] = summary
    return payload


# ---------------------------------------------------------------- 서버


class Session:
    """서버가 들고 있는 화면 상태와, 스킬에 넘길 이벤트 큐."""

    def __init__(self, folder, data):
        self.dir = Path(folder)
        self.lock = threading.Condition()
        self.version = 1
        self.phase = "list"
        self.repo = data.get("repo", "")
        self.prs = data.get("prs", [])
        self.number = None
        self.review = None
        self.files = None
        self.url = None
        self.message = None
        self.events = []
        self.seen = 0
        self.last_page = time.monotonic()
        self.ended_at = None

    # 스킬과 페이지 양쪽에서 부른다. 모두 lock 안에서 실행한다.
    def set_phase(self, phase, **fields):
        self.phase = phase
        for key, value in fields.items():
            setattr(self, key, value)
        self.version += 1
        if phase in TERMINAL and self.ended_at is None:
            self.ended_at = time.monotonic()
        self.lock.notify_all()

    def push(self, event):
        self.events.append(event)
        self.lock.notify_all()

    def state(self):
        state = {"version": self.version, "phase": self.phase, "repo": self.repo}
        if self.phase == "list":
            state["prs"] = self.prs
        if self.number is not None:
            state["number"] = self.number
            pr = next((p for p in self.prs if p.get("number") == self.number), None)
            if pr:
                state["title"] = pr.get("title", "")
        if self.phase in ("feedback", "posting") and self.review is not None:
            state["review"] = self.review
            state["files"] = self.files
        if self.url:
            state["url"] = self.url
        if self.message:
            state["message"] = self.message
        return state


class Handler(BaseHTTPRequestHandler):
    server_version = "pretty-korean-review"
    sys_version = ""

    def log_message(self, *args):
        pass

    # ------------------------------------------------------------ 응답

    def send(self, status, body=b"", content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, status, value):
        self.send(status, json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def reject(self, status=404):
        self.send(status, b"", "text/plain; charset=utf-8")

    # ------------------------------------------------------------ 검사

    def route(self):
        """토큰을 확인하고 (영역, 이름)을 돌려준다. 토큰이 틀리면 None."""
        app = self.server.app
        host = self.headers.get("Host", "")
        if host != f"127.0.0.1:{app['port']}":
            return None
        parts = self.path.split("?", 1)[0].split("/")
        # ['', 't', token, area, name]
        if len(parts) < 4 or parts[1] != "t" or not secrets.compare_digest(parts[2], app["token"]):
            return None
        area = parts[3]
        name = parts[4] if len(parts) > 4 else ""
        return area, name

    def origin_ok(self, control):
        app = self.server.app
        origin = self.headers.get("Origin")
        if control:
            # 스킬 쪽 명령은 브라우저가 아니므로 Origin이 없고, 전용 헤더를 붙인다.
            # 다른 사이트의 페이지는 이 헤더를 붙이면 사전 요청(preflight)에서 막힌다.
            return origin is None and self.headers.get("X-Review-Control") == "1"
        return origin == f"http://127.0.0.1:{app['port']}"

    def body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise Invalid("요청이 너무 큽니다.")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            value = json.loads(raw.decode("utf-8"))
        except ValueError as e:
            raise Invalid("JSON 형식이 아닙니다.") from e
        if not isinstance(value, dict):
            raise Invalid("JSON 객체가 아닙니다.")
        return value

    # ------------------------------------------------------------ GET

    def do_GET(self):
        route = self.route()
        if route is None:
            return self.reject()
        area, name = route
        session = self.server.session

        if area == "":
            with session.lock:
                session.last_page = time.monotonic()
            return self.send(200, PAGE.read_bytes(), "text/html; charset=utf-8")

        if area == "api" and name == "state":
            with session.lock:
                session.last_page = time.monotonic()
                session.seen = session.version
                state = session.state()
            return self.send_json(200, state)

        if area == "ctl" and name == "event" and self.headers.get("X-Review-Control") == "1":
            timeout = 25.0
            m = re.search(r"timeout=([\d.]+)", self.path)
            if m:
                timeout = min(float(m.group(1)), 60.0)
            with session.lock:
                session.lock.wait_for(lambda: session.events, timeout=timeout)
                event = session.events.pop(0) if session.events else None
            if event is None:
                return self.send(204)
            return self.send_json(200, event)

        return self.reject()

    def do_HEAD(self):
        self.do_GET()

    # ------------------------------------------------------------ POST

    def do_POST(self):
        route = self.route()
        if route is None:
            return self.reject()
        area, name = route
        if area not in ("api", "ctl"):
            return self.reject()
        if not self.origin_ok(control=(area == "ctl")):
            return self.reject(403)
        try:
            data = self.body()
            handler = getattr(self, f"{area}_{name}", None)
            if handler is None:
                return self.reject()
            with self.server.session.lock:
                if area == "api":
                    self.server.session.last_page = time.monotonic()
                result = handler(self.server.session, data)
            return self.send_json(200, result or {"ok": True})
        except Invalid as e:
            return self.send_json(400, {"ok": False, "error": str(e)})

    # 페이지에서 오는 요청 ------------------------------------------------

    def api_select(self, s, data):
        if s.phase != "list":
            raise Invalid("PR을 고를 수 있는 단계가 아닙니다.")
        number = data.get("number")
        if not any(p.get("number") == number for p in s.prs):
            raise Invalid("목록에 없는 PR입니다.")
        s.set_phase("reviewing", number=number)
        s.push({"type": "select", "number": number})

    def api_publish(self, s, data):
        if s.phase != "feedback":
            raise Invalid("게시할 수 있는 단계가 아닙니다.")
        payload = build_payload(s.review, data)
        file = s.dir / "payload.json"
        file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        s.set_phase("posting")
        s.push(
            {
                "type": "publish",
                "repo": s.review["repo"],
                "number": s.review["number"],
                "payload": str(file),
                "comments": len(payload["comments"]),
            }
        )

    def api_cancel(self, s, data):
        if s.phase in TERMINAL or s.phase == "posting":
            raise Invalid("취소할 수 있는 단계가 아닙니다.")
        s.set_phase("closed", message="리뷰를 취소했습니다. 아무것도 게시하지 않았습니다.")
        s.seen = s.version
        s.push({"type": "cancel"})

    def api_close(self, s, data):
        if s.phase in TERMINAL or s.phase == "posting":
            raise Invalid("닫을 수 있는 단계가 아닙니다.")
        s.set_phase("closed", message="리뷰 페이지를 닫았습니다.")
        s.seen = s.version
        s.push({"type": "close"})

    # 스킬에서 오는 요청 -------------------------------------------------

    def alive(self, s):
        if s.phase in TERMINAL:
            raise Invalid("리뷰가 이미 끝났습니다.")

    def ctl_reviewing(self, s, data):
        self.alive(s)
        s.set_phase("reviewing", number=data.get("number", s.number))

    def ctl_feedback(self, s, data):
        self.alive(s)
        review = data.get("review")
        if not isinstance(review, dict) or not isinstance(review.get("items"), list):
            raise Invalid("review 형식이 올바르지 않습니다.")
        for item in review["items"]:
            if item.get("severity") not in SEVERITIES:
                raise Invalid(f"심각도가 올바르지 않습니다: {item.get('severity')}")
        files = parse_diff(data.get("diff", ""))
        bad = out_of_range(review, ranges_of(files))
        if bad:
            raise Invalid("diff 범위 밖을 가리키는 피드백이 있습니다: " + ", ".join(bad))
        wanted = {item["path"] for item in review["items"]}
        shown = {path: hunks for path, hunks in files.items() if path in wanted}
        s.set_phase("feedback", review=review, files=shown, number=review.get("number", s.number))

    def ctl_done(self, s, data):
        s.set_phase("done", url=data.get("url"))

    def ctl_error(self, s, data):
        s.set_phase("error", message=data.get("message", "오류가 발생했습니다."))

    def ctl_stop(self, s, data):
        s.set_phase("closed", message="리뷰 페이지를 닫았습니다.")
        s.ended_at = time.monotonic() - LINGER_MAX_SECONDS


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # HTTPServer.server_bind는 socket.getfqdn()으로 역방향 DNS를 조회해서 몇십 초씩 멈출 수 있다.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = self.server_address[:2]


def serve(folder):
    """세션 폴더에 server.json을 쓰고, 끝날 조건이 될 때까지 서버를 돌린다."""
    folder = Path(folder)
    data = json.loads((folder / "prs.json").read_text(encoding="utf-8"))
    httpd = Server(("127.0.0.1", 0), Handler)
    port = httpd.server_address[1]
    token = secrets.token_urlsafe(32)
    httpd.app = {"port": port, "token": token}
    httpd.session = session = Session(folder, data)

    info = {"port": port, "token": token, "pid": os.getpid(), "url": f"http://127.0.0.1:{port}/t/{token}/"}
    tmp = folder / "server.json.tmp"
    tmp.write_text(json.dumps(info), encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(folder / "server.json")

    def watch():
        while True:
            time.sleep(0.2)
            with session.lock:
                now = time.monotonic()
                if session.ended_at is not None:
                    waited = now - session.ended_at
                    shown = session.seen >= session.version
                    if (shown and waited >= LINGER_SECONDS) or waited >= LINGER_MAX_SECONDS:
                        break
                elif now - session.last_page >= IDLE_SECONDS:
                    break
        httpd.shutdown()

    threading.Thread(target=watch, daemon=True).start()
    try:
        httpd.serve_forever(poll_interval=0.2)
    finally:
        httpd.server_close()
        shutil.rmtree(folder, ignore_errors=True)


# ---------------------------------------------------------------- 명령줄


def emit(value, code=0):
    print(json.dumps(value, ensure_ascii=False))
    sys.exit(code)


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def control(folder, method, name, body=None, timeout=10, query=""):
    """세션 폴더의 연결 정보로 서버에 요청한다. 서버가 없으면 None."""
    try:
        info = json.loads((Path(folder) / "server.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    url = f"http://127.0.0.1:{info['port']}/t/{info['token']}/ctl/{name}{query}"
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-Review-Control", "1")
    req.add_header("Content-Type", "application/json")
    try:
        with OPENER.open(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, None
    except (urllib.error.URLError, OSError, TimeoutError):
        return None


def open_browser(url):
    command = ["open", url] if sys.platform == "darwin" else ["xdg-open", url]
    try:
        result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def pr_rows(raw, viewer):
    """gh pr list --json number,title,author,additions,deletions,reviewRequests 출력을 페이지 형식으로 바꾼다."""
    rows = []
    for pr in raw:
        requests = pr.get("reviewRequests") or []
        rows.append(
            {
                "number": pr["number"],
                "title": pr.get("title", ""),
                "author": (pr.get("author") or {}).get("login", ""),
                "additions": pr.get("additions", 0),
                "deletions": pr.get("deletions", 0),
                "isReviewRequested": any(r.get("login") == viewer for r in requests),
            }
        )
    return rows


def cmd_start(args):
    raw = json.loads(sys.stdin.read() if args.prs == "-" else Path(args.prs).read_text(encoding="utf-8"))
    if not raw:
        emit({"ok": False, "empty": True, "error": "열린 PR이 없습니다."}, 1)
    data = {"repo": args.repo, "prs": pr_rows(raw, args.viewer)}
    folder = Path(tempfile.mkdtemp(prefix="pretty-korean-review-"))
    (folder / "prs.json").write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    log = open(folder / "server.log", "w")
    subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve()), "serve", "--dir", str(folder)],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
        close_fds=True,
    )
    deadline = time.monotonic() + 10
    while not (folder / "server.json").exists():
        if time.monotonic() > deadline:
            emit({"ok": False, "error": "서버를 시작하지 못했습니다.", "dir": str(folder)}, 1)
        time.sleep(0.05)
    info = json.loads((folder / "server.json").read_text(encoding="utf-8"))
    opened = False if args.no_browser else open_browser(info["url"])
    emit({"ok": True, "dir": str(folder), "url": info["url"], "opened": opened})


def cmd_wait(args):
    while True:
        result = control(args.dir, "GET", "event", timeout=40, query="?timeout=25")
        if result is None:
            emit({"type": "closed"})
        status, event = result
        if status == 200 and event:
            emit(event)
        if status != 204:
            emit({"type": "closed"})


def simple(args, name, body):
    result = control(args.dir, "POST", name, body)
    if result is None:
        emit({"ok": False, "closed": True, "error": "리뷰 페이지 서버가 이미 끝났습니다."}, 1)
    status, value = result
    if status != 200:
        emit({"ok": False, "error": (value or {}).get("error", f"HTTP {status}")}, 1)
    emit({"ok": True})


def cmd_feedback(args):
    review = json.loads(Path(args.review).read_text(encoding="utf-8"))
    diff = Path(args.diff).read_text(encoding="utf-8", errors="replace")
    simple(args, "feedback", {"review": review, "diff": diff})


def cmd_ranges(args):
    text = Path(args.diff).read_text(encoding="utf-8", errors="replace")
    emit(ranges_of(parse_diff(text)))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("start")
    p.add_argument("--repo", required=True)
    p.add_argument("--viewer", required=True)
    p.add_argument("--prs", default="-", help="gh pr list 출력 파일. 기본값은 표준 입력")
    p.add_argument("--no-browser", action="store_true")
    p = sub.add_parser("serve")
    p.add_argument("--dir", required=True)
    for name in ("wait", "stop"):
        sub.add_parser(name).add_argument("--dir", required=True)
    p = sub.add_parser("reviewing")
    p.add_argument("--dir", required=True)
    p.add_argument("--number", type=int, required=True)
    p = sub.add_parser("feedback")
    p.add_argument("--dir", required=True)
    p.add_argument("--review", required=True)
    p.add_argument("--diff", required=True)
    p = sub.add_parser("done")
    p.add_argument("--dir", required=True)
    p.add_argument("--url", required=True)
    p = sub.add_parser("error")
    p.add_argument("--dir", required=True)
    p.add_argument("--message", required=True)
    p = sub.add_parser("ranges")
    p.add_argument("--diff", required=True)

    args = parser.parse_args(argv)
    if args.command == "start":
        cmd_start(args)
    elif args.command == "serve":
        serve(args.dir)
    elif args.command == "wait":
        cmd_wait(args)
    elif args.command == "reviewing":
        simple(args, "reviewing", {"number": args.number})
    elif args.command == "feedback":
        cmd_feedback(args)
    elif args.command == "done":
        simple(args, "done", {"url": args.url})
    elif args.command == "error":
        simple(args, "error", {"message": args.message})
    elif args.command == "stop":
        result = control(args.dir, "POST", "stop", {})
        emit({"ok": True, "stopped": result is not None})
    elif args.command == "ranges":
        cmd_ranges(args)


if __name__ == "__main__":
    main()
