"""review 스킬의 로컬 리뷰 페이지 서버 테스트.

실행: python3 -m unittest discover -s tests -v
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "plugins/pretty-korean-pull-request/skills/review/scripts/review_server.py"
sys.path.insert(0, str(SCRIPT.parent))

import review_server as rs  # noqa: E402

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# gh pr list --json number,title,author,additions,deletions,reviewRequests 출력 형식
GH_PRS = [
    {"number": 7, "title": "회원 탈퇴 배치 추가", "author": {"login": "alice"}, "additions": 40, "deletions": 3,
     "updatedAt": "2026-11-16T01:02:03Z",
     "reviewRequests": [{"__typename": "Team", "slug": "backend"}, {"__typename": "User", "login": "me"}]},
    {"number": 8, "title": "README 수정", "author": {"login": "bob"}, "additions": 1, "deletions": 1, "reviewRequests": []},
]
PRS = {
    "repo": "octo/sample",
    "prs": [
        {"number": 7, "title": "회원 탈퇴 배치 추가", "author": "alice", "additions": 40, "deletions": 3,
         "updatedAt": "2026-11-16T01:02:03Z", "isReviewRequested": True},
        {"number": 8, "title": "README 수정", "author": "bob", "additions": 1, "deletions": 1,
         "updatedAt": "", "isReviewRequested": False},
    ],
}

DIFF = """\
diff --git a/src/Batch.kt b/src/Batch.kt
index 111..222 100644
--- a/src/Batch.kt
+++ b/src/Batch.kt
@@ -10,5 +10,7 @@ class Batch {
     fun run() {
-        val members = repo.find()
+        val members = repo.findWithdrawn()
+        val first = members.first()
+        log(first)
         process(members)
     }

@@ -40,3 +42,3 @@ class Batch {
-    private val size = 10
+    private val size = 100
     private val name = "batch"
 }
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
index 333..000
--- a/docs/old.md
+++ /dev/null
@@ -1,2 +0,0 @@
-# old
-bye
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 000..444
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1 @@
+hello
\\ No newline at end of file
diff --git a/src/Only.kt b/src/Only.kt
index 555..666 100644
--- a/src/Only.kt
+++ b/src/Only.kt
@@ -3,2 +3,0 @@
-gone()
-gone2()
"""

REVIEW = {
    "repo": "octo/sample",
    "number": 7,
    "title": "회원 탈퇴 배치 추가",
    "author": "alice",
    "headSha": "abc123",
    "isOwnPr": False,
    "summary": "전체적으로 깔끔합니다.",
    "recommendedEvent": "REQUEST_CHANGES",
    "items": [
        {"id": 1, "severity": "버그", "path": "src/Batch.kt", "line": 12, "body": "목록이 비면 예외가 납니다.",
         "suggestion": "        val first = members.firstOrNull() ?: return"},
        {"id": 2, "severity": "제안", "path": "src/Batch.kt", "startLine": 11, "line": 13, "body": "함수로 빼면 어떨까요?"},
        {"id": 3, "severity": "사소", "path": "docs/new.md", "line": 1, "body": "끝에 줄바꿈이 없습니다."},
    ],
}


def old_ranges(text):
    """예전 SKILL.md에 있던 줄 범위 계산. 새 구현과 결과가 같아야 한다."""
    ranges, path = {}, None
    for line in text.splitlines(keepends=True):
        if line.startswith("+++ "):
            path = None if line.strip() == "+++ /dev/null" else line[6:].rstrip("\n")
        m = re.match(r"@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", line)
        if m and path:
            start, count = int(m.group(1)), int(m.group(2) or 1)
            if count:
                ranges.setdefault(path, []).append([start, start + count - 1])
    return ranges


class DiffTest(unittest.TestCase):
    def test_ranges_match_old_calculation(self):
        self.assertEqual(rs.ranges_of(rs.parse_diff(DIFF)), old_ranges(DIFF))

    def test_hunks(self):
        files = rs.parse_diff(DIFF)
        self.assertEqual(sorted(files), ["docs/new.md", "src/Batch.kt", "src/Only.kt"])
        first = files["src/Batch.kt"][0]["lines"]
        self.assertEqual(first[1], {"t": "-", "o": 11, "n": None, "s": "        val members = repo.find()"})
        self.assertEqual(first[3], {"t": "+", "o": None, "n": 12, "s": "        val first = members.first()"})
        self.assertEqual(first[-1], {"t": " ", "o": 14, "n": 16, "s": ""})
        self.assertEqual(files["docs/new.md"][0]["lines"], [{"t": "+", "o": None, "n": 1, "s": "hello"}])

    def test_added_line_that_looks_like_header(self):
        diff = "+++ b/a.txt\n@@ -0,0 +1,2 @@\n+++ not a header\n+@@ -1 +1 @@\n"
        files = rs.parse_diff(diff)
        self.assertEqual([l["s"] for l in files["a.txt"][0]["lines"]], ["++ not a header", "@@ -1 +1 @@"])

    def test_out_of_range(self):
        ranges = rs.ranges_of(rs.parse_diff(DIFF))
        self.assertEqual(rs.out_of_range(REVIEW, ranges), [])
        bad = {"items": [{"path": "src/Batch.kt", "line": 30}, {"path": "src/Batch.kt", "startLine": 16, "line": 43}]}
        self.assertEqual(rs.out_of_range(bad, ranges), ["src/Batch.kt:30", "src/Batch.kt:43"])


class PayloadTest(unittest.TestCase):
    def test_labels_suggestion_and_multiline(self):
        payload = rs.build_payload(REVIEW, {
            "event": "REQUEST_CHANGES",
            "summary": "  전체 의견입니다. ",
            "comments": [
                {"id": 1, "body": "고친 문장입니다.", "suggestion": "        val first = members.firstOrNull() ?: return\n"},
                {"id": 2, "body": "함수로 빼면 어떨까요?", "suggestion": "  \n"},
            ],
        })
        self.assertEqual(payload["commit_id"], "abc123")
        self.assertEqual(payload["event"], "REQUEST_CHANGES")
        self.assertEqual(payload["body"], "전체 의견입니다.")
        c1, c2 = payload["comments"]
        self.assertEqual(c1, {
            "path": "src/Batch.kt", "line": 12, "side": "RIGHT",
            "body": "**[버그]** 고친 문장입니다.\n\n```suggestion\n        val first = members.firstOrNull() ?: return\n```",
        })
        self.assertEqual(c2["start_line"], 11)
        self.assertEqual(c2["start_side"], "RIGHT")
        self.assertEqual(c2["body"], "**[제안]** 함수로 빼면 어떨까요?")

    def test_own_pr_is_comment_and_empty_summary_is_omitted(self):
        review = dict(REVIEW, isOwnPr=True)
        payload = rs.build_payload(review, {"event": "APPROVE", "summary": " ", "comments": [{"id": 3, "body": "x"}]})
        self.assertEqual(payload["event"], "COMMENT")
        self.assertNotIn("body", payload)

    def test_nothing_to_publish(self):
        with self.assertRaises(rs.Invalid):
            rs.build_payload(REVIEW, {"event": "COMMENT", "summary": "", "comments": []})
        with self.assertRaises(rs.Invalid):
            rs.build_payload(REVIEW, {"event": "COMMENT", "summary": "", "comments": [{"id": 1, "body": " "}]})
        with self.assertRaises(rs.Invalid):
            rs.build_payload(REVIEW, {"event": "COMMENT", "summary": "", "comments": [{"id": 99, "body": "x"}]})


class ServerCase(unittest.TestCase):
    """실제로 서버를 띄워서 확인한다."""

    env = {"PKR_LINGER_SECONDS": "0.5", "PKR_LINGER_MAX_SECONDS": "3"}

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        prs = Path(self.tmp.name) / "prs.json"
        prs.write_text(json.dumps(GH_PRS, ensure_ascii=False), encoding="utf-8")
        out = self.run_cmd("start", "--repo", "octo/sample", "--viewer", "me", "--prs", str(prs), "--no-browser")
        self.assertTrue(out["ok"], out)
        self.assertFalse(out["opened"])
        self.dir = out["dir"]
        self.url = out["url"]
        self.info = json.loads((Path(self.dir) / "server.json").read_text())
        self.origin = f"http://127.0.0.1:{self.info['port']}"

    def tearDown(self):
        self.run_cmd("stop", "--dir", self.dir, check=False)
        self.wait_gone()
        self.tmp.cleanup()

    def run_cmd(self, *args, check=True):
        env = dict(os.environ, **self.env)
        res = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, env=env, timeout=30)
        lines = res.stdout.strip().splitlines()
        if check:
            self.assertTrue(lines, res.stderr)
        return json.loads(lines[-1]) if lines else None

    def start_wait(self):
        env = dict(os.environ, **self.env)
        return subprocess.Popen([sys.executable, str(SCRIPT), "wait", "--dir", self.dir],
                                stdout=subprocess.PIPE, text=True, env=env)

    def finish(self, proc):
        out, _ = proc.communicate(timeout=15)
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 1, out)
        return json.loads(lines[0])

    def request(self, method, path, body=None, headers=None, base=None):
        url = (base or self.url) + path
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method=method)
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        try:
            with OPENER.open(req, timeout=10) as res:
                raw = res.read()
                return res.status, dict(res.headers), (json.loads(raw) if raw and "json" in res.headers.get("Content-Type", "") else raw)
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def page_post(self, name, body=None):
        return self.request("POST", "api/" + name, body or {}, {"Origin": self.origin, "Content-Type": "application/json"})

    def state(self):
        return self.request("GET", "api/state")[2]

    def wait_gone(self, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if not Path(self.dir).exists():
                return True
            time.sleep(0.1)
        return False

    def port_open(self):
        try:
            self.request("GET", "api/state")
            return True
        except (urllib.error.URLError, OSError):
            return False


class StartStopTest(ServerCase):
    def test_no_open_prs(self):
        res = subprocess.run([sys.executable, str(SCRIPT), "start", "--repo", "o/r", "--viewer", "me", "--no-browser"],
                             input="[]", capture_output=True, text=True, timeout=10)
        self.assertNotEqual(res.returncode, 0)
        self.assertTrue(json.loads(res.stdout)["empty"])

    def test_binds_loopback_only_and_stop_cleans_up(self):
        lsof = subprocess.run(["lsof", "-nP", f"-iTCP:{self.info['port']}", "-sTCP:LISTEN"],
                              capture_output=True, text=True)
        listening = [l for l in lsof.stdout.splitlines()[1:] if l.strip()]
        self.assertTrue(listening, lsof.stdout)
        for line in listening:
            self.assertIn(f"127.0.0.1:{self.info['port']}", line)
        self.assertEqual(self.request("GET", "")[0], 200)

        self.assertTrue(self.run_cmd("stop", "--dir", self.dir)["stopped"])
        self.assertTrue(self.wait_gone(), "세션 폴더가 남아 있습니다")
        time.sleep(0.3)
        self.assertFalse(self.port_open())


class SecurityTest(ServerCase):
    def test_page_has_csp(self):
        status, headers, body = self.request("GET", "")
        self.assertEqual(status, 200)
        self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
        self.assertIn(b"<html", body)

    def test_wrong_token_is_rejected(self):
        bad = f"{self.origin}/t/{'x' * len(self.info['token'])}/"
        self.assertEqual(self.request("GET", "", base=bad)[0], 404)
        self.assertEqual(self.request("GET", "api/state", base=bad)[0], 404)
        self.assertEqual(self.request("GET", "", base=self.origin + "/")[0], 404)

    def test_wrong_host_is_rejected(self):
        self.assertEqual(self.request("GET", "api/state", headers={"Host": "evil.example"})[0], 404)

    def test_post_needs_same_origin(self):
        body = {"number": 7}
        self.assertEqual(self.request("POST", "api/select", body)[0], 403)
        self.assertEqual(self.request("POST", "api/select", body, {"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(self.request("GET", "api/select")[0], 404)
        self.assertEqual(self.state()["phase"], "list")

    def test_control_needs_header_and_no_origin(self):
        body = {"url": "https://x"}
        self.assertEqual(self.request("POST", "ctl/done", body)[0], 403)
        self.assertEqual(self.request("POST", "ctl/done", body, {"X-Review-Control": "1", "Origin": self.origin})[0], 403)
        self.assertEqual(self.state()["phase"], "list")


class FlowTest(ServerCase):
    def files(self):
        folder = Path(self.tmp.name)
        (folder / "review.json").write_text(json.dumps(REVIEW, ensure_ascii=False), encoding="utf-8")
        (folder / "pr.diff").write_text(DIFF, encoding="utf-8")
        return str(folder / "review.json"), str(folder / "pr.diff")

    def test_select_publish_done(self):
        self.assertEqual(self.state()["prs"], PRS["prs"])

        proc = self.start_wait()
        time.sleep(0.3)
        self.assertEqual(self.page_post("select", {"number": 7})[0], 200)
        self.assertEqual(self.finish(proc), {"type": "select", "number": 7})
        self.assertEqual(self.state()["phase"], "reviewing")

        self.assertTrue(self.run_cmd("reviewing", "--dir", self.dir, "--number", "7")["ok"])
        review, diff = self.files()
        self.assertTrue(self.run_cmd("feedback", "--dir", self.dir, "--review", review, "--diff", diff)["ok"])
        state = self.state()
        self.assertEqual(state["phase"], "feedback")
        self.assertEqual(state["review"]["items"][0]["id"], 1)
        self.assertEqual(sorted(state["files"]), ["docs/new.md", "src/Batch.kt"])

        empty = self.page_post("publish", {"event": "COMMENT", "summary": "", "comments": []})
        self.assertEqual(empty[0], 400)

        proc = self.start_wait()
        status, _, _ = self.page_post("publish", {
            "event": "REQUEST_CHANGES", "summary": "전체 의견",
            "comments": [{"id": 1, "body": "고친 문장", "suggestion": ""}],
        })
        self.assertEqual(status, 200)
        event = self.finish(proc)
        self.assertEqual(event["type"], "publish")
        self.assertEqual((event["repo"], event["number"], event["comments"]), ("octo/sample", 7, 1))
        payload = json.loads(Path(event["payload"]).read_text())
        self.assertEqual(payload["comments"][0]["body"], "**[버그]** 고친 문장")
        self.assertEqual(self.state()["phase"], "posting")

        self.assertTrue(self.run_cmd("done", "--dir", self.dir, "--url", "https://github.com/octo/sample/pull/7#r1")["ok"])
        state = self.state()
        self.assertEqual((state["phase"], state["url"]), ("done", "https://github.com/octo/sample/pull/7#r1"))
        self.assertTrue(self.wait_gone(5), "게시를 마친 뒤 서버가 끝나지 않았습니다")

    def test_feedback_out_of_range_is_rejected(self):
        self.page_post("select", {"number": 7})
        bad = dict(REVIEW, items=[dict(REVIEW["items"][0], line=30)])
        path = Path(self.tmp.name) / "bad.json"
        path.write_text(json.dumps(bad, ensure_ascii=False), encoding="utf-8")
        _, diff = self.files()
        out = self.run_cmd("feedback", "--dir", self.dir, "--review", str(path), "--diff", diff)
        self.assertFalse(out["ok"])
        self.assertIn("src/Batch.kt:30", out["error"])

    def test_cancel(self):
        self.page_post("select", {"number": 8})
        proc = self.start_wait()
        self.assertEqual(self.finish(proc)["type"], "select")
        proc = self.start_wait()
        self.assertEqual(self.page_post("cancel")[0], 200)
        self.assertEqual(self.finish(proc), {"type": "cancel"})
        self.assertTrue(self.wait_gone(5))

    def test_close(self):
        proc = self.start_wait()
        self.assertEqual(self.page_post("close")[0], 200)
        self.assertEqual(self.finish(proc), {"type": "close"})
        self.assertTrue(self.wait_gone(5))

    def test_error(self):
        self.assertTrue(self.run_cmd("error", "--dir", self.dir, "--message", "gh 실패")["ok"])
        state = self.state()
        self.assertEqual((state["phase"], state["message"]), ("error", "gh 실패"))
        self.assertTrue(self.wait_gone(5))


class LifetimeTest(ServerCase):
    env = dict(ServerCase.env, PKR_IDLE_SECONDS="1.5")

    def test_idle_server_exits_and_wait_reports_closed(self):
        proc = self.start_wait()
        self.assertTrue(self.wait_gone(10), "요청이 없는데도 서버가 끝나지 않았습니다")
        self.assertEqual(self.finish(proc), {"type": "closed"})
        self.assertFalse(self.port_open())

    def test_wait_without_server(self):
        self.run_cmd("stop", "--dir", self.dir)
        self.wait_gone()
        self.assertEqual(self.finish(self.start_wait()), {"type": "closed"})
        out = self.run_cmd("reviewing", "--dir", self.dir, "--number", "7")
        self.assertEqual((out["ok"], out["closed"]), (False, True))


if __name__ == "__main__":
    unittest.main()
