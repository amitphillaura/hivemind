"""Select the COMPARISON / ENUMERATION question class — where the graph plausibly
helps by surfacing multiple scattered related symbols (find/query). Cues in the
question text: differ / versus / both / which functions / what steps / compare /
each / all the. Mid-difficulty, answerable. Excludes already-run ids.

Run: uv run --with pandas --with pyarrow evals/select_compare.py
"""
import glob, json, os, re
import pandas as pd

REPO = "https://github.com/getzep/graphiti.git"
OUT = os.path.join(os.path.dirname(__file__), "compare_graphiti.json")
CACHE = "/home/emanuele/.cache/huggingface/hub/datasets--Qodo--deep_code_bench/snapshots"

CUE = re.compile(
    r"\bdiffer\b|\bversus\b|\bvs\b|\bboth\b|which functions|what functions|"
    r"what steps|\bcompare|each of|all the|involved in|how are |list (of |the )",
    re.I,
)

def facts_of(r):
    f = r.get("facts")
    return list(f) if f is not None else []

frames = [pd.read_parquet(p) for p in glob.glob(f"{CACHE}/*/data/*.parquet")]
df = pd.concat(frames, ignore_index=True)
rows = [r for _, r in df.iterrows() if (r.get("metadata") or {}).get("repo") == REPO]

# already-run ids (smoke + bottleneck + moderate) to keep the set fresh
ran = set()
for f in glob.glob(os.path.join(os.path.dirname(__file__), "results", "*.json")):
    b = os.path.basename(f)
    if b == "summary.json":
        continue
    ran.add(b.rsplit(".", 2)[0])

sel = []
for r in rows:
    md = r["metadata"]
    if md.get("difficulty") not in ("moderate", "hard"):
        continue
    nfacts = len(facts_of(r))
    if not (4 <= nfacts <= 9):
        continue
    if not CUE.search(str(r["question"])):
        continue
    if r["id"] in ran:
        continue
    sel.append(r)

pick = sel[:8]
out = {"repo": REPO, "commit": rows[0]["metadata"]["commit"],
       "selection": "comparison/enumeration intent, 4-9 facts, fresh",
       "questions": [{"id": r["id"], "question": r["question"], "answer": r["answer"],
                      "facts": facts_of(r), "difficulty": r["metadata"].get("difficulty"),
                      "commit": r["metadata"].get("commit"),
                      "n_context_files": int(r["metadata"].get("n_context_files") or 0)} for r in pick]}
with open(OUT, "w") as f:
    json.dump(out, f, indent=2)
print(f"compare-class total={len(sel)} picked={len(pick)} -> {OUT}")
for q in out["questions"]:
    print(f"  [{q['difficulty']:8} nf={q['n_context_files']} facts={len(q['facts'])}] {q['question'][:78]}")
