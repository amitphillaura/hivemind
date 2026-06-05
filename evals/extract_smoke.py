"""Extract a graphiti smoke subset from DeepCodeBench.

Picks questions for getzep/graphiti, groups by pinned commit, and writes the
largest-commit subset to evals/smoke_graphiti.json. Also prints commit counts.

Run: uv run --with datasets evals/extract_smoke.py
"""
import collections
import json
import os

from datasets import load_dataset

REPO = "https://github.com/getzep/graphiti.git"
OUT = os.path.join(os.path.dirname(__file__), "smoke_graphiti.json")

ds = load_dataset("Qodo/deep_code_bench")
rows = list(ds["test"]) + list(ds["train"])

g = [r for r in rows if (r.get("metadata") or {}).get("repo") == REPO]
print(f"graphiti rows: {len(g)}")

by_commit = collections.Counter((r["metadata"].get("commit") for r in g))
print("\n=== graphiti commits ===")
for c, n in by_commit.most_common():
    print(f"  {n:4d}  {c}")

top_commit = by_commit.most_common(1)[0][0]
subset = [r for r in g if r["metadata"].get("commit") == top_commit]

# Prefer a spread of difficulties; cap at 12 for a smoke test.
by_diff = collections.defaultdict(list)
for r in subset:
    by_diff[r["metadata"].get("difficulty")].append(r)
smoke = []
for diff in ("easy", "moderate", "hard"):
    smoke.extend(by_diff.get(diff, [])[:4])
smoke = smoke[:12]

out = [
    {
        "id": r["id"],
        "question": r["question"],
        "answer": r["answer"],
        "facts": r.get("facts") or [],
        "difficulty": r["metadata"].get("difficulty"),
        "commit": r["metadata"].get("commit"),
        "n_context_files": r["metadata"].get("n_context_files"),
        "pr": r["metadata"].get("pr"),
    }
    for r in smoke
]
with open(OUT, "w") as f:
    json.dump({"repo": REPO, "commit": top_commit, "questions": out}, f, indent=2)

print(f"\nTop commit: {top_commit}  ({len(subset)} rows)")
print(f"Wrote {len(out)} smoke questions -> {OUT}")
for q in out:
    print(f"  [{q['difficulty']:8}] {q['question'][:90]}")
