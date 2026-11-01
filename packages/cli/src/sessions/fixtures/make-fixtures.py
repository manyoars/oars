"""Writes the four session fixtures in proj/. Synthetic: no real session content. Run: python3 -I make-fixtures.py"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
T0 = 1_780_000_000  # 2026-05-28


def iso(sec):
    import datetime
    return datetime.datetime.fromtimestamp(T0 + sec, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class S:
    def __init__(self, name, version="2.1.300", model="claude-opus-5-5"):
        self.name, self.version, self.model = name, version, model
        self.lines, self.n, self.t, self.parent, self.req = [], 0, 0, None, 0

    def _uuid(self):
        self.n += 1
        return f"{self.name}-{self.n:04d}"

    def _emit(self, o):
        self.lines.append(json.dumps(o))

    def attach(self, a):
        self.t += 1
        u = self._uuid()
        self._emit({"type": "attachment", "uuid": u, "parentUuid": self.parent, "timestamp": iso(self.t), "version": self.version, "attachment": a})

    def prompt(self, text, side=False):
        self.t += 5
        u = self._uuid()
        self._emit({"type": "user", "uuid": u, "parentUuid": self.parent, "isSidechain": side, "timestamp": iso(self.t), "version": self.version, "cwd": "/work/app", "gitBranch": "main",
                    "message": {"role": "user", "content": text}})
        self.parent = u

    def assistant(self, blocks, usage=None, side=False, effort=None, skill=None, think=None):
        self.t += 3
        u = self._uuid()
        self.req += 1
        o = {"type": "assistant", "uuid": u, "parentUuid": self.parent, "isSidechain": side, "timestamp": iso(self.t), "version": self.version, "requestedModel": self.model,
             "requestId": f"req_{self.name}_{self.req}", "apiBlockIndex": 0,
             "message": {"role": "assistant", "model": self.model, "content": blocks}}
        if usage:
            o["message"]["usage"] = {"input_tokens": usage[0], "cache_creation_input_tokens": usage[1], "cache_read_input_tokens": usage[2], "output_tokens": usage[3]}
            if think is not None:
                o["message"]["usage"]["output_tokens_details"] = {"thinking_tokens": think}
        if effort:
            o["effort"] = effort
        if skill:
            o["attributionSkill"] = skill
        self._emit(o)
        self.parent = u

    def tool(self, name, inp, tid, **kw):
        self.assistant([{"type": "tool_use", "id": tid, "name": name, "input": inp}], **kw)

    def result(self, tid, text, error=False, side=False):
        self.t += 2
        u = self._uuid()
        self._emit({"type": "user", "uuid": u, "parentUuid": self.parent, "isSidechain": side, "timestamp": iso(self.t), "version": self.version,
                    "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": tid, "is_error": error, "content": text}]}})
        self.parent = u

    def write(self):
        with open(os.path.join(HERE, "proj", self.name + ".jsonl"), "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join(self.lines) + "\n")


# 1. errors: quoting error then a workaround, a Write-before-Read error, edit-verify and edit-only prompts, a second prompt with no tools.
a = S("errors-a")
a.attach({"type": "environment", "snapshot": {"workingDirectory": "/work/app", "platform": "linux"}})
a.prompt("fix the failing build in /work/app/src/main.ts, token=abc123 is set")
a.tool("Read", {"file_path": "/work/app/src/main.ts"}, "t1", usage=(10, 500, 9000, 120), effort="high", think=40)
a.result("t1", "file contents")
a.tool("Bash", {"command": "echo 'it's broken"}, "t2", usage=(10, 100, 9500, 80), think=10)
a.result("t2", "Exit code 2\nbash: -c: line 1: unexpected EOF while looking for matching quote\n", error=False)
a.tool("Write", {"file_path": "/work/app/fix.sh", "content": "echo ok"}, "t3", usage=(10, 50, 9600, 60))
a.result("t3", "File has not been read yet. Read it first before writing to it.", error=True)
a.tool("Read", {"file_path": "/work/app/fix.sh"}, "t4", usage=(10, 20, 9700, 20))
a.result("t4", "echo ok")
a.tool("Edit", {"file_path": "/work/app/src/main.ts", "old_string": "a", "new_string": "b"}, "t5", usage=(10, 20, 9800, 90), think=30)
a.result("t5", "edited")
a.tool("Bash", {"command": "npm test"}, "t6", usage=(10, 20, 9900, 30))
a.result("t6", "Exit code 0\nall passed")
a.assistant([{"type": "thinking", "thinking": "done"}, {"type": "text", "text": "Fixed."}], usage=(5, 0, 10000, 15), think=5)
a.prompt("now rename the module in /work/app/src/util.ts")
a.tool("Edit", {"file_path": "/work/app/src/util.ts", "old_string": "x", "new_string": "y"}, "t7", usage=(4, 10, 10100, 25))
a.result("t7", "edited")
a.prompt("thanks")
a.assistant([{"type": "text", "text": "You are welcome."}], usage=(3, 0, 10200, 8))
a.lines.append(json.dumps({"type": "last-prompt", "lastPrompt": "thanks"}))
a.write()

# 2. errors-b: the same quoting signature in another session (session count 2), a traceback, a failed command followed by an edit.
b = S("errors-b", version="2.1.310", model="claude-sonnet-5-5")
b.prompt("run the importer at /work/other/import.py and fix whatever breaks")
b.tool("Bash", {"command": "python /work/other/import.py"}, "u1", usage=(7, 300, 5000, 60))
b.result("u1", "Exit code 1\nTraceback (most recent call last):\n  File \"/work/other/import.py\", line 12, in <module>\nKeyError: 'id'", error=False)
b.tool("Edit", {"file_path": "/work/other/import.py", "old_string": "a", "new_string": "b"}, "u2", usage=(7, 10, 5100, 40))
b.result("u2", "edited")
b.tool("Bash", {"command": "echo \"it's"}, "u3", usage=(7, 10, 5200, 10))
b.result("u3", "Exit code 2\nbash: -c: line 1: unexpected EOF while looking for matching quote\n")
b.tool("Bash", {"command": "ls"}, "u4", usage=(7, 10, 5300, 10))
b.result("u4", "Exit code 0\nREADME")
b.write()

# 3. tldr: research prompt (web), TLDR and Confidence markers, a skill attribution, a coordination prompt.
c = S("tldr")
c.prompt("research how the retry header works")
c.tool("WebSearch", {"query": "retry-after header semantics"}, "w1", usage=(3, 200, 3000, 50), skill="deep-dive")
c.result("w1", "results")
c.tool("WebFetch", {"url": "https://example.com/docs/retry?token=sk-test-FAKEFAKEFAKEFAKEFAKE0000"}, "w2", usage=(3, 20, 3100, 50), skill="deep-dive")
c.result("w2", "page")
c.assistant([{"type": "text", "text": "Summary\nTLDR: Retry-After is seconds or a date.\nConfidence: high, two sources agree\n"}], usage=(3, 0, 3200, 40))
c.prompt("coordinate the two workers")
c.tool("Agent", {"prompt": "x"}, "w3", usage=(2, 10, 3300, 20))
c.result("w3", "ok")
c.tool("SendMessage", {"to": "a"}, "w4", usage=(2, 10, 3400, 20))
c.result("w4", "ok")
c.write()

# 4. sidechain: a subagent's lines inside the main file, plus one unparseable line.
d = S("sidechain")
d.prompt("audit the module")
d.tool("Read", {"file_path": "/work/app/a.ts"}, "s1", usage=(2, 10, 800, 10))
d.result("s1", "ok")
d.tool("Grep", {"pattern": "x"}, "s2", usage=(2, 10, 900, 10), side=True)
d.result("s2", "Exit code 1\nno matches", side=True)
d.lines.append("{this line is not json")
d.tool("Bash", {"command": "false"}, "s3", usage=(2, 10, 1000, 10))
d.result("s3", "Exit code 1\n", error=False)
d.assistant([{"type": "text", "text": "Done."}], usage=(2, 0, 1100, 10))
d.write()
