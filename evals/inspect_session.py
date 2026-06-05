"""Dump the ordered tool-call trace of a claude -p session, to see HOW the agent
explored and WHERE it went wrong. Reads the transcript JSONL Claude writes per
session under ~/.claude/projects/<encoded-cwd>/<session_id>.jsonl.

Usage: python evals/inspect_session.py <session_id> [<session_id> ...]
  or:  python evals/inspect_session.py --result <id>.<A|B>   (resolve via result file)
"""
import json
import os
import sys

PROJ = "/home/emanuele/.claude/projects/-home-emanuele-39-claude-code-plugin-eval-repos-graphiti"
RESULTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "results")


def trunc(s, n=200):
    return " ".join(str(s).split())[:n]


def dump(session_id: str) -> None:
    path = os.path.join(PROJ, f"{session_id}.jsonl")
    print(f"\n{'='*70}\nSESSION {session_id}\n{'='*70}")
    if not os.path.exists(path):
        print("  (transcript not found)")
        return
    for line in open(path):
        try:
            o = json.loads(line)
        except Exception:
            continue
        msg = o.get("message", {})
        role = msg.get("role", o.get("type", ""))
        content = msg.get("content")
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict):
                continue
            t = c.get("type")
            if t == "text" and role == "assistant":
                txt = trunc(c.get("text", ""), 220)
                if txt:
                    print(f"\n  [assistant] {txt}")
            elif t == "tool_use":
                inp = c.get("input", {})
                arg = inp.get("command") or inp.get("pattern") or inp.get("file_path") or inp.get("query") or json.dumps(inp)[:120]
                print(f"  -> {c.get('name')}: {trunc(arg, 150)}")
            elif t == "tool_result":
                body = c.get("content", "")
                if isinstance(body, list):
                    body = " ".join(str(x.get("text", "")) for x in body if isinstance(x, dict))
                print(f"     = {trunc(body, 180)}")


def main():
    args = sys.argv[1:]
    sids = []
    i = 0
    while i < len(args):
        if args[i] == "--result":
            rid = args[i + 1]
            d = json.load(open(os.path.join(RESULTS, f"{rid}.json")))
            sids.append(d.get("run", {}).get("session_id") or d.get("session_id"))
            i += 2
        else:
            sids.append(args[i])
            i += 1
    for s in sids:
        dump(s)


if __name__ == "__main__":
    main()
