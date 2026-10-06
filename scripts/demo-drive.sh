#!/usr/bin/env bash
#
# Drive the interactive demo (`npm run demo:interactive:proof`) non-interactively.
#
# WHY THIS EXISTS
# ---------------
# demo/index.js reads menu choices with readline. Piping stdin does not work:
# a pipe is not a terminal, so readline closes before the first question()
# resolves ("readline was closed", ERR_USE_AFTER_CLOSE) no matter what you
# feed it. The demo's logic was never the blocker — only the absence of a TTY.
#
# HOW IT WORKS
# ------------
# MenuSystem.runInteractiveLoop (demo/core/MenuSystem.js) is strictly
# sequential:
#
#     while (continueLoop) {
#       this.displayMenu();
#       const choice = await this.promptUser("Select an option: ");
#       continueLoop = await this.routeChoice(choice);
#     }
#
# So "Select an option: " is printed exactly once per iteration, immediately
# before the process blocks on input; every other question also goes
# through promptUser (demo/index.js) and blocks the same way. In a driven
# run each question carries a marker (SUB-PROMPTS below): a DETERMINISTIC
# READY SIGNAL. This driver waits for it rather than sleeping a guessed
# number of seconds — option 1 takes ~40s and option 74 ~30s on a cold
# node, and any fixed sleep is either flaky or needlessly slow.
#
# Two mechanics make it work:
#   1. script(1) allocates a pseudo-terminal, so readline stays open.
#   2. A FIFO feeds stdin. A FIFO held open by a background writer never
#      reaches EOF, so the demo is not torn down between answers.
#      (Piping answers INSIDE the `script -c` string reintroduces the
#      pipe-closes-early bug — the input must come from outside.)
#
# USAGE
#   scripts/demo-drive.sh 1 21 51 74 83b 0
#   scripts/demo-drive.sh --log /tmp/run.log 1 21 51 74 0
#   scripts/demo-drive.sh --timeout 600 1 21 0
#   scripts/demo-drive.sh 1 21 74 82:yes 0        # 82, then "yes" to its prompt
#
# SUB-PROMPTS
#   An argument may carry the answers to the prompts its option asks after
#   the menu choice, separated by ':' (answers may contain commas, e.g.
#   wallet lists "0,1,2"). An empty answer (Enter, the prompt's default) is
#   an empty field: `42:6::` answers "6", then Enter twice. demo/index.js
#   prefixes every question with "[[?]] " when DEMO_PROMPT_MARK=1, which
#   this driver sets, so it counts every prompt, not only the menu's. A menu
#   choice is sent only when the menu asks and a sub-answer only when
#   something else asks: an option that asks a prompt the arguments do not
#   answer, or fewer prompts than given, stops the run (exit 1) with the
#   prompt named.
#
# Requires a node on 127.0.0.1:8545 (npx hardhat node), or set
# DEMO_RPC_URL=http://127.0.0.1:<port> to drive a node on another port
# (hardhat network "devnode", hardhat.config.ts).
#
# MENU PREREQUISITES (found by running it, not by reading the menu):
#   74 (governance)  requires 21 (ERC-3643 system) — otherwise it prints
#                    "Deploy ERC-3643 system first (option 21)"
#   83b (ownership by vote) requires 51 + 74, AND at least two KYC/AML
#                    verified signers holding VGT. A bare deploy registers
#                    no voter (governance is a trusted contract, not an
#                    identity: D21), so 83b will correctly refuse until
#                    identities exist (options 23/24, or 3 + 6 + 7).
#   Working order: 1 -> 21 -> 51 -> 74 -> 83b -> 0
#
# Exit codes: 0 ok | 1 demo error detected | 2 timeout | 3 bad usage/preconditions

set -uo pipefail

LOG=""
TIMEOUT_S=900
STRICT=0
MARK='[[?]] '
MENU_Q='Select an option: '

usage() {
  sed -n '2,70p' "$0" | sed 's/^# \{0,1\}//'
  exit 3
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log)     LOG="${2:-}"; shift 2 ;;
    --timeout) TIMEOUT_S="${2:-}"; shift 2 ;;
    --strict)  STRICT=1; shift ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) echo "unknown flag: $1" >&2; exit 3 ;;
    *) break ;;
  esac
done

CHOICES=("$@")
if [[ ${#CHOICES[@]} -eq 0 ]]; then
  echo "error: no menu choices given" >&2
  usage
fi

# Always exit the demo cleanly so the process does not hang on the last prompt.
if [[ "${CHOICES[-1]}" != "0" ]]; then
  CHOICES+=("0")
fi

# Flatten "42:6::" into answers, each a menu choice (m) or a sub-answer (s).
ANS=()
KIND=()
for arg in "${CHOICES[@]}"; do
  rest="$arg"
  kind=m
  while :; do
    ANS+=("${rest%%:*}")
    KIND+=("$kind")
    kind=s
    [[ "$rest" == *:* ]] || break
    rest="${rest#*:}"
  done
done

command -v script >/dev/null || { echo "error: script(1) not found (util-linux)" >&2; exit 3; }

# Precondition: a node on 127.0.0.1:8545 (--network localhost), or the one
# DEMO_RPC_URL names (--network devnode).
NETWORK=localhost
RPC_HOST=127.0.0.1
RPC_PORT=8545
if [[ -n "${DEMO_RPC_URL:-}" ]]; then
  NETWORK=devnode
  hostport="${DEMO_RPC_URL#*://}"
  hostport="${hostport%%/*}"
  RPC_HOST="${hostport%%:*}"
  RPC_PORT="${hostport##*:}"
fi
if ! (exec 3<>"/dev/tcp/$RPC_HOST/$RPC_PORT") 2>/dev/null; then
  echo "error: no JSON-RPC node on $RPC_HOST:$RPC_PORT — start one with 'npx hardhat node'" >&2
  exit 3
fi

WORKDIR="$(mktemp -d)"
FIFO="$WORKDIR/stdin"
RAW="$WORKDIR/raw.log"
mkfifo "$FIFO"
[[ -n "$LOG" ]] || LOG="$WORKDIR/demo.log"

cleanup() {
  [[ -n "${HOLD_PID:-}" ]] && kill "$HOLD_PID" 2>/dev/null
  [[ -n "${DEMO_PID:-}" ]] && kill "$DEMO_PID" 2>/dev/null
  rm -f "$FIFO"
}
trap cleanup EXIT

# Hold the FIFO open for the whole run. Without a persistent writer the FIFO
# hits EOF as soon as the first echo completes and readline closes — the exact
# failure this script exists to avoid.
#
# Opened READ-WRITE (9<>) on purpose. `exec 9>fifo` blocks until some process
# opens the read end, and our reader (script) is started on the next line —
# a deadlock: the script hangs before printing anything. Opening read-write
# never blocks, and keeping the read end open also guarantees no EOF.
exec 9<>"$FIFO"
HOLD_PID=""

script -q -f -c "DEMO_PROMPT_MARK=1 npx hardhat run demo/index.js --network $NETWORK" "$RAW" < "$FIFO" > /dev/null 2>&1 &
DEMO_PID=$!

# script -f flushes after each write, so the log grows as the demo speaks.
answered=0
deadline=$(( $(date +%s) + TIMEOUT_S ))

echo "▶ driving demo with: ${CHOICES[*]}"

while [[ $answered -lt ${#ANS[@]} ]]; do
  if [[ $(date +%s) -ge $deadline ]]; then
    echo "✗ timeout after ${TIMEOUT_S}s waiting for prompt #$((answered + 1))" >&2
    cp "$RAW" "$LOG" 2>/dev/null
    echo "  log: $LOG" >&2
    exit 2
  fi

  if ! kill -0 "$DEMO_PID" 2>/dev/null; then
    echo "✗ demo exited before consuming all answers (answered $answered/${#ANS[@]})" >&2
    cp "$RAW" "$LOG" 2>/dev/null
    echo "  log: $LOG" >&2
    exit 1
  fi

  # Count the questions the demo has asked: one marked line each (lines,
  # not occurrences: readline may redraw a prompt on its own line). So
  # "asked > answered" means it is waiting on us.
  # grep -c prints 0 and exits 1 when there are no matches; the `|| echo 0`
  # idiom would then emit TWO lines ("0\n0") and break the arithmetic below.
  asked=$(grep -a -c -F "$MARK" "$RAW" 2>/dev/null | head -1)
  asked=${asked:-0}

  if [[ "$asked" -gt "$answered" ]]; then
    # The question now waiting: the text after the last marker.
    q=$(grep -a -F "$MARK" "$RAW" | tail -1 | tr -d '\r' | sed 's/\x1b\[[0-9;]*[A-Za-z]//g')
    q="${q##*"$MARK"}"
    is_menu=0
    [[ "$q" == "$MENU_Q"* ]] && is_menu=1
    choice="${ANS[$answered]}"
    if [[ "${KIND[$answered]}" == m && $is_menu -eq 0 ]]; then
      echo "✗ prompt \"$q\" has no answer in the arguments (next: menu choice \"$choice\"); give it as <option>:<answer>" >&2
      cp "$RAW" "$LOG" 2>/dev/null
      echo "  log: $LOG" >&2
      exit 1
    fi
    if [[ "${KIND[$answered]}" == s && $is_menu -eq 1 ]]; then
      echo "✗ sub-answer \"$choice\" given, but the option returned to the menu" >&2
      cp "$RAW" "$LOG" 2>/dev/null
      echo "  log: $LOG" >&2
      exit 1
    fi
    label="$choice"
    [[ "${KIND[$answered]}" == s ]] && label="  ↳ \"$choice\""
    echo "  → [$((answered + 1))/${#ANS[@]}] $label"
    printf '%s\n' "$choice" >&9
    answered=$((answered + 1))
    # Let the demo consume it and start work before we re-count.
    sleep 2
  else
    sleep 1
  fi
done

# Wait for the demo to finish after the final choice (normally "0").
end_deadline=$(( $(date +%s) + 120 ))
while kill -0 "$DEMO_PID" 2>/dev/null; do
  [[ $(date +%s) -ge $end_deadline ]] && break
  sleep 1
done
wait "$DEMO_PID" 2>/dev/null
demo_rc=$?

cp "$RAW" "$LOG" 2>/dev/null

# Report what actually happened rather than trusting the exit code: the demo
# catches most module errors and returns to the menu, so it can exit 0 with a
# failed step inside.
fail=0
if grep -q "readline was closed" "$LOG"; then
  echo "✗ readline closed early — the PTY/FIFO setup broke" >&2
  fail=1
fi
if grep -qE "^❌ Demo failed" "$LOG"; then
  echo "✗ demo reported a fatal error:" >&2
  grep -E "^❌ Demo failed" "$LOG" | head -3 >&2
  fail=1
fi

errs=$(grep -cE "^❌" "$LOG" 2>/dev/null | head -1)
errs=${errs:-0}

echo
echo "── summary ──"
echo "  answers sent : $answered/${#ANS[@]}"
echo "  demo exit    : $demo_rc"
echo "  ❌ lines      : $errs"
echo "  log          : $LOG"

# By default an ❌ line is reported but does not fail the run, because some are
# CORRECT refusals: option 83b legitimately declines when no verified voters
# exist, and that is the guard working. Use --strict when a run is expected to
# be clean end-to-end (e.g. in CI), so a missed prerequisite cannot pass green.
if [[ $errs -gt 0 ]]; then
  echo
  echo "  demo-reported errors:"
  grep -E "^❌" "$LOG" | sed 's/^/    /' | head -10
  if [[ $STRICT -eq 1 ]]; then
    echo "✗ --strict: run had $errs demo error(s)" >&2
    exit 1
  fi
  echo "  (informational — pass --strict to fail on these)"
fi

[[ $fail -eq 0 ]] && echo "✓ demo ran to completion" || exit 1
exit 0
