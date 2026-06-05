"""Classify DeepCodeBench graphiti questions into the bottleneck buckets the
papers flag (Broad x Non-searchable), so we test the graph where vanilla CC
is weakest.

- Broad: spans multiple files. Proxy = metadata.n_context_files >= 3.
- Searchable: the question text contains a code-like identifier a grep could
  target (snake_case, CamelCase, or foo()). Non-searchable = none of those.

Writes the Broad & Non-searchable subset to evals/bottleneck_graphiti.json.

Run: uv run --with datasets evals/classify_bottleneck.py
"""
import collections
import json
import os
import re

from datasets import load_dataset

REPO = "https://github.com/getzep/graphiti.git"
OUT = os.path.join(os.path.dirname(__file__), "bottleneck_graphiti.json")

IDENT = re.compile(r"\b[a-z]+_[a-z_]+\b|\b[a-z]+[A-Z][A-Za-z]+\b|\b\w+\(\)")


def is_searchable(q: str) -> bool:
    return bool(IDENT.search(q))


ds = load_dataset("Qodo/deep_code_bench")
rows = [r for r in (list(ds["test"]) + list(ds["train"]))
        if (r.get("metadata") or {}).get("repo") == REPO]
print(f"graphiti questions: {len(rows)}")

buckets = collections.Counter()
bottleneck = []
for r in rows:
    md = r["metadata"]
    broad = (md.get("n_context_files") or 0) >= 3
    searchable = is_searchable(r["question"])
    key = ("broad" if broad else "deep", "search" if searchable else "nonsearch")
    buckets[key] += 1
    if broad and not searchable:
        bottleneck.append(r)

print("\n=== 2x2 distribution (scope x searchability) ===")
for k, n in sorted(buckets.items()):
    print(f"  {k[0]:6} / {k[1]:10}  {n}")

# Spread the bottleneck subset across difficulty; cap at 8.
by_diff = collections.defaultdict(list)
for r in bottleneck:
    by_diff[r["metadata"].get("difficulty")].append(r)
subset = []
for d in ("hard", "moderate", "easy"):
    subset.extend(by_diff.get(d, []))
subset = subset[:8]

out = {
    "repo": REPO,
    "commit": rows[0]["metadata"]["commit"],
    "selection": "broad (n_context_files>=3) AND non-searchable (no identifier)",
    "questions": [
        {
            "id": r["id"], "question": r["question"], "answer": r["answer"],
            "facts": r.get("facts") or [], "difficulty": r["metadata"].get("difficulty"),
            "commit": r["metadata"].get("commit"),
            "n_context_files": r["metadata"].get("n_context_files"),
        }
        for r in subset
    ],
}
with open(OUT, "w") as f:
    json.dump(out, f, indent=2)

print(f"\nBroad & Non-searchable total: {len(bottleneck)}; wrote {len(out['questions'])} -> {OUT}")
for q in out["questions"]:
    print(f"  [{q['difficulty']:8} ctx={q['n_context_files']}] {q['question'][:85]}")
