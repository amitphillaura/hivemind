# Graph improvements log — goal: BEAT vanilla Claude Code on the bottleneck Qs

Working dir: .claude/worktrees/graph-cross-file-and-steering (branch
feat/graph-cross-file-and-steering, off 413b9f0b). MOVED here 2026-06-04 from
wt-graph-pull-hash-fix (which had another active session) to isolate the work.
Eval harness: evals/run_ab.py (A=vanilla, B=graph). Grader: 3-vote evidence-required
fact-recall. Corpus: getzep/graphiti @3200afa, graph built in ~/.hivemind.

Method (per user directive 2026-06-04):
- Iterate in SMALL steps; measure after each; keep only what shows a clear signal.
- Brainstorm each decision with a spawned agent; don't jump to big builds.
- Don't ask the user; proceed on initiative.
- When something works on a small subset -> extend the subset (more Qs) to confirm.
- Log every step here for review.

## Baseline (measured, before any change)

~9 distinct graphiti Qs: graph (B) ties-or-loses to vanilla (A), always more turns.
The measured FAILURE we target: "Trace a message's UUID ingestion->retrieval"
(id 6dcd2cbd) — A=0.29, B=0.29. Root cause from transcripts:
  #1 No cross-file `calls` edges (Python) -> path//neighborhood//tour can't trace
     cross-file flows. (resolveCrossFileCalls exists for TS; Python module
     specifiers like `graph_service.dto.common` aren't mapped to files.)
  #2 Node coverage: nested funcs missed (add_messages_task is inside add_messages
     -> absent from the 1013-node graph). extractDeclarations only walks
     top-level + class methods (python.ts:105-136).
  #3 Synthesis/UX: agent read the right files but didn't synthesize; `ls` on the
     mount fails (only cat intercepted); wrong path syntax -> fell back to grep.

## Steps

### STEP 0 — brainstorm which fix first (agent) — DONE
Agent (opus) recommended: do (A) Python cross-file resolution FIRST. Rationale:
- B (nested funcs) and C (steering) are downstream of A — a node with no
  cross-file edges still floats; steering can't fix endpoints that return "(none)".
- The skip is deliberate: cross-file.ts resolveModule bails on non-`./` specifiers,
  so every Python specifier (dotted `graph_service.dto`, bare `.`) returns null.
- MEASURE STRUCTURALLY, not by fact-recall (which conflates retrieval+synthesis):
  count Python cross-file edges (calls+repointed imports) in the snapshot: 0 -> >0,
  and check neighborhood/ no longer says "(none)".
- v1 caveat: instance-method calls (graphiti.add_episode) won't resolve via
  named-import logic; the guaranteed first win is `imports` repointing (unlocks
  neighborhood//tour cross-file neighbors) + module-level function calls.
Plan: add resolvePythonModule(fromFile, specifier, knownFiles) mirroring
resolveModule; branch on ex.language in resolveCrossFileCalls + repointImportEdges.
Suffix-match dotted specifier -> known file. Land resolver+wiring+unit test; do
NOT touch vfs-handler rendering in the same commit.

### STEP 1 — resolvePythonModule + dispatch in resolveModule — DONE, structural WIN
Impl: added resolvePythonModule + matchPythonSuffix in resolve/cross-file.ts;
resolveModule now dispatches by importer extension (.py -> Python resolver). One
change wires all 3 consumers (calls, imports, heritage). Unit test added
(tests/shared/graph/python-cross-file.test.ts, 9 cases) — 41/41 cross-file tests pass.
Rebuilt graphiti graph (HIVEMIND_GRAPH_PUSH=0):
  edges 1391 -> 1819
  cross-file `calls` edges:   0 -> 428
  repointed cross-file imports: 0 -> 349   (still-external 392 = stdlib/3rd-party, correct)
  neighborhood/retrieve.py: was "(none)" -> now shows calls->zep_graphiti +
    imports->dto. Retrieval side of the failing Q now traces.
FINDING: neighborhood/ingest.py still empty — its key call graphiti.add_episode is
INSTANCE-method dispatch (graphiti is an injected ZepGraphiti instance), which the
resolver can't bind (v1 limitation), and it lives in nested add_messages_task.
So nested-func extraction alone won't create that edge; instance dispatch needs
type info (much harder). The 428 edges came from free-function calls via named imports.
NOTE: vfs-handler neighborhood renderer still prints stale "calls edges are intra-file
only" note — now false; fix in a later commit (not this slice).

### STEP 2 — MEASURE real A/B with cross-file edges — DONE, NEGATIVE
  edge attributes:  A 0.88 / B 0.75 (B 10 turns)
  IS_DUPLICATE:     A 0.89 / B 0.89 (tie)
  UUID trace:       A 0.14 / B 0.00 (B 17 turns, 3 graph reads, 0 greps)
Structural win (428 edges) did NOT convert to recall. On the hard Q B got WORSE:
the inject steered it to TRUST the graph and stop grepping (0 greps), but the graph
is still incomplete (instance-method dispatch graphiti.add_episode unresolved +
nested add_messages_task missing) -> B leaned on a partial map -> emptier answer.
LESSON: partial structure can HURT via over-reliance. Validates end-to-end > structural.
ALSO: the "trace the flow" Qs are near-unanswerable for BOTH arms (0.0-0.29, high
variance) -> bad discriminators. Need mid-difficulty Qs (vanilla ~0.4-0.7) with headroom.

### STEP 3 — brainstorm next small step given the negative signal (agent) — DONE
Agent picked (c): reframe steering — graph = navigation INDEX to locate files, then
READ them; never answer from the partial graph. Folds in efficiency as the success
signal + a mid-difficulty test band. Cheapest falsification of "graph helps navigation".

### STEP 4 — reframe inject + ARM_B_HINT, test on mid-difficulty band
Changes (text only): session-context.ts inject reframed (index-then-Read, limitations
up front, `cat` not `ls`, fixed stale "Python intra-file only" line, surfaced
neighborhood/<file>); run_ab.py ARM_B_HINT reframed to match. Bundle rebuilt.
Test band: 6 graphiti Qs, difficulty=moderate, n_context_files in [1,2], 4-8 facts
(evals/moderate_graphiti.json; 83 in band, picked 6 fresh).
SUCCESS SIGNAL: recall_B >= recall_A on >=3 Qs, OR parity (±0.05) with turns_B <= turns_A
(today B uses MORE turns everywhere). Watch turns_B dropping ~10 -> ~4-5 while recall holds.

RESULT — WEAK POSITIVE (first time B avg >= A): avg A=0.589, B=0.595.
  search reranking      A 1.00 / B 1.00  tie (ceiling)
  EntityEdge attr test  A 0.25 / B 0.00  B worse
  episode batch variant A 1.00 / B 1.00  tie (ceiling)
  bulk vs single ingest A 0.29 / B 0.57  *** B WINS ***
  save_entity_node      A 1.00 / B 1.00  tie (ceiling)
  group ID ingest+search A 0.00 / B 0.00  both fail
Mechanism CONFIRMED on the B win (transcript 0437055b): reframed steering worked —
B did find/add_episode_bulk + find/add_episode -> READ graphiti.py -> find more
symbols -> READ edge_operations.py + bulk_utils.py. Graph located the scattered
bulk_utils.py funcs vanilla's grep missed; B read them. Index-then-Read, not
answer-from-graph. Still uses more turns (no efficiency win yet); ceiling Qs don't
discriminate; high variance (lots of 1.0/0.0).
HYPOTHESIS: graph helps on MULTI-SYMBOL COMPARISON/ENUMERATION Qs (compare X vs Y,
which functions are involved) — find/query surfaces scattered related symbols.

### STEP 5 — confirm the regime: comparison/enumeration question class — POSITIVE
N=8 comparison/enumeration Qs (compare_graphiti.json): avg A=0.845, B=0.881.
B wins 3, ties 4, A wins 1. B wins are all cross-file/multi-symbol:
  example script bulk subset    A 0.83 -> B 1.00
  multiple group IDs in search  A 0.67 -> B 1.00  (cross-file flow)
  date filters -> Cypher (nf=3) A 0.62 -> B 0.75
A's one win: "edge step skipped by bulk" A 1.00 -> B 0.67 (B over-explored).
=> FIRST reproducible regime where the graph BEATS vanilla. Accuracy win (not
efficiency — B still sometimes more turns). Driver: find/query surfaces scattered
related symbols; reframed steering makes B READ them instead of answering from graph.

### STEP 6 — EXTEND the positive regime — CONFIRMED at N=16
Combined comparison/enumeration class (compare_graphiti.json batches 1+2, N=16):
  avg recall A=0.787  B=0.876  (+0.089)
  B wins 7, ties 7, A wins 2
  turns A=6.6  B=7.1 (accuracy win, modest extra turns — not an efficiency win)
Standout B wins (multi-symbol / cross-file):
  explicit connection params from demo   A 0.20 -> B 1.00
  multiple group IDs in search flow       A 0.67 -> B 1.00
  embedding generation steps (bulk)       A 0.89 -> B 1.00
  date filters -> Cypher (nf=3)           A 0.62 -> B 0.75
A's 2 wins: "edge step skipped by bulk" 1.00->0.67, "docstrings propagated" 0.62->0.50.

## RESULT — GRAPH BEATS VANILLA on the comparison/enumeration regime
What it took (both shipped in this branch):
  1. Python cross-file call/import resolution (resolve/cross-file.ts: resolvePythonModule
     + dispatch in resolveModule; +9 unit tests). 0->428 cross-file calls, 0->349 imports.
  2. Reframed SessionStart inject + eval hint: graph = navigation INDEX -> then READ
     the files; never answer from the partial graph (session-context.ts). Fixed the
     over-reliance that made B WORSE before this.
Regime: questions that require finding/comparing MULTIPLE related symbols across files
("how are X applied across...", "how do both X and Y...", "what steps...", "which
functions..."). Graph surfaces scattered symbols; agent reads them.
NOT a win on: single-grep lookups (vanilla already aces, ceiling), or pure narrative
flow-trace Qs blocked by instance-method dispatch (graphiti.add_episode) — those need
STEP-2-style instance resolution (deferred).
CAVEAT: single run per Q + LLM grader = directional, not p-valued. Strongest wins
(0.20->1.00, 0.67->1.00) are beyond plausible grader noise. graphiti comparison class
(~17 Qs) nearly exhausted; broader confirmation = another repo or repeats.

### Next options (not yet done)
- Commit the two improvements (cross-file Python resolution + reframed inject) — real
  product gains, tested. (Awaiting user OK per no-blind-commit rule.)
- Update the stale vfs-handler neighborhood note ("calls intra-file only" — now false).
- Extend to another DeepCodeBench repo (e.g. fastai) or add repeats for p50/p95.
- STEP 2 (nested funcs + instance-method dispatch) to also win the narrative flow Qs.
