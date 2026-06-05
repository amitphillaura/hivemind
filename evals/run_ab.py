"""A/B eval harness: vanilla Claude Code vs Claude Code + code graph.

For each question in smoke_graphiti.json, run `claude -p` twice (Arm A vanilla,
Arm B with the local graph plugin), then grade both answers with fact-recall.

Prereqs (the harness does NOT toggle plugins itself — do it once, by hand):
  claude plugin disable hivemind     # so --plugin-dir loads the LOCAL build
  ...run this script...
  claude plugin enable hivemind      # restore afterwards

Run:
  python evals/run_ab.py --limit 1            # smoke a single question first
  python evals/run_ab.py                      # all 12
  python evals/run_ab.py --arm A --limit 1    # one arm only

Outputs:
  evals/results/<id>.<arm>.json   raw claude --output-format json per run
  evals/results/summary.json      graded per-question + aggregate
"""
import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
WORKTREE = os.path.dirname(HERE)
PLUGIN_DIR = os.path.join(WORKTREE, "claude-code")
REPO = "/home/emanuele/39_claude_code_plugin/eval-repos/graphiti"
RESULTS = os.path.join(HERE, "results")

# Hermetic subprocess env: no capture, no cloud graph push/pull.
SUB_ENV = {
    **os.environ,
    "DEEPLAKE_CAPTURE": "false",
    "HIVEMIND_GRAPH_PUSH": "0",
    "HIVEMIND_GRAPH_PULL": "0",
}

ARM_B_HINT = (
    "\n\nThis repo has a prebuilt code graph at ~/.deeplake/memory/graph/. Use it as "
    "a fast INDEX to LOCATE the few files/symbols that matter (`cat .../query/<symbol>`, "
    "`.../find/<pattern>`, `.../neighborhood/<file>`), then OPEN those files with Read "
    "to answer. The graph is not a substitute for the source — it omits instance-method "
    "calls, nested functions, and dynamic dispatch — so confirm every claim against the "
    "file before stating it."
)


def run_claude(question: str, arm: str, timeout: int = 600) -> dict:
    """Launch one claude -p run. Arm A vanilla; Arm B with the local plugin."""
    prompt = question if arm == "A" else question + ARM_B_HINT
    cmd = ["claude", "-p", prompt, "--output-format", "json"]
    if arm == "B":
        cmd += ["--plugin-dir", PLUGIN_DIR]
    proc = subprocess.run(
        cmd, cwd=REPO, env=SUB_ENV, capture_output=True, text=True, timeout=timeout
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"_raw_stdout": proc.stdout, "_stderr": proc.stderr, "_rc": proc.returncode}


def answer_text(result: dict) -> str:
    # claude --output-format json puts the final text under "result".
    return result.get("result") or result.get("_raw_stdout") or ""


def _judge_once(question: str, gold_facts: list, answer: str) -> list:
    """One strict judge call. Each fact requires a verbatim evidence quote from
    the answer; present=true is only allowed when evidence is non-empty. This
    stops the judge marking a fact present when the answer never states it."""
    facts_block = "\n".join(f"{i+1}. {f}" for i, f in enumerate(gold_facts))
    judge_prompt = (
        "You grade an answer about a codebase by strict FACT RECALL.\n"
        "For EACH numbered ground-truth fact, decide whether the CANDIDATE "
        "ANSWER explicitly states or unambiguously implies it.\n"
        "Rules:\n"
        "- present=true ONLY if you can quote the exact supporting span from "
        "the candidate answer in `evidence`. If you cannot quote it, "
        "present=false and evidence=\"\".\n"
        "- A fact about a SPECIFIC file/function/symbol is NOT satisfied by an "
        "answer that names a DIFFERENT file/function, even if related.\n\n"
        f"QUESTION:\n{question}\n\n"
        f"GROUND-TRUTH FACTS:\n{facts_block}\n\n"
        f"CANDIDATE ANSWER:\n{answer}\n\n"
        'Reply ONLY with JSON: {"facts":[{"present":bool,"evidence":str}, ...]} '
        "in fact order."
    )
    proc = subprocess.run(
        ["claude", "-p", judge_prompt, "--output-format", "json"],
        env=SUB_ENV, capture_output=True, text=True, timeout=300,
    )
    try:
        txt = json.loads(proc.stdout).get("result", "")
        obj = json.loads(txt[txt.find("{"): txt.rfind("}") + 1])
        facts = obj["facts"]
        # Enforce the evidence rule defensively: no quote -> not present.
        return [
            {"present": bool(fr.get("present")) and bool((fr.get("evidence") or "").strip()),
             "evidence": (fr.get("evidence") or "").strip()}
            for fr in facts
        ]
    except Exception:
        return [{"present": False, "evidence": ""} for _ in gold_facts]


def grade_fact_recall(question: str, gold_facts: list, answer: str, votes: int = 3) -> dict:
    """Majority vote over `votes` strict judge calls. Returns per-fact verdicts
    (with evidence from the deciding/last vote) and the recall fraction."""
    n = len(gold_facts)
    if n == 0:
        return {"facts": [], "recall": 0.0, "votes": votes}
    tallies = [0] * n
    last_evidence = [""] * n
    for _ in range(votes):
        verdicts = _judge_once(question, gold_facts, answer)
        verdicts = (verdicts + [{"present": False, "evidence": ""}] * n)[:n]
        for i, v in enumerate(verdicts):
            if v["present"]:
                tallies[i] += 1
                if v["evidence"]:
                    last_evidence[i] = v["evidence"]
    present = [t > votes / 2 for t in tallies]
    facts = [
        {"fact": gold_facts[i], "present": present[i],
         "votes_present": tallies[i], "evidence": last_evidence[i]}
        for i in range(n)
    ]
    recall = sum(present) / n
    return {"facts": facts, "recall": recall, "votes": votes}


def tool_stats(session_id: str) -> dict:
    """Count tool calls from the session transcript: graph reads vs grep/read/glob."""
    proj = "/home/emanuele/.claude/projects/-home-emanuele-39-claude-code-plugin-eval-repos-graphiti"
    path = os.path.join(proj, f"{session_id}.jsonl")
    stats = {"graph_reads": 0, "grep": 0, "read": 0, "glob": 0, "bash": 0}
    if not session_id or not os.path.exists(path):
        return stats
    for line in open(path):
        try:
            o = json.loads(line)
        except Exception:
            continue
        content = (o.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for c in content:
            if not (isinstance(c, dict) and c.get("type") == "tool_use"):
                continue
            name = c.get("name", "")
            inp = c.get("input", {})
            cmd = str(inp.get("command", ""))
            if name == "Bash":
                stats["bash"] += 1
                if "deeplake/memory/graph" in cmd:
                    stats["graph_reads"] += 1
            elif name == "Grep":
                stats["grep"] += 1
            elif name == "Read":
                stats["read"] += 1
            elif name == "Glob":
                stats["glob"] += 1
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="0 = all questions")
    ap.add_argument("--arm", choices=["A", "B"], default=None, help="run a single arm")
    ap.add_argument("--difficulty", choices=["easy", "moderate", "hard"], default=None)
    ap.add_argument("--dataset", default="smoke_graphiti.json",
                    help="dataset json under evals/ (default smoke_graphiti.json)")
    ap.add_argument("--workers", type=int, default=1, help="parallel questions")
    ap.add_argument("--ids", default=None, help="comma-separated question ids to run")
    args = ap.parse_args()

    os.makedirs(RESULTS, exist_ok=True)
    with open(os.path.join(HERE, args.dataset)) as f:
        data = json.load(f)
    questions = data["questions"]
    if args.difficulty:
        questions = [q for q in questions if q["difficulty"] == args.difficulty]
    if args.ids:
        want = set(args.ids.split(","))
        questions = [q for q in questions if q["id"] in want]
    if args.limit:
        questions = questions[: args.limit]
    arms = [args.arm] if args.arm else ["A", "B"]

    def process_question(q: dict) -> dict:
        row = {"id": q["id"], "difficulty": q["difficulty"], "question": q["question"]}
        for arm in arms:
            res = run_claude(q["question"], arm)
            ans = answer_text(res)
            grade = grade_fact_recall(q["question"], q["facts"], ans)
            stats = tool_stats(res.get("session_id", ""))
            row[f"recall_{arm}"] = grade["recall"]
            row[f"cost_{arm}"] = res.get("total_cost_usd")
            row[f"turns_{arm}"] = res.get("num_turns")
            row[f"graph_reads_{arm}"] = stats["graph_reads"]
            row[f"grep_{arm}"] = stats["grep"]
            with open(os.path.join(RESULTS, f"{q['id']}.{arm}.json"), "w") as f:
                json.dump({"run": res, "answer": ans, "grade": grade,
                           "tool_stats": stats, "gold_facts": q["facts"]}, f, indent=2)
            print(f"  [{q['difficulty']:8}] arm {arm} recall={grade['recall']:.2f} "
                  f"turns={res.get('num_turns')} graph_reads={stats['graph_reads']} "
                  f"grep={stats['grep']} :: {q['question'][:55]}", flush=True)
        return row

    if args.workers > 1:
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            rows = list(ex.map(process_question, questions))
    else:
        rows = [process_question(q) for q in questions]

    # Aggregate
    def avg(key):
        vals = [r[key] for r in rows if r.get(key) is not None]
        return sum(vals) / len(vals) if vals else None

    summary = {"n": len(rows), "rows": rows}
    if not args.arm or args.arm == "A":
        summary["avg_recall_A"] = avg("recall_A")
    if not args.arm or args.arm == "B":
        summary["avg_recall_B"] = avg("recall_B")
    with open(os.path.join(RESULTS, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)
    print("\n=== SUMMARY ===")
    print(json.dumps({k: v for k, v in summary.items() if k != "rows"}, indent=2))


if __name__ == "__main__":
    main()
