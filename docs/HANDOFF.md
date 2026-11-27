# Handoff: Shoal decision layer → Fleet build

Date: 2026-11-27.
For: the teammate taking over the design of the agent fleet build.
Companion doc: [`decision-layer-design.md`](decision-layer-design.md) is the full design, research and sources. This handoff tells you what's in it, what's decided, what's open and where to start.

---

## 1. Where we are in one paragraph

We researched what sea-cage fish farms actually decide every day: Danish trout first, then Norwegian salmon, then Mediterranean bream and bass. We mapped 18 of those decisions to the kind of decider that should make each one, and designed a shore-side decision and memory layer on top of the Shoal swarm. We also added *preventive* net-damage risk as the strongest use case for memory.

What exists is a design. **No code, no schemas, no agent configs and no eval set exist yet.** Your job is to turn the design into a Fleet build plan and then a first build.

---

## 2. Materials

The local paths are on the original author's machine; ask them for copies.

| What | Where | Why read it |
|---|---|---|
| Design doc (main deliverable) | `auv-hack/docs/decision-layer-design.md` | Everything below in full, with sources |
| Pitch deck | `ABYSS Robotics Pitch.pdf` / `Pitch23.pptx` | Business framing: Denmark → Mediterranean → infrastructure; 15–30k DKK per site per month |
| Engineering overview | `Shoal - Engineering Overview v2.pdf` | Hardware, positioning, mapping (Gaussian process / kriging), the on-drone safety layer and state machine. **Its constraints bind us** (§4 below) |
| Net damage note | `Preventive Net Damage Detection for Salmon Farm Pens.pdf` | Risk model, hotspots, inputs, open questions on nets |
| Earlier Fleet builds | `~/Desktop/ai-for-entrpeneurs/` | The patterns we reuse (§6) |
| Domain research raw notes | Scratch file from the research pass; may be gone | Not needed: everything with sources is in the design doc |

---

## 3. Key findings (short version; sources in the design doc)

1. **The Danish pilot is about oxygen and feed, not lice.**
   - Danish sea trout farms have no sea-lice regime.
   - Permits rest on a nitrogen/phosphorus mass balance computed from feed and fish weight, under the Danish reporting order (BEK 1178/2024).
   - Our inference: proving low feed waste is worth permit headroom.
   - Reporting is due within 7 days for escapes, disease and extraordinary mortality, plus a daily feed log and an annual report.
2. **Norway is about escapes, nets and welfare.**
   - Nets must be checked before, during and right after risky operations; the farm's risk assessment sets the frequency.
   - Escape-risk deviations are reported immediately.
   - Sea mortality in 2025 was 14.2% for salmon and 17.0% for trout.
3. **Low oxygen is real inside cages.**
   - Below 30% saturation has been measured in large cages, and fish crowd at 1.5–5× nominal density.
   - This is the direct case for mapping the whole cage instead of reading one buoy.
   - Oxygen thresholds are **configurable starting values**, not rules.
4. **Net holes are the #1 escape cause, and wear holes can be predicted.**
   - Contact between the net and the sinker-tube chain caused >50% of escaped fish (2008–2010).
   - Events of more than 10,000 fish were 19% of incidents but 91% of escaped fish.
   - These statistics are older Norwegian salmon data.
5. **Farms' stated pain is fragmented systems and overloaded staff.** This is weakly sourced (one seminar write-up, one BCG piece). **The farm interviews must confirm it.**

---

## 4. Design decisions: keep these unless there's new evidence

| Decision | Why |
|---|---|
| **The decision layer runs on shore and only advises the swarm.** It sends mission requests; the on-drone safety layer and state machine always have the final say. No LLM or hosted model in any control loop | The engineering overview: drones carry on if the shore link drops, and hard limits always win |
| **"Action" means three things:** re-task the swarm, alert a person, draft records and reports. We do not control farm equipment | Honest scope; feeders and oxygen systems belong to the farm |
| **Choose the decider per decision.** Rules in code, statistics/Gaussian process, and classifiers do most of the work (14 of 18). A small "System One" decision model (Jev/d1-style) handles narrow fuzzy yes/no questions. An LLM only explains, drafts and proposes. Humans approve anything that costs money, touches fish or goes to a regulator | The PlugPilot and BoligRadar lessons (§6) |
| **"Sample more" is a first-class outcome** | The swarm can fetch more evidence cheaply. It's the swarm version of PlugPilot's "test step" |
| **Fail closed.** If a model or input is missing, the outcome is ESCALATE or SAMPLE_MORE, never a guessed number | PlugPilot's agent invented probabilities when its decision model failed |
| **Use an append-only, bi-temporal event log as the system of record** (it stores both when something happened and when we received it) | Data arrives late and out of order over acoustic links, and audits need "what did we know at 03:00" |
| **Memory has two scopes:** per-site memory, and anonymised fleet priors shared across farms (with consent) | "New farms get a better product" comes from the shared priors |
| **Memory is mostly structured** (tables, counters, history per net cell). The Jev-Mem-style graph is for text: findings, incidents, notes, lessons | Most Shoal memory is numeric |
| **Every alert closes as confirmed, dismissed or expired** | Without labels nothing learns |
| **Storage is one Postgres database.** The knowledge graph is two tables in it; no graph database yet | Keep it simple until queries prove otherwise |

---

## 5. Decisions you need to get from the team before designing the build

1. **Scope:** a hackathon demo on sim data, or the real pilot architecture?
2. **"Fleet" here:**
   - Assumed: **LangSmith Fleet** (AGENTS.md, subagents, skills, tools.json, memories), like PlugPilot.
   - If it means something else (own orchestration, the drone fleet itself), the plan changes.
3. **Order of decisions.** Suggested: low oxygen (#1) → feed waste (#6) → net holes (#7–#9) → net-area risk (#17).
4. **Hosted or local models** for the decision model (d1/Jev vs a local model such as Laya or a small fine-tune) and for the LLM.
5. **Data store for the prototype.** Postgres per the design, or Google Sheets like the course projects for speed? Sheets is fine for a Fleet demo but not for time series.
6. **"Gemini decision":** we assumed it means Gemini as a general LLM. Confirm with the original author.

---

## 6. What to reuse from the earlier Fleet builds

All under `~/Desktop/ai-for-entrpeneurs/`.

| Look at | What to take | Pitfall seen there |
|---|---|---|
| `final-project/fleet/AGENTS.md`, `subagents/` (curator, dispatcher, safety-gate), `skills/` (fault-triage, dreaming, owner-playbooks, weekly-scorecard) | The topology: a manager plus specialist subagents, with only the manager posting. Keep the separate safety gate that can only *tighten* a verdict. Keep the dreaming/curator memory loop | Routing rules lived only as prose in the live agent (`skills/fault-triage/SKILL.md`); only the offline eval had them in code (`eval/triage_rules.py`) |
| `final-project/eval/` (`run_eval.py`, `triage_rules.py`, `results.md`) | A planted eval set, cached decision-model answers, logged cost, and comparing untuned vs tuned results (14/48 → 39/48) | Tuned and scored on the same 48 cases. **Hold out a test set** |
| `final-project/fleet-export/PlugPilot/tools.json` | The Auto/Ask setting per tool | Destructive Sheet tools not set to Ask; subagents had the full toolset. **Enforce least privilege in tools, not prompts** |
| `assignment-3/connector/` (Next.js on Vercel, `lib/listing-screen.ts`) | A custom connector (MCP server) that calls the decision model and **computes the verdict in code**. This is the pattern for Shoal's decision tools | PlugPilot planned its own connector but never built it |
| `assignment-3/fleet/skills/memory-graph/SKILL.md` | A Jev-Mem-style memory graph: typed nodes, edges stored only at score ≥ 0.6, weekly merges, nothing deleted | A reworded question moved a score from 0.30 to 0.994; version question text |
| `Commitment-Guardian/AGENTS.md` | PASS/FAIL/UNKNOWN per constraint, abstain on UNKNOWN; re-check evidence after approval, and let approvals expire | — |
| Course limits from the free tier | About 5 LCU of Fleet compute, about 5 requests/minute on the AI gateway, a $5 cap | Plan the eval and demo around these |

**New for Shoal: nobody approves underwater.** Every earlier build assumed a person answering in chat. Here the drones fall back to their own safe state, and shore escalates through the alert ladder.

---

## 7. Suggested Fleet shape: a starting point, not decided

Derived from design doc §5.6. Decision logic lives in a **connector**; agents call it and never re-implement rules in prose.

| Component | Role | Tools: Auto | Tools: Ask |
|---|---|---|---|
| **Manager** | The only agent that talks to the operator; routes requests; posts alerts and digests | Read state, post to the alert channel at levels ≤ medium | High-level alerts that page or call, anything sent outside the company |
| **Investigator** (subagent) | "Why was cage 4 low last night?"; incident timelines | Read event log, maps, knowledge graph, weather/tide | — |
| **Safety gate** (subagent) | Can only tighten: blocks dismissing an alert while readings are still bad; enforces cooldowns | Read only | — |
| **Report drafter** (subagent) | Regulator report drafts, the Danish annual report data, permit evidence | Read incidents and KPIs, write drafts | Send |
| **Curator** (subagent, nightly) | Consolidates memory, flags stale facts, proposes rule, threshold and question changes from outcomes | Read all, write proposals and memory edges | Change a rule, threshold or model |
| **Record ingester** (subagent) | Turns cleaning logs, repair notes and service-station PDFs into events (decision #18) | Read inbox/files, write *draft* events | Commit events that change a net record |
| **`shoal-decide` connector** (code, like BoligRadar's) | `evaluate_do_zone`, `score_net_risk`, `link_finding` (calls the decision model), `request_mission`, `close_alert` | Pure functions, versioned, unit tested | `request_mission` goes through the gateway checks |

---

## 8. Next steps, in order

1. **Get the answers to §5** from the team (about 30 minutes).
2. **Write the build plan** in PlugPilot `BUILD_PLAN.md` style. It needs:
   - event and decision schemas
   - connector tool signatures
   - the mission-request message format (ROS 2 or MAVLink via the surface node)
   - the agent list with Auto/Ask per tool
   - skills and memory files
   - the eval scenario list with a held-out split
   - milestones tied to the hardware roadmap (swarm of 3–5 drones in H1 2027, Danish pilot in H2 2027)
3. **Build slice 1 on sim data:** sim readings → event log → oxygen map with confidence → low-oxygen rules → ALERT and SAMPLE_MORE (executed by the sim) → confirm/dismiss feedback → eval script. The exact steps are in design doc §9.
4. **In parallel: farm interviews** (questions in design doc §10, including the new net-risk questions).
5. **Slice 2:** net findings and net-area risk with wear planted in the sim. **Slice 3:** the curator, record ingester and weekly review.

---

## 9. Unverified, missing or caveated

- **From search summaries only:**
  - trout oxygen limits
  - the ~40% fouling trigger for washing
  - Lillebælt low bottom-water oxygen in 2024
  - Danish nitrogen-based permit refusals
  - the escape-cause ranking for 2010–2018
- **Not found:**
  - ROV and diver inspection costs (needed for pricing)
  - any data on alarm fatigue
  - any farmer survey of needs
  - post-storm mooring inspection intervals
- **Norwegian § numbers** were extracted automatically and a new regulation is in consultation. Check them before hard-coding.
- **Jev-Mem's results are self-reported** on one benchmark. Its default controller is a hosted API (TypeSafe); the repo is MIT but the controller is not.
- **Net-damage statistics are Norwegian salmon data from 2006–2018.** Check how Danish trout nets and weight systems differ.
- **The inferred flow** (current estimated from drone drift) is research-grade per the engineering overview. Don't build net-risk exposure on it until it's validated.
- **Earlier sessions:** the previous course sessions were only located by search; the project files themselves were reviewed.
