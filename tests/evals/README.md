# Evals

Manual, pre-release LLM quality checks. NOT run in CI.

## Why a separate dir + `.eval.ts` extension

`vitest.config.ts` only picks up `**/*.test.ts` files by default. Evals
use `.eval.ts` so they are invisible to the normal `npm test` run —
which we want, because:

- Evals call the real Anthropic API (cost + latency)
- Eval outcomes are inherently flaky (LLM stochasticity); they would
  cause spurious CI failures
- The right cadence for evals is "before bumping a model id" or
  "after touching the system prompt," not "every PR"

## Running

```bash
# Set the API key
export ANTHROPIC_API_KEY=sk-...

# Run all evals
npx vitest run tests/evals --include 'tests/evals/**/*.eval.ts'

# Run one eval
npx vitest run tests/evals/kpi-generation.eval.ts --include 'tests/evals/**/*.eval.ts'
```

Each eval prints per-case quality output. The pass criterion is "no
catastrophic regressions" — not strict equality. Read the printed
output and use judgment.

## Bumping a model

When the default model (`HIVEMIND_KPI_MODEL`, currently
`claude-sonnet-4-6`) is bumped:

1. Run `npx vitest run tests/evals` against the OLD model id and
   capture output.
2. Bump the default in `src/tasks/kpi-generator.ts`.
3. Re-run against the NEW model id.
4. Compare. If the new model regresses on any canonical input,
   either fix the prompt or hold the bump.
