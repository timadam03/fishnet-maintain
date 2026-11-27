# Decision layer (hackathon demo)

Turns what the swarm sees into decisions, remembers what happened, and learns from how operators close
things. It runs on top of the operator UI's simulated world (`../web/src/data`), which it reads but never
changes, so the UI and the decision layer always show the same site, cells, findings and risk scores.

What it adds to the UI:

| Part | File | What it does |
|---|---|---|
| Net rules | `src/rules/net.ts` | Risk per cell (from the UI's condition × exposure × consequence model) → one outcome: N0 known hole → high alert, N1 stale → sample more, N2 forecast → low alert (one per pen), N3 critical → medium alert, N4 high → close-inspection mission |
| Finding rules | `src/rules/net.ts` | F0 hole ≥ 0.7 → high alert, F1 (learned) low-confidence fraying → re-image first, F2 → operator review |
| Oxygen rules | `src/rules/oxygen.ts` | Sensor string + drone readings per pen and day: O1 sensor with no fresh value → excluded and flagged, O2 < 50% → high alert, O3 ≥ 2 sources < 65% → medium alert + pause feeding, O4 one source → sample more |
| Memory | `src/memory.ts`, `../data/seed_memory.json` | Episodes (seeded history, storms, operations, findings and their outcomes). "Same finding?" and "similar past episode?" asked to d1, with stated fallback rules when d1 is off |
| Learning | `src/curator.ts` | Review statistics per finding kind and confidence → at most one proposal from an allowed list; a person accepts it; the rules change |
| Investigator | `src/investigator.ts` | Answers operator questions with read-only tools over decisions, risk history, findings, operations and memory |
| API | `src/server.ts` | JSON over HTTP for the UI |

All thresholds are demo starting values, not research findings. The seeded episodes are invented. Nothing
here controls farm equipment: farm actions are recommendations a person approves.

## Setup

Node 24 or later (tested on 26.4).

```bash
cd decision-layer
npm run setup    # installs, asks for keys (hidden), lets you pick models, tests them, runs the demo
```

Two kinds of model, both optional. Without them everything runs: decision questions use stated
fallback rules, the curator uses its rule-based version, the investigator says it's off, and every
response says which one answered.

| Variable | Model kind | Used for | Works on the free Vercel AI Gateway tier (checked 27 Nov 2026) |
|---|---|---|---|
| `DECISION_MODEL` | Decision model: typed yes/no questions, returns a probability, no text | "Same finding?" and "similar past episode?" | `liquid/d1.2-ultra`, `liquid/d1.2`. `google/gemini-decision-1` and `typesafe-ai/jev` need paid credits |
| `AGENT_MODEL` | Chat model with tool calling | Investigator and curator | `nvidia/nemotron-3.5-lightning-free`. A plain Gemini name (e.g. `gemini-3.8-flash`) uses an AI Studio key instead |
| `AI_GATEWAY_API_KEY` | | Key for every gateway model | |
| `GOOGLE_GENERATIVE_AI_API_KEY` | | Only for a plain Gemini name in `AGENT_MODEL` | |
| `SHOAL_DB` | | SQLite file for reviews, alert closures, proposals, d1 cache and chat (default `../shoal.db`) | |

## Run

```bash
npm run setup                 # keys and models (tested live), then everything end to end
npm run serve                 # API on http://localhost:8787
npm run cli -- demo           # print the demo beats
npm run cli -- curator        # run the curator once
npm run cli -- accept 1       # accept proposal 1
npm run cli -- ask "Why is Pen 7 at 17.5–20 m high risk?"
npm run cli -- reset          # clear reviews, closures, proposals, chat
```

## Test

```bash
npm test          # node:test, offline (a fake model stands in for d1)
npm run typecheck
```

## API (for `web/`)

`day` is the UI's day index (0–96, today = 89). CORS allows any `http://localhost:*` origin.

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/health` | | today, rules version, which models are live |
| `GET /api/alerts?day=` | | site alerts with `key`, `level`, `title`, `reason`, `recommend`, `rules`, `status` |
| `POST /api/alerts/close` | `{key, status: confirmed\|dismissed, reason?}` | `{ok}` |
| `GET /api/pens/:id?day=` | | cells needing action (with top factors and outcome), oxygen decision, new and open findings |
| `GET /api/pens/:id/oxygen-memory?day=` | | similar past episodes with `linked`, `probability`, `source` (d1 or fallback) |
| `POST /api/findings/:id/review` | `{status: confirmed\|rejected, note?}` | `{ok}`; overrides the simulated history |
| `GET /api/findings/:id/memory` | | `{sameFinding}`: earlier finding it most likely continues |
| `POST /api/ask` | `{question, day?}` | `{text, toolCalls, model}` |
| `POST /api/curator` | `{day?}` | `{proposals, author, note}` |
| `GET /api/proposals` | | all proposals |
| `POST /api/proposals/:id` | `{decision: accepted\|rejected}` | the proposal |
| `POST /api/reset` | | `{ok}` |

## Demo beats (`npm run cli -- demo`)

1. **Today (27 Nov):**
   - one high alert, the known hole in Pen 2;
   - Pen 7's frozen 15 m oxygen sensor is excluded and flagged (O1), not alerted on;
   - Pen 7's sag onto the sinker tube gets a close-inspection mission, with the factors behind it.
2. **8 Nov, delousing:** Pens 3 and 4 hit critical oxygen. Memory recalls the seeded June delousing episode and its outcome.
3. **Pen 4 chafe:** finding 202, low-confidence fraying, was rejected as a fouling shadow. Six days later the same cell was confirmed as chafe (finding 203). Memory links the two.
4. **Learning:** the curator finds that all 4 low-confidence fraying findings were rejected, but one hid real chafe. It proposes "re-image instead of operator review" (F1). Once that's accepted, finding 206 goes to re-image.
