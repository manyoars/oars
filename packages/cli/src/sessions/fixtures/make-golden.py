"""Writes golden.json: what the reference scripts (docs/research/2026-11-01-session-commons/, the umbrella repository's commit a537d9d) count on proj/.

Run: python3 -I make-golden.py <path to the session-commons reference scripts>
extract.test.ts asserts the TypeScript extractor's counts equal these.
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

# cost_per_class.py's prompt rule, with register A22's dedupe: an API response spans several assistant lines that repeat its usage,
# so each response (requestId, else message.id) counts once. The reference script itself sums per line, so it is not used for tokens.
FIELDS = (("input", "input_tokens"), ("cache_write", "cache_creation_input_tokens"), ("cache_read", "cache_read_input_tokens"), ("output", "output_tokens"))
cost = {"prompts": 0, "input": 0, "cache_write": 0, "cache_read": 0, "output": 0, "thinking": 0}
for name in sorted(os.listdir(os.path.join(HERE, "proj"))):
    in_prompt, seen = False, set()
    for raw in open(os.path.join(HERE, "proj", name), encoding="utf-8", errors="replace"):
        try:
            o = json.loads(raw)
        except Exception:
            continue
        m = o.get("message")
        if not isinstance(m, dict) or o.get("isSidechain"):
            continue
        c = m.get("content")
        if o.get("type") == "user" and m.get("role") == "user" and not o.get("isMeta"):
            txt = c if isinstance(c, str) else next((b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text"), "") if isinstance(c, list) else ""
            has_result = isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
            if txt and not has_result and not txt.startswith("<"):
                in_prompt = True
                cost["prompts"] += 1
                continue
        if not in_prompt or o.get("type") != "assistant":
            continue
        key = o.get("requestId") or m.get("id")
        if key and key in seen:
            continue
        if key:
            seen.add(key)
        u = m.get("usage") or {}
        for ours, theirs in FIELDS:
            if isinstance(u.get(theirs), (int, float)):
                cost[ours] += u[theirs]
        v = (u.get("output_tokens_details") or {}).get("thinking_tokens")
        if isinstance(v, (int, float)):
            cost["thinking"] += v

json.dump({"sessions": sessions, "errors": errors, "graph": graph, "cost": cost}, open(os.path.join(HERE, "golden.json"), "w"), indent=1, sort_keys=True)
print(json.dumps({"errors": errors, "graph": graph, "cost": cost}, indent=1)[:1800])
