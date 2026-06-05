"""Select a mid-difficulty graphiti band with HEADROOM (vanilla likely 0.4-0.7,
still answerable). Rule (from brainstorm): difficulty==moderate, n_context_files
in [1,2], 4<=len(facts)<=8. Excludes ceiling-y single-fact easies and the
~unanswerable 13-16-fact hard flow questions.

Run: uv run --with datasets evals/select_moderate.py
"""
import glob, json, os
import pandas as pd

REPO = "https://github.com/getzep/graphiti.git"
OUT = os.path.join(os.path.dirname(__file__), "moderate_graphiti.json")
CACHE = "/home/emanuele/.cache/huggingface/hub/datasets--Qodo--deep_code_bench/snapshots"

frames = [pd.read_parquet(p) for p in glob.glob(f"{CACHE}/*/data/*.parquet")]
df = pd.concat(frames, ignore_index=True)
rows = [r for _, r in df.iterrows() if (r.get("metadata") or {}).get("repo") == REPO]

def facts_of(r):
    f = r.get("facts")
    return list(f) if f is not None else []

sel = []
for r in rows:
    md = r["metadata"]
    if md.get("difficulty") != "moderate":
        continue
    nf = md.get("n_context_files") or 0
    nfacts = len(facts_of(r))
    if 1 <= nf <= 2 and 4 <= nfacts <= 8:
        sel.append(r)

# Already-run moderate ids to avoid (keep the set fresh):
seen = {"fa25fe30-2d05-4d7c-a517-4859c3dd5720", "591e0b08-b66a-4917-92f1-9d54e2276802"}
fresh = [r for r in sel if r["id"] not in seen]
pick = fresh[:6]

out = {"repo": REPO, "commit": rows[0]["metadata"]["commit"],
       "selection": "moderate, n_context_files in [1,2], 4<=facts<=8 (headroom band)",
       "questions": [{"id": r["id"], "question": r["question"], "answer": r["answer"],
                      "facts": facts_of(r), "difficulty": r["metadata"].get("difficulty"),
                      "commit": r["metadata"].get("commit"),
                      "n_context_files": int(r["metadata"].get("n_context_files") or 0)} for r in pick]}
with open(OUT, "w") as f:
    json.dump(out, f, indent=2)
print(f"moderate band total={len(sel)} fresh={len(fresh)} picked={len(pick)} -> {OUT}")
for q in out["questions"]:
    print(f"  nfiles={q['n_context_files']} facts={len(q['facts'])}  {q['question'][:80]}")
