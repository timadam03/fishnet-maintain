#!/usr/bin/env bash
# Asks for keys (typing is hidden) and stores them in ../.env (git-ignored), lets you pick a decision
# model and an agent model from menus, tests each with one tiny live request, then runs the decision
# layer end to end: demo beats → curator → accept → demo again → investigator question.
# Press Enter at a prompt to keep the current value or take the default.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=../.env
[ -f "$ENV_FILE" ] || cp ../.env.example "$ENV_FILE"
[ -d node_modules ] || npm install --no-fund --no-audit

current() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }

# Writes NAME=VALUE into .env. The value travels in an environment variable, not argv, so it
# doesn't show up in the process list.
set_var() {
  NAME="$1" VALUE="$2" ENV_PATH="$ENV_FILE" node -e '
    const fs = require("fs");
    const { NAME, VALUE, ENV_PATH } = process.env;
    const lines = fs.readFileSync(ENV_PATH, "utf8").split("\n");
    const i = lines.findIndex((l) => l.startsWith(NAME + "="));
    if (i >= 0) lines[i] = NAME + "=" + VALUE; else lines.push(NAME + "=" + VALUE);
    fs.writeFileSync(ENV_PATH, lines.join("\n"));'
}

check() { npx tsx --env-file-if-exists="$ENV_FILE" scripts/check-model.ts "$1" "$2" 2>&1 | tail -1; }

# pick VAR KIND "id|label" ...  Shows a numbered menu (0 = none), tests the choice, saves it to VAR.
pick() {
  local var=$1 kind=$2; shift 2
  local ids=() labels=() i choice id result anyway saved default=1
  for opt in "$@"; do ids+=("${opt%%|*}"); labels+=("${opt#*|}"); done
  saved=$(current "$var")
  for i in "${!ids[@]}"; do [ "${ids[$i]}" = "$saved" ] && default=$((i + 1)); done
  for i in "${!ids[@]}"; do printf '  %d) %-40s %s\n' $((i + 1)) "${ids[$i]}" "${labels[$i]}"; done
  printf '  0) none: %s\n' "$([ "$kind" = decision ] && echo 'fallback rules answer instead' || echo 'rule-based curator, investigator off')"
  while true; do
    read -rp "Choice [$default]: " choice
    choice=${choice:-$default}
    if [ "$choice" = 0 ]; then set_var "$var" ""; echo "No $kind model."; return; fi
    if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -gt "${#ids[@]}" ]; then echo "Type one of the numbers above."; continue; fi
    id=${ids[$((choice - 1))]}
    if [[ "$kind" = agent && "$id" != */* ]]; then
      read -rsp "AI Studio key for $id (Enter = keep current): " gkey; echo
      [ -n "$gkey" ] && set_var GOOGLE_GENERATIVE_AI_API_KEY "$gkey"
    fi
    printf 'Testing %s... ' "$id"
    result=$(check "$kind" "$id"); echo "$result"
    if [[ "$result" == ok* ]]; then break; fi
    read -rp "Use it anyway? [y/N] " anyway
    [[ "$anyway" =~ ^[yY] ]] && break
  done
  set_var "$var" "$id"
}

echo "Decision layer setup. Keys are stored only in $(cd .. && pwd)/.env (git-ignored)."
read -rsp "Vercel AI Gateway key (Enter = keep current / skip): " gw; echo
[ -n "$gw" ] && set_var AI_GATEWAY_API_KEY "$gw"
[ -z "$(current AI_GATEWAY_API_KEY)" ] && echo "No gateway key: only an AI Studio Gemini model will be available."

echo
echo "Decision model: answers the typed yes/no questions (same finding? similar past episode?)."
pick DECISION_MODEL decision \
  "liquid/d1.2-ultra|Liquid d1.2 ultra, works on the free gateway tier" \
  "liquid/d1.2|Liquid d1.2, cheaper, free tier" \
  "google/gemini-decision-1|Gemini Decision 1, needs paid gateway credits" \
  "typesafe-ai/jev|TypeSafe Jev, needs paid gateway credits"

echo
echo "Agent model: the chat model behind the investigator and curator."
pick AGENT_MODEL agent \
  "nvidia/nemotron-3.5-lightning-free|free on the gateway, handles tool calls" \
  "google/gemini-3.8-flash|Gemini through the gateway, needs paid credits" \
  "gemini-3.8-flash|Gemini with your own AI Studio key"

run() { npm run -s cli -- "$@"; }
line() { printf '\n==== %s ====\n' "$1"; }

line "Reset demo state"
run reset
line "Demo beats (rules v1)"
run demo
line "Curator reviews closed findings"
curator_out=$(run curator); echo "$curator_out"
id=$(echo "$curator_out" | sed -n 's/^proposal \([0-9][0-9]*\) .*/\1/p' | head -1)
if [ -n "$id" ]; then
  line "Operator accepts proposal $id"
  run accept "$id"
  line "Learning beat again (rules v2)"
  run demo | sed -n '/^4\./,$p'
else
  echo "(no proposal made, so nothing to accept)"
fi
line "Investigator question"
run ask "Why does Pen 7 at 17.5–20 m, 300–315° need a close inspection, and what should we do?"
line "Done"
echo "Start the API for the UI with: npm run serve   (http://localhost:8787)"
echo "Reset before a live demo with: npm run cli -- reset"
