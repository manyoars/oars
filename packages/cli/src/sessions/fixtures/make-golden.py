"""Writes golden.json: what the reference scripts (docs/research/2026-11-01-session-commons/, tradeaor a537d9d) count on proj/.

Run: python3 -I make-golden.py <path to the session-commons reference scripts>
parity.test.ts asserts the TypeScript extractor's counts equal these.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.abspath(sys.argv[1])
tmp = tempfile.mkdtemp()


def run(script, *args):
    return subprocess.run([sys.executable, "-I", os.path.join(REF, script), *args], capture_output=True, text=True, check=True).stdout


def ints(text):
    return int(text.replace(",", ""))


# parse_sessions.py
run("parse_sessions.py", HERE, os.path.join(tmp, "s.jsonl"), "proj")
sessions = {}
for line in open(os.path.join(tmp, "s.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    sessions[r["file"][: -len(".jsonl")]] = {k: r[k] for k in ("lines", "bad_lines", "user_turns", "assistant_turns", "bash_cmds", "tools", "files_touched", "urls_fetched", "searches", "tldrs", "confidences")}

# error_signatures.py
out = run("error_signatures.py", HERE, "proj", os.path.join(tmp, "e.json"))
e = json.load(open(os.path.join(tmp, "e.json"), encoding="utf-8"))
errors = {
    "tool_results": e["tool_results"],
    "error_results": e["error_results"],
    "sessions_with_error": e["sessions_with_error"],
    "distinct_signatures": e["distinct_signatures"],
    "recurring": dict(e["recurring"]),
    "edit_followed": int(re.search(r"within 6 calls (\d+)", out).group(1)),
}

# prompt_graphs.py
run("prompt_graphs.py", HERE, "proj", os.path.join(tmp, "p.jsonl"))
prompts = [json.loads(line) for line in open(os.path.join(tmp, "p.jsonl"), encoding="utf-8")]
classes, bigrams, recovery = {}, {}, {}
for p in prompts:
    classes[p["class"]] = classes.get(p["class"], 0) + 1
    seq = p["seq"]
    for a, b in zip(seq, seq[1:]):
        bigrams[f"{a}>{b}"] = bigrams.get(f"{a}>{b}", 0) + 1
    if p["recovery"]:
        k = ">".join(p["recovery"][:2])
        recovery[k] = recovery.get(k, 0) + 1
graph = {"prompts": len(prompts), "tools": sum(len(p["seq"]) for p in prompts), "errors": sum(p["errors"] for p in prompts), "thinking": sum(p["thinking"] for p in prompts),
         "side_tools": sum(p["side_tools"] for p in prompts), "classes": classes, "bigrams": bigrams, "recovery": recovery}

# cost_per_class.py
out = run("cost_per_class.py", HERE, "proj")
m = re.search(r"prompts (\d+) \| total tokens: input ([\d,]+) \| cache write ([\d,]+) \| cache read ([\d,]+) \| output ([\d,]+) \| thinking ([\d,]+)", out)
cost = {"prompts": int(m.group(1)), "input": ints(m.group(2)), "cache_write": ints(m.group(3)), "cache_read": ints(m.group(4)), "output": ints(m.group(5)), "thinking": ints(m.group(6))}

json.dump({"sessions": sessions, "errors": errors, "graph": graph, "cost": cost}, open(os.path.join(HERE, "golden.json"), "w"), indent=1, sort_keys=True)
print(json.dumps({"errors": errors, "graph": graph, "cost": cost}, indent=1)[:1800])
