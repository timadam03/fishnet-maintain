# Shoal decision layer: hackathon demo spec

Status: settled 2026-11-27. Build target: 1 day, 1–2 people.

> **Changed during the build (2026-11-27).** The operator UI in `web/` already simulates the site:
> - net cells (24 sectors × 11 rows)
> - 90 days of wear, exposure and oxygen
> - findings with review history
> - a condition × exposure × consequence risk model with explanations
>
> To avoid two engines that disagree, the decision layer now reads that world as its source of truth. This replaces the following parts of this spec:
> - **§3.1–3.3 data contracts and cell ids:** the UI's world and cell indices are used instead.
> - **§3.4 SQLite tables read by the dashboard:** the UI calls an HTTP API instead; SQLite only stores reviews, closures, proposals, d1 cache and chat.
> - **§4.2 weighted points:** the UI's risk score is used.
> - **§6 cases A–C:** the UI's demo cases are used.
> - **The learning beat:** it is now "re-image low-confidence fraying" (rule F1), learned from the simulated review history.
>
> **Models (checked live 27 Nov):**
> - "Gemini decision" means **Gemini Decision 1**. It is a decision model like d1 and Jev, not the agents' chat model. On the Vercel gateway it needs paid credits, as Jev does, so the demo uses `liquid/d1.2-ultra`, which works on the free tier.
> - The agents use any chat model with tool calling. The default is `nvidia/nemotron-3.5-lightning-free` through the gateway.
> - Gemini chat models on the AI Studio free tier had no quota or were retired for new users.
>
> What was built, and how to run it, is in [`decision-layer/README.md`](../decision-layer/README.md). The oxygen rules (§4.1), d1 questions (§4.3), agents (§5) and guardrails still apply in spirit. Oxygen now uses % saturation (warn 65%, critical 50%) as the UI does, and the drift check became a "no fresh value" sensor check.
Background and sources are in [`decision-layer-design.md`](decision-layer-design.md). This file is what we build.

**All numbers in this spec (points, thresholds, tiers) are demo starting values.** We tune them while playing the cases. They are not research findings.

---

## 1. What the demo shows (90 seconds)

| Beat | What judges see | What it proves |
|---|---|---|
| 1. False alarm caught | Probe 7 reads low oxygen. The system sends a drone to check, neighbouring readings disagree, and the alert is **not** raised | Drones can fetch evidence; the system doesn't cry wolf |
| 2. Real pocket | Low oxygen at 8–12 m in cage 4, confirmed by a second drone. Alert raised, feeding pause recommended. **Memory recall:** "looks like the 14 July slack-tide episode, which was real" | Swarm + decision + memory |
| 3. Net cell wearing out | Cell `P4-D12-A135` goes low → medium → high over 4 inspections. Investigator explains: storm 2 days ago, 14 cleaning passes, 40 h of chain contact, fouling up. A close re-image confirms an early mesh opening | Prevention from history, not just hole detection |
| 4. It learns | The curator reads closed outcomes and proposes "add a probe-drift check to the oxygen rules". Operator accepts. Replaying beat 1 now flags the probe straight away, with no drone trip needed | Gets better over time |

**Staged elements, to be honest about in the pitch:**
- all data is mock, in scripted cases
- the "14 July" episode and the earlier drift dismissals are seeded history
- net cells come from the scenario, not real positioning

---

## 2. Architecture for the demo

```
your detection pipeline (Python)        mock scenarios (JSON)
        │ detections.jsonl                  │ readings, exposure, operations, seeded history
        └──────────────┬────────────────────┘
                       ▼
        decision layer (TypeScript, Node 26)
   ingest → rules + risk scoring → d1/Jev questions → decisions/alerts
                       │                       ▲
                       ▼                       │ accept/dismiss, chat
                shoal.db (SQLite) ◄──── your dashboard (Python) reads/writes
                       ▲
        agents (Gemini via AI SDK): investigator, curator
```

**Why TypeScript:** d1/Jev are called through the Vercel AI SDK's `experimental_decide`. BoligRadar's `assignment-3/connector/lib/decisions.ts` already wraps it, so we copy it.

**Why SQLite:** your Python dashboard reads it directly. Node 26 has `node:sqlite` built in (checked: it works on this machine), so no database dependency is needed.

**Agents run in plain code, not LangSmith Fleet.** That's a deliberate choice for one day: no connector deployment and no Fleet compute limits. Fleet stays the "next" story.

---

## 3. Data contracts

### 3.1 Pipeline → decision layer (`data/detections.jsonl`, one JSON per line)

```json
{
  "detection_id": "det-0042",
  "case_id": "C",
  "cell_id": "P4-D12-A135",
  "observed_at": "2026-11-27T09:40:00Z",
  "class": "mesh_opening | biofouling | reimage",
  "confidence": 0.74,
  "severity": "low | medium | high",
  "area_cm2": 12.5,
  "image_ref": "frames/p4/0042.jpg"
}
```

- The pipeline outputs class, confidence and severity/area today.
- **`cell_id` and `observed_at` are added by the scenario** (decision: scenario tags cell + time). Images in a case are assigned to cells by the case script.
- **`reimage`** is the pipeline's "look again" signal. The decision layer turns it into a re-image mission, and the second look's result becomes a label.

### 3.2 Net cell ids

Format: `P{pen}-D{depth band top, m}-A{angle sector start, °}-{I|O}`.

- Depth bands are 4 m: 0, 4, 8, …
- Angle sectors are 45°, with 0° = north, clockwise.
- The I/O suffix (inside/outside) is optional; the demo uses outside only, so it's dropped.

Example: `P4-D12-A135` = pen 4, 12–16 m deep, 135–180° (south-east side).

**Zone, used for points:**

| Zone | Depth band |
|---|---|
| `waterline` | 0–4 m |
| `wall` | middle bands |
| `lower_wall` | the last band above the bottom |
| `bottom` | the cone |

**Side, used for current and storm exposure:** N, E, S or W, from the angle.

### 3.3 Mock scenario inputs (`data/scenarios/*.json`)

| File / key | Content |
|---|---|
| `do_readings` | `{drone_id, probe_id, cage_id, depth_m, x_m, y_m, observed_at, received_at, do_mg_l, temp_c}`. `received_at` is later than `observed_at` to show late acoustic delivery |
| `exposure_daily` | `{pen_id, side, date, current_cm_s_mean, wave_height_m_max}` |
| `operations` | `{op_id, pen_id, cell_ids[], type: cleaning\|repair\|delousing\|wellboat, at, note}` |
| `contact_hours` | `{cell_id, date, chain_contact_h}` (bottom and lower-wall cells) |
| `seed_memory` | Past episodes and outcomes for recall and curator beats |

### 3.4 Decision layer → dashboard (SQLite tables in `shoal.db`)

The dashboard reads these. It writes only `alerts.status`/`closed_*`, `proposals.status` and `chat_messages`.

| Table | Key columns | Dashboard use |
|---|---|---|
| `events` | `event_id, type, case_id, entity_ref, event_time, ingest_time, source, payload_json, supersedes_event_id` | Audit/timeline; append-only |
| `detections` | Contract 3.1 columns + `finding_id` | Evidence list |
| `findings` | `finding_id, cell_id, class, first_seen, last_seen, status (suspected\|confirmed\|false\|repaired)` | Finding lifecycle |
| `cell_risk` | `cell_id, scored_at, points, tier, breakdown_json, rules_version` | **Risk grid** (latest row per cell) + trend |
| `do_zones` | `zone_id, cage_id, depth_from_m, depth_to_m, scored_at, min_do_mg_l, n_readings, n_drones, outcome` | Oxygen panel |
| `decisions` | `decision_id, kind (do\|net), entity_ref, decided_at, outcome, rule_ids, rules_version, inputs_json, d1_json, explanation` | "Why" per decision |
| `alerts` | `alert_id, decision_id, level, title, status (open\|confirmed\|dismissed\|expired), closed_by, closed_reason, closed_at` | Alert feed with confirm/dismiss buttons |
| `missions` | `mission_id, decision_id, kind (resample_do\|reimage_cell), target, requested_at, status, result_ref` | Shows the swarm being re-tasked |
| `memory_nodes` | `node_id, type (episodic\|semantic\|procedural\|preference), text, entity_ref, valid_from, valid_to, source_event_ids` | Memory panel |
| `memory_edges` | `src, dst, relation (same_as\|similar_to\|caused_by\|contradicts), score, created_by` | Linking (d1) |
| `proposals` | `proposal_id, created_at, rule_id, change_json, rationale, evidence_ids, status (open\|accepted\|rejected)` | **Curator card** with Accept |
| `chat_messages` | `msg_id, thread_id, role, text, created_at, tool_calls_json` | Investigator chat |

---

## 4. Decision logic

**Rules version** is stamped on every decision. Each rule set is a typed TypeScript function with unit tests. No rules live in prompts.

### 4.1 Oxygen (per depth zone of a cage)

Demo values for rainbow trout (see design doc §5.3 for sources; "warn" is near the reported appetite drop):

- `warn = 6.0 mg/L`
- `critical = 4.5 mg/L` (a pure demo value)
- `min_drones = 2`
- `persist = 10 min`

| Rule | Condition | Outcome |
|---|---|---|
| R0 | No readings in zone for > 30 min, or input invalid | `ESCALATE` |
| R1 *(added in beat 4)* | Probe's last 3 readings are > 1.0 mg/L below the median of other drones within 10 m and 10 min | Flag probe `suspect_drift`, exclude its readings, no alert |
| R2 | Any valid reading < critical | `ALERT(high)` |
| R3 | ≥ `min_drones` distinct drones < warn for ≥ `persist` | `ALERT(medium)` + `RECOMMEND(pause feeding cage)` |
| R4 | < warn but from 1 drone only | `SAMPLE_MORE` → `missions(resample_do)` to the nearest other drone |
| R5 | otherwise | `OK` |

- **Clearing:** an alert closes as `expired` only after the zone is above `warn + 0.5` for 20 min.
- **Beat 1 without R1:** probe 7 alone is low, so R4 fires and the mission returns normal values. The zone is OK and no alert is raised, but the drone trip was spent. The seeded history shows 3 earlier dismissed drift alerts from probe 7. The curator spots that pattern and proposes R1. Once R1 is accepted, a replay of beat 1 flags the probe immediately with no drone trip.

### 4.2 Net cell risk: weighted points

**Computed per cell after each inspection pass and after each exposure update.**

| Group | Signal | Points |
|---|---|---|
| Condition | `mesh_opening` detection, confidence ≥ 0.5, finding not yet confirmed | +3 (severity medium +1, high +2) |
| Condition | Confirmed mesh opening, not repaired | → **hole path** (see below) |
| Condition | Biofouling coverage ≥ 40% / ≥ 60% (from `area_cm2` / cell area) | +1 / +2 |
| Condition | Fouling rose since the previous pass | +1 |
| Condition | Open `reimage` request on the cell | +1 |
| Condition | Repair patch in the cell (from `operations`) | +2 |
| Exposure | Mean current on the cell's side, last 7 days ≥ 15 / ≥ 25 cm/s | +1 / +2 |
| Exposure | Storm in the last 72 h (wave height ≥ 2.0 m): weather side / other sides | +2 / +1 |
| Exposure | Cleaning passes on the cell since net deployed | +1 per 5, max +3 |
| Exposure | Chain/sinker contact, last 30 days ≥ 10 h / ≥ 40 h | +2 / +3 |
| Consequence | Zone `bottom` or `lower_wall` | +1 |
| Trend | Points rose ≥ 3 since the previous scoring | +2 |

**Tiers and outcomes:**

| Points | Tier | Outcome |
|---|---|---|
| 0–4 | low | `OK` |
| 5–8 | medium | prioritise the cell on the next inspection pass (`missions(reimage_cell)`, normal priority) |
| ≥ 9 | high | `ALERT(medium)` + `missions(reimage_cell)` close-up, urgent |

**Hole path** (applies whatever the points):
- a `mesh_opening` with confidence ≥ 0.7 and severity ≥ medium → `ALERT(high)` "possible hole"
- a confirmed hole → finding `confirmed` → `RECOMMEND(repair)`

**Every `cell_risk` row stores `breakdown_json`**, a list of `{signal, points, evidence_ids}`. The dashboard and the investigator show the top contributors from it. That's the explanation, with no LLM needed for the numbers.

### 4.3 d1/Jev questions

Copy `decisions.ts` from BoligRadar. One `decide` call per question set; log the model, probabilities and cost in `decisions.d1_json`.

| Question | When | Type | Threshold (demo) | Fallback if d1 fails |
|---|---|---|---|---|
| `same_finding`: "Is the new detection the same defect as finding F on this cell?" State = both detections (class, cell, dates, severity, area, notes) | A new detection lands on a cell that already has an open finding | yes/no | link if p(yes) ≥ 0.6 | Same cell + same class within 21 days → link; mark "d1 unavailable" |
| `similar_episode`: "Is this low-oxygen event similar to past episode E?" State = zone, depth, time of day, tide/current, temperature, both summaries | A new oxygen alert (R2 or R3) | yes/no, asked against the top 3 candidates prefiltered by cage and depth overlap | add a `similar_to` edge if ≥ 0.6; show "looks like E" if ≥ 0.75 | No recall shown |

**Fail closed:** if d1 errors, the system never invents a probability. It uses the fallback rule and says so in the explanation (PlugPilot's Rule 0).

---

## 5. Agents (Gemini through the AI SDK)

- **Provider:** `@ai-sdk/google` with an AI Studio key, or Gemini through the Vercel AI Gateway, which uses the same $5 credit as d1.
- **Check first:** whether the student plan includes any API quota. The student offer is a Gemini *app* plan, and I found nothing saying it includes API quota.
- **Model:** whichever Gemini Flash-class model the key allows.

| Agent | Trigger | Tools (all read-only except `propose_change`) | Output |
|---|---|---|---|
| **Investigator** | Operator asks in the dashboard chat ("why is P4-D12-A135 high?", "what happened in cage 4 last night?") | `get_cell_history(cell_id)`, `get_decision(id)`, `get_alert(id)`, `get_exposure(pen, side, from, to)`, `get_operations(pen, from, to)`, `search_memory(text)` | 2–4 sentences: the answer, the top 3 evidence items with dates, and what to do next. Must cite only tool results |
| **Curator** | "Run review" button, or after N closed alerts | `list_closed_outcomes(since)`, `get_rule(rule_id)`, `rule_stats(rule_id)` (precision, false alarms by probe/cell), `propose_change(rule_id, change, rationale, evidence_ids)` | One or two proposals in `proposals`. A human accepts in the dashboard; accepting switches the rule set version (R1 on) |

**Guardrails:**
- Agents never write alerts, scores or rules directly.
- `propose_change` only writes a proposal row.
- The tool loop is capped at 8 steps.
- Every tool call is stored in `chat_messages.tool_calls_json` so judges can see the trace.

---

## 6. The three cases (mock data to write)

**Case A: probe drift (cage 4, 8–12 m), runs at 02:10**
- Probe 7 on drone D3 reads 5.4, 5.3, 5.2 mg/L. Drones D1/D2 within 10 m read 7.8–8.1.
- **Without R1:** R4 fires → `resample_do` to D1 → mission returns 7.9 → zone OK, no alert. One drone trip was spent.
- **Seeded history:** 3 earlier alerts from probe 7 dismissed as "sensor drift" (Oct–Nov).

**Case B: real pocket (cage 4, 8–12 m), runs at 21:30 after the evening feed, slack current**
- D3 reads 5.6, then D1 is sent (R4) and reads 5.5. D2 reads 5.8 → R3 → `ALERT(medium)` + pause-feeding recommendation.
- `similar_episode` against the seeded episode "2026-07-14 cage 4, 8–12 m, after evening feed, slack tide; confirmed; fed resumed after 2 h" → p ≈ high → "looks like 14 July".
- Operator confirms.

**Case C: cell `P4-D12-A135` wears over 4 passes (days −21, −14, −7, 0)**

| Day | Inputs | Points → tier |
|---|---|---|
| −21 | Fouling 30%, 3 cleaning passes, current 12 cm/s | 1 → low |
| −14 | Fouling 45% (rising), 7 passes, contact 12 h | 6 + 2 trend = 8 → medium; re-image prioritised |
| −7 | Fouling 50% (rising), 10 passes, contact 28 h, `reimage` flag | 8 → medium |
| −2 | Storm, waves 2.6 m from the south | Exposure updated |
| 0 | `mesh_opening` confidence 0.58, severity low; fouling 50% (flat); `reimage` still open; 14 passes; contact 41 h; current 22 cm/s on the S side; storm within 72 h | 14 + 2 trend = 16 → **high** |

- At day 0: `same_finding` links the detection to the day −7 `reimage` finding. A close re-image mission returns `mesh_opening` confidence 0.81, severity medium → hole path `ALERT(high)` → finding `confirmed`.
- Investigator question for the demo: "Why did this cell go high?"

The totals follow §4.2 by hand, assuming:
- pen 4's net wall runs 0–16 m, so `D12` is `lower_wall` (+1 consequence, and chain contact applies)
- `A135` maps to the S side, which was the storm's weather side

The scoring code is the source of truth. If its totals differ, adjust the case data until the tiers land as shown.

---

## 7. Project setup

```
auv-hack/
  decision-layer/            # TypeScript, Node 26
    package.json             # deps: ai, @ai-sdk/gateway (+ @ai-sdk/google), zod; dev: typescript, @types/node, vitest or node:test
    src/
      db.ts                  # node:sqlite, schema creation (section 3.4)
      ingest.ts              # load scenario JSON + detections.jsonl → events/detections/...
      rules/oxygen.ts        # section 4.1, pure functions
      rules/netRisk.ts       # section 4.2, pure functions, returns points + breakdown
      d1.ts                  # copied decisions.ts + the two questions + fallbacks
      agents/investigator.ts
      agents/curator.ts
      run.ts                 # CLI: run case A|B|C, replay, run review
    test/                    # unit tests for every rule and tier boundary
  data/scenarios/            # case_a.json, case_b.json, case_c.json, seed_memory.json
  data/detections.jsonl      # from your pipeline (or mock)
  shoal.db                   # created by run.ts; read by the dashboard
```

**Environment variables** (in `.env`, git-ignored; documented in `.env.example`):
- `AI_GATEWAY_API_KEY` for d1/Jev
- `GOOGLE_GENERATIVE_AI_API_KEY`, or Gemini through the gateway

**Commands** (once built):
- `npm run case -- C`
- `npm run review`
- `npm run replay -- A`
- `npm test`

---

## 8. One-day build order (2 people)

| Time | Person 1: decision layer | Person 2: dashboard integration and data |
|---|---|---|
| 0–1 h | Repo setup, `db.ts` schema, copy `decisions.ts`, check both API keys | Write `case_c.json` and `detections.jsonl` for case C |
| 1–3 h | `netRisk.ts` + tests; `ingest.ts` | Risk grid + trend + breakdown panel reading `cell_risk` |
| 3–4 h | `oxygen.ts` + tests; missions table | Write cases A and B and seed memory; oxygen panel + alert feed with confirm/dismiss |
| 4–5 h | d1 `same_finding` + `similar_episode` with fallbacks | Missions and memory display |
| 5–6.5 h | Investigator + curator with tools | Chat box + proposal card with Accept |
| 6.5–8 h | Replay command, end-to-end run of beats 1–4, tune points | Demo polish; rehearse the 90 seconds twice |

**Cut order if behind:**
1. the curator's live run (show a pre-generated proposal instead)
2. `similar_episode`
3. case A
4. **Never cut:** case C, the breakdown explanation, confirm/dismiss.

---

## 9. Still open (small; decide while building)

- [ ] Gemini API quota on your key, or use the gateway.
- [ ] Is d1/Jev access via the AI Gateway still live from the course? Check the credit left of the $5 cap.
- [ ] Your dashboard's chat: call the TS agents through a tiny HTTP endpoint (`node:http`), or have the dashboard write a `chat_messages` row and `run.ts` poll it? An HTTP endpoint is simpler to demo.
- [ ] Cell area in cm² for the fouling % (needed for the 40/60% points), or have the pipeline output coverage % directly.
