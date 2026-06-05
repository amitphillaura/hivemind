"""Inspect DeepCodeBench: repo/language distribution, difficulty, samples.

Run: uv run --with datasets --with pandas evals/inspect_dataset.py
"""
import collections
import json

from datasets import load_dataset

ds = load_dataset("Qodo/deep_code_bench")
print("Splits:", {k: len(v) for k, v in ds.items()})

rows = list(ds["test"]) + list(ds["train"])
print("Total rows:", len(rows))

repos = collections.Counter()
difficulty = collections.Counter()
for r in rows:
    md = r.get("metadata") or {}
    repos[md.get("repo", "?")] += 1
    difficulty[md.get("difficulty", "?")] += 1

print("\n=== Repos (metadata.repo) ===")
for repo, n in repos.most_common():
    print(f"  {n:5d}  {repo}")

print("\n=== Difficulty ===")
for d, n in difficulty.most_common():
    print(f"  {n:5d}  {d}")

print("\n=== 3 sample questions (test split) ===")
for r in list(ds["test"])[:3]:
    md = r.get("metadata") or {}
    print(f"\n- repo={md.get('repo')} difficulty={md.get('difficulty')} n_context_files={md.get('n_context_files')}")
    print(f"  Q: {r['question']}")
    facts = r.get("facts") or []
    print(f"  facts: {len(facts)}")
