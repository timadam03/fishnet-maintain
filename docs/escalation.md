# After the close-ups: d1 #2, engineer review, reports, case export

Branch `feat/escalation` (from `feat/closed-loop`). Code: `decision-layer/src/escalate.ts`, `decision-layer/src/report.ts`, tests in `decision-layer/test/escalate.test.ts`.

## What it does

```
survey -> detector -> d1 #1 (which cells need a closer look) -> plan -> ROVs take close-ups -> missions close
  -> d1 #2 per closed mission: critical? engineer? photos enough?
       critical      -> report agent drafts a report with the photos      -> engineer approves / edits / rejects
       human_review  -> review card with the photos                       -> engineer approves / rejects
       reinspect     -> the next plan looks again (max 2 missions per cell, then a person decides)
       monitor / auto_close -> no one is bothered (an engineer can still mark it as a missed defect)
  -> reviewed cases are exported per farm (FARM_ID) and imported by other farms
```

- **d1 #2** asks four yes/no questions on the mission's own close-ups: `critical`, `needs_human`, `sufficient`, `recurring`. Code sets the thresholds (`decideFromAnswers`). An opening the rules confirmed from two viewpoints always reaches a person, whatever d1 says.
- - **Lined-up close-ups** are judged on the spot the robot aimed at, whichever cell it falls in (`missionView` in `inspection.ts`, the same view that closed the mission). Only a seen opening reaches an engineer (`triageCloseUp`): two viewpoints are critical, one is a review. Signs without an opening (wear, an unsure detector) or a spot that could not be framed are monitored. A framed spot with nothing on it is dismissed, or monitored if the survey had called it a likely opening.
- **Without d1** (no `AI_GATEWAY_API_KEY`, error, rate limit) the rules decide (`decideByRules`), and the reason says so.
- **Report agent** (`AGENT_MODEL`) writes only the summary, what the robots saw, open questions and the recommended action. Code writes the facts and the photo links. Without a model, or if it fails, the report is a template and says so in its last line.
- **Case library**: the `escalations` table in `shoal.db`. `reset` keeps it; `forget-cases` clears it.

## Commands (in `decision-layer/`)

| Command | What |
|---|---|
| `npm run cli -- escalate <run_dir> --grader d1` | Decide every closed mission without a case yet. Reports in `<run_dir>/reports/` |
| `npm run cli -- escalate <run_dir> --grader d1 --again` | Also re-decide cases nobody has reviewed |
| `npm run cli -- escalate <run_dir> --no-agent` | Template reports only (fast, no agent call) |
| `npm run cli -- review` / `review all` | The engineer's queue / every case, plus how often engineers agreed |
| `npm run cli -- review <case> approve --by Name` | Real defect, report as drafted |
| `npm run cli -- review <case> edit <file.md>` | Real defect, with the engineer's own version of the report |
| `npm run cli -- review <case> reject --note "why"` | False alarm |
| `npm run cli -- report <case>` | Print a case's report |
| `npm run cli -- export-cases <file.jsonl> [--all]` | Append reviewed cases (all with `--all`) not yet in the file |
| `npm run cli -- import-cases <file.jsonl>` | Load other farms' cases (this farm's own are skipped) |
| `npm run cli -- forget-cases` | Clear the case library |

`run_loop.ps1` runs `escalate` and `review` by itself after the close-ups are imported (step 5).

Environment (`.env` or `$env:...`): `FARM_ID` (default `farm-demo`), `REVIEWER`, plus the existing `AI_GATEWAY_API_KEY`, `DECISION_MODEL`, `AGENT_MODEL`.

API for the dashboard: `GET /api/escalations?status=pending|all|...`, `GET /api/escalations/:case`, `POST /api/escalations/:case/review` with `{verdict: "real"|"false_alarm", reviewer?, note?, final_report_md?}`.

## Demo run

```powershell
cd C:\fishnet\decision-layer
npm run cli -- forget-cases
cd C:\fishnet
$env:FARM_ID = "farm-north"
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\north -Grader d1
cd decision-layer
npm run cli -- review
npm run cli -- review 1 approve --by Einar
npm run cli -- export-cases C:\abyss_out\cases.jsonl

# second farm, learning from the first
$env:FARM_ID = "farm-south"
npm run cli -- import-cases C:\abyss_out\cases.jsonl
cd C:\fishnet
powershell -ExecutionPolicy Bypass -File abyss-sim\scripts\run_loop.ps1 -Isaac C:\isaacsim51 -Out C:\abyss_out\south -Grader d1 -Seed 8 -KeepMemory
```

Open reports in VS Code and press Ctrl+Shift+V to see the photos.

## If something goes wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| `review` says "nothing waiting for an engineer" | The close-ups didn't see the defect (a hole near the edge of a cell is outside a close-up aimed at the centre), so missions closed "clear" and auto-closed | `npm run cli -- review all` to see every case; try another `-Seed`, or a closer `--standoff`; check `run_plan_d1\overlays` |
| `escalate` prints "no new closed missions to decide" | Cases exist already for these missions, or no mission closed | `escalate <run_dir> --grader d1 --again`; `npm run cli -- missions done` to see closed missions |
| Every case says "by rules" and "d1 #2 unavailable" | No key, wrong `DECISION_MODEL`, or rate limit | Check `AI_GATEWAY_API_KEY` in `C:\fishnet\.env`; the rules result is still valid for the demo |
| Report ends with "Written by: template (...)" | No `AGENT_MODEL`, or the agent failed (reason in brackets) | Set `AGENT_MODEL` in `.env`, then `escalate ... --again` |
| Report images don't show | The report was opened outside its run folder, or the run folder moved | Open it from `<run_dir>\reports\`; links are relative (`../auv_0/...`) |
| Old cases or verdicts from test runs show up | The case library survives `reset` on purpose | `npm run cli -- forget-cases` before the final rehearsal |
| `review <case> ...` says "imported from farm-x" | Imported cases are reviewed at their own farm | Review only this farm's cases (`review` shows `(imported)`) |
| `npm test` / `npm run typecheck` fails | Something in the new files | Paste the output; or go back (below) |
| `run_loop.ps1` stops at the escalate step | The CLI threw an error | Run the `escalate` command by hand to see the message |

## Going back

```powershell
git checkout feat/closed-loop
```

The old loop then runs exactly as before. `shoal.db` isn't in git: the extra `escalations` table stays in it and is simply ignored by the old code.
