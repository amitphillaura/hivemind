# Graph Knowledgebase — A/B Eval Plan

Goal: measure whether the code graph makes Claude Code **better at answering
questions that are answerable from the codebase**. Two arms, same questions,
same repos, same model; the only difference is whether the graph is mounted.

Branch: `fix/graph-pull-hash-mismatch` (worktree `wt-graph-pull-hash-fix`).
The graph product under test: TS/JS + Python extractors, cross-file resolution,
query surface `find/`, `query/`, `impact/`, `neighborhood/`, `path/`, `tour/`,
plus the SessionStart graph inject.

## The A/B design

```
Same N questions, segmented by category
        |
   +----+----+
   v         v
ARM A      ARM B
vanilla    graph built + plugin mounted
claude -p  claude -p --plugin-dir ./claude-code (graph on)
(grep/read (find/query/impact/neighborhood/path/tour + inject)
 only)
   |         |
   +----+----+
        v
  grader (fact-recall for DeepCodeBench; LLM-judge fallback)
        v
  Per arm, per category:
   - answer correctness (fact-recall fraction, or 0/1 graded)
   - turns to answer, tokens, wall-clock
   - tool mix: # greps / reads (Arm A) vs # graph reads (Arm B)
  Smoke test: small N. Real run later: full N, k repeats -> p50/p95.
```

Controls for an honest comparison:
- Same model, same repo at same commit, graph PRE-BUILT (not timing the build).
- Graph arm gets the graph + inject; vanilla arm has it fully disabled.
- Prefer repos the model likely has NOT memorized (avoid React/VSCode).

## Datasets (ranked for us)

1. PRIMARY — **DeepCodeBench (Qodo)**. HF: `Qodo/deep_code_bench`.
   - 1,144 Qs from PRs across 8 OSS repos; require multi-file retrieval.
   - Objective grading via "fact-recall" (extract facts from gold answer,
     check presence in prediction) — low-variance, ideal for a small delta.
   - VALIDATION ANCHOR: published Claude Code baseline = 64%. Arm A should
     reproduce ~64% if the harness is wired right, BEFORE trusting Arm B delta.
   - TODO confirm: which of the 8 repos are TS/JS/Python (graph only supports
     those). Out-of-language repos are out of scope for the graph arm.

2. SECONDARY / adversarial — **SWE-QA-Pro** (ACL 2026, TIGER-AI-Lab).
   GitHub: TIGER-AI-Lab/SWE-QA-Pro; HF: swe-qa/SWE-QA-Benchmark.
   - 720 Qs over 15 Python repos; difficulty-calibrated to DELETE questions a
     direct-answer model can solve (~13pt agent-vs-direct gap). Cleanest proof
     that exploration/graph helps. Python-only -> usable now that we added Py.
   - Categories: intention understanding, cross-file reasoning, multi-hop deps.

Skip for the A/B: CrossCodeEval, RepoQA (completion / needle-retrieval, wrong
shape). Keep RepoQA only for ISOLATED testing of the find/query retrieval layer.

## Metrics

- Correctness: fact-recall fraction (DeepCodeBench) or graded 0/1 (SWE-QA-Pro).
- Efficiency: turns, output tokens, wall-clock per question.
- Behavior: did Arm B actually consult the graph? count graph reads vs greps.
- Segmentation: report per-category (single-file / cross-file / multi-hop).
  A single aggregate number hides where the graph wins.

## Feasibility findings (step 1 done)

- DeepCodeBench is **100% Python** (1144 rows, train 912 / test 232). Repos:
  fastai 209, getzep/graphiti 188, diffusers 181, qlib 160, transformers 152,
  xgboost 131, LightGBM 89, keras 34. -> fully in-language (Python extractor).
- Difficulty: moderate 938, hard 159, easy 47.
- Schema: question, answer, facts[], metadata{commit,difficulty,repo,pr,
  n_context_files,n_context_nodes,includes_code,is_core_question,...}, id.
- CAVEAT: Python extractor (python.ts) resolves intra-file calls + heritage
  but NOT cross-file calls yet (TS has it via B3; Python is a follow-up). So
  on this all-Python set the graph helps most with imports / definitions /
  intra-file structure; cross-file call chains are a known weak spot. Segment.
- Global hivemind (v0.7.71) graph is the STALE "TypeScript only" build. Must
  build the worktree bundle to get Python + find/query, and run Arm B via
  `--plugin-dir ./claude-code`.
- MEMORIZATION: transformers/diffusers/keras are heavily memorized -> Arm A
  can cheat from weights. Smoke-test target = **getzep/graphiti** (recent,
  low memorization, 188 Qs). Real run can broaden to qlib/fastai.

## Execution steps

1. [x] Pull DeepCodeBench from HF; inspect schema, repo list, languages.
       -> all Python; smoke target graphiti.
2. [x] Smoke subset = 12 graphiti Qs at commit 3200afa -> evals/smoke_graphiti.json.
3. [x] Cloned graphiti at 3200afa -> /home/emanuele/39_claude_code_plugin/eval-repos/graphiti (117 .py).
4. [x] Built graph: 1013 nodes / 1391 edges, 0 parse warnings. VFS probe OK:
       find/query/show/index all return rich Python output (sig, fan_in/out, edges).
5. [ ] Harness evals/run_ab.py: per question launches `claude -p` twice:
         Arm A: vanilla (no plugin) — installed hivemind DISABLED so no graph leaks.
         Arm B: `--plugin-dir <worktree>/claude-code` — local build, graph mounted.
       Subprocess env: DEEPLAKE_CAPTURE=false, HIVEMIND_GRAPH_PUSH=0,
       HIVEMIND_GRAPH_PULL=0 (hermetic). Capture answer + cost/turns via
       --output-format json.
6. [ ] Grader: fact-recall (one judge call per question lists all gold facts,
       returns present booleans) -> recall fraction per arm.
7. [ ] VALIDATION: Arm A fact-recall ballpark vs published CC=64% (loose; smoke
       is one repo, not the full benchmark).
8. [ ] Run both arms; per-arm + per-difficulty metrics; report delta.
9. [ ] Re-run on SWE-QA-Pro as the adversarial confirmation.

## Smoke run #1 (N=1, easy graphiti Q) — findings 2026-06-04

Rig VALIDATED: both arms run hermetically; Arm B's `cat ~/.deeplake/memory/
graph/find/extract_attributes` was intercepted and returned graph data
(transcript afd11afe). Pipeline works end-to-end.

NOT trustworthy yet:
- Grader unreliable: scored Arm B recall=1.00 on a terse answer that does NOT
  support the location-specific gold facts (resolve_extracted_edge in
  edge_operations.py). Single lenient judge call -> must harden:
  per-fact independent judgment, strict prompt, persist per-fact booleans +
  the answer, multi-vote.
- N=1 + grep-answerable easy Q with hyper-specific facts = poor discriminator.
  Bias subset to moderate/hard cross-file / multi-hop questions.
- Arm A read the WRONG function (node_operations) yet sounded confident;
  Arm B used the graph then also grepped. Behaviour signal worth logging
  (graph-read vs grep counts) alongside recall.

## Smoke run #2 (N=4, HARD graphiti Qs) — findings 2026-06-04

Result: avg recall A(vanilla)=0.90 vs B(graph)=0.87. Per-Q:
  Q1 triplet-dedup    A 0.92 / B 0.85   (B: 1 graph-read + 3 grep)
  Q2 embedding error  A 1.00 / B 1.00
  Q3 podcast sequence A 0.69 / B 0.62   (B: 2 graph-read, 11 turns vs 5)
  Q4 server init LLM  A 1.00 / B 1.00

GRAPH IS REDUNDANT HERE (does NOT lift answer recall; slight cost in turns/$):
- Transcripts confirm the graph RETURNS relevant hits (query/triplet ->
  resolve_extracted_edges@edge_operations.py:247; find/embedding -> 21 right
  symbols). So retrieval quality is fine.
- But B uses the graph to NAVIGATE (locate file/symbol) then greps/reads the
  file for DETAILS. Recall is set by reading file content, which BOTH arms do.
  On a strong base model that greps competently, graph navigation duplicates
  what grep already does -> no accuracy gain, +1 turn overhead.
- CEILING EFFECT: vanilla already at 0.90 on hard Qs -> little headroom.
- graphiti is small (117 files) -> grep is cheap; graph's "find fast" edge
  doesn't matter when the haystack is small.

WHERE THE GRAPH COULD STILL WIN (next experiments):
  1. Relationship / blast-radius questions grep can't answer in one shot:
     "who calls X across files", "impact of changing Y" -> use impact/ and
     author such Qs (DeepCodeBench doesn't frame questions this way).
  2. Bigger / less-familiar codebases where grep fans out a lot.
  3. EFFICIENCY metric at matched accuracy: graph wins only if it REPLACES
     greps (fewer turns/tokens), which needs stronger steering to trust the
     graph over grep. Measure turns/tokens, not just recall.

## Bottleneck hunt (broad x non-searchable subset) — 2026-06-04

Selected the 21 broad(n_ctx>=3) AND non-searchable graphiti Qs (papers' weak
spot). Round-1 vanilla on 3 fresh hard flow Qs (parallel workers=3):
  - outline flow resolving extracted entities   A=1.00 (3 grep)
  - fulltext relationship search sequence        A=0.92 (7 grep)
  - trace message UUID ingestion->retrieval      A=0.29 (4 turns, 0 grep) FAIL

Graph arm on the FAILING UUID Q: B=0.29 too (22 turns, 4 graph reads, 1 grep).
GRAPH DID NOT HELP. Root cause (read both answers + 14 gold facts):
both arms covered the INGESTION half (add_messages_task -> add_episode(uuid))
and the final return, but got sidetracked on a message-UUID-vs-edge-UUID
provenance nuance and NEVER traced the RETRIEVAL endpoint half (GET
/entity/{uuid}/edge -> get_entity_edge -> Edge.get_by_uuid -> Cypher MATCH ->
get_fact_result_from_edge, facts 9-13). That is a REASONING/COVERAGE failure,
not a findability failure: vanilla gave up (0 greps); the graph arm explored
hard but didn't DECIDE to trace retrieval. The needed nodes (get_entity_edge,
get_by_uuid) exist in the graph; the model just didn't query them.

EMERGING CONCLUSION (tested ~6 distinct Qs across easy/hard/bottleneck):
On a 117-file repo, vanilla grep already finds code well. It succeeds when it
explores; it fails from under-exploration / misframing, which the STRUCTURAL
graph does not fix. No clean "searches hard but can't find the cross-file link"
failure has appeared where the graph would win. This matches the user's own
audit (memory project_graph_eval_direction): the missing multiplier is SEMANTIC
(LLM per-file summaries + fuzzy search), not more AST structure. If the next
head-to-head (set-of-functions Qs) also shows no graph win -> trigger the
pivot: new worktree off this branch -> Block E (file summaries) + Fuse.js.

## Plugin sandboxing (critical)

The installed hivemind (v0.7.71, stale) SHADOWS `--plugin-dir`. So the harness
must `claude plugin disable hivemind` once before the run (gives a clean Arm A
with NO graph, and lets Arm B load the local build), and RE-ENABLE after.
This mutates global Claude config — get user OK before toggling.

## Caveats / honest notes

- Smoke test N is small -> low statistical power. Treat as directional only;
  the real run uses full N with k repeats and p50/p95.
- The graph arm advantage depends on questions that NEED cross-file/multi-hop
  reasoning. If a question is answerable with one grep, both arms tie.
- DeepCodeBench data availability confirmed (HF). Repo-language coverage TBD
  in step 1.

## FINAL VERDICT (2026-06-04) — pure AST graph does NOT beat vanilla CC

Head-to-head set-of-functions Qs: A=0.88 vs B=0.82. Full tally (~9 distinct Qs):
  easy episode_content        A 0.33 / B 0.33  tie
  4 hard flow                 A 0.90 / B 0.87  vanilla
  UUID-trace (vanilla FAILED) A 0.29 / B 0.29  tie (graph didn't rescue)
  set-of-functions x2         A 0.88 / B 0.82  vanilla
Graph ties at best, loses on average, ALWAYS costs more turns (B 12-22 vs A 4-8).
The single vanilla failure was reasoning/coverage, unfixable by structure.
=> PIVOT to file-summaries + Fuse.js (Block E), no embeddings, in a new worktree
   off fix/graph-pull-hash-mismatch. Eval harness in evals/ is reused to measure
   whether summaries+fuzzy close the gap on the bottleneck (broad/non-searchable).
