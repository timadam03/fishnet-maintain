# Run bundles

Recorded Isaac Sim runs, packed for the dashboard by `npm run pack-run` (see `INTEGRATION.md` and
`src/data/runs.ts`). One folder per run plus `index.json`. Bundles are git-ignored; copy or pack
them on each machine that runs the demo.

    npm run pack-run -- --run <run_dir> --rec <rec_dir> [--vision <vision.jsonl>] [--plan <plan.json>]
    npm run pack-run:example     # the small example from contracts/example-run (no telemetry or images)
