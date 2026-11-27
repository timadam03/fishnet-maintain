#!/usr/bin/env bash
# Asks for API keys (typing is hidden), stores them in ../.env (git-ignored), checks the Gemini key,
# picks a Gemini model, then runs the decision layer end to end: demo beats → curator → accept →
# demo again → investigator question. Press Enter at a prompt to keep the current value or skip.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=../.env
[ -f "$ENV_FILE" ] || cp ../.env.example "$ENV_FILE"

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

echo "Decision layer setup. Keys are stored only in $(cd .. && pwd)/.env (git-ignored)."
read -rsp "Gemini API key from AI Studio (Enter = keep current / skip): " key; echo
[ -n "$key" ] && set_var GOOGLE_GENERATIVE_AI_API_KEY "$key"
key=$(current GOOGLE_GENERATIVE_AI_API_KEY)

if [ -n "$key" ]; then
  echo "Checking the Gemini key and listing models..."
  models=$(curl -sS -H "x-goog-api-key: $key" "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200") || { echo "Could not reach the Gemini API."; exit 1; }
  # One model name per line: Flash text models, best default first.
  options=$(MODELS="$models" node -e '
    const r = JSON.parse(process.env.MODELS);
    if (r.error) { console.error("Gemini API error: " + r.error.message); process.exit(1); }
    const names = (r.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => n.includes("flash") && !/(image|tts|audio|live|thinking|exp)/.test(n));
    if (names.length === 0) { console.error("No Flash text model available on this key."); process.exit(1); }
    // Stable before preview, full before lite (lite is weaker at tool calling), then newest first.
    const rank = (n) => (/preview/.test(n) ? 2 : 0) + (/lite/.test(n) ? 1 : 0);
    names.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }));
    console.log(names.join("\n"));')
  saved=$(current GEMINI_MODEL)
  default=$(echo "$options" | grep -qxF "$saved" && echo "$saved" || echo "$options" | head -1)
  echo "Models on this key (type a number, or press Enter for the default):"
  echo "$options" | nl -w2 -s') '
  # The list includes models a key can't actually use (retired for new users, or no free-tier
  # quota), so the chosen one gets a one-token test request before it is saved.
  test_model() {
    curl -sS -m 30 -H "x-goog-api-key: $key" -H "content-type: application/json" \
      -d '{"contents":[{"parts":[{"text":"ok"}]}],"generationConfig":{"maxOutputTokens":1}}' \
      "https://generativelanguage.googleapis.com/v1beta/models/$1:generateContent" 2>/dev/null |
      node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{
        let r; try { r = JSON.parse(s); } catch { console.log("no answer (network?)"); return; }
        if (!r.error) { console.log("ok"); return; }
        const m = r.error.message || "";
        if (r.error.code === 429 && /limit: 0/.test(m)) console.log("no free-tier quota for this model on your key");
        else if (r.error.code === 404) console.log("not available on your key");
        else if (r.error.code === 503) console.log("busy right now (Google says try again later)");
        else console.log(r.error.code + ": " + m.split("\n")[0].slice(0, 120));
      })'
  }
  while true; do
    read -rp "Choice [$default]: " choice
    if [ -z "$choice" ]; then model=$default
    elif [[ "$choice" =~ ^[0-9]+$ ]] && [ -n "$(echo "$options" | sed -n "${choice}p")" ]; then model=$(echo "$options" | sed -n "${choice}p")
    else echo "Please type one of the numbers above, or press Enter."; continue
    fi
    printf "Testing %s... " "$model"
    result=$(test_model "$model"); echo "$result"
    [ "$result" = "ok" ] && break
    read -rp "Use it anyway? [y/N] " anyway
    [[ "$anyway" =~ ^[yY] ]] && break
    echo "Pick another number."
  done
  set_var GEMINI_MODEL "$model"
  echo "Agents will use $model."
else
  echo "No Gemini key: the investigator will say it isn't configured, and the curator uses its rule-based version."
fi

read -rsp "Vercel AI Gateway key for d1/Jev (optional, Enter = keep current / skip): " gw; echo
[ -n "$gw" ] && set_var AI_GATEWAY_API_KEY "$gw"
[ -z "$(current AI_GATEWAY_API_KEY)" ] && echo "No gateway key: d1 questions use their fallback rules."

[ -d node_modules ] || npm install --no-fund --no-audit

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
