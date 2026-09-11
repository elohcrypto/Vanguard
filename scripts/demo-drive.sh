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
# before the process blocks on input. That string is a DETERMINISTIC READY
# SIGNAL. This driver waits for it rather than sleeping a guessed number of
# seconds — option 1 takes ~40s and option 74 ~30s on a cold node, and any
# fixed sleep is either flaky or needlessly slow.
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
#
# Requires a node on 127.0.0.1:8545 (npx hardhat node).
#
# MENU PREREQUISITES (found by running it, not by reading the menu):
#   74 (governance)  requires 21 (ERC-3643 system) — otherwise it prints
#                    "Deploy ERC-3643 system first (option 21)"
#   83b (ownership by vote) requires 51 + 74, AND at least two KYC/AML
#                    verified signers holding VGT. A bare deploy registers
#                    only VanguardGovernance itself, so 83b will correctly
#                    refuse until identities exist (options 23/24 + 3/4).
#   Working order: 1 -> 21 -> 51 -> 74 -> 83b -> 0
#
# Exit codes: 0 ok | 1 demo error detected | 2 timeout | 3 bad usage/preconditions

set -uo pipefail

LOG=""
TIMEOUT_S=900
STRICT=0
READY_RE='Select an option: '

usage() {
  sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'
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

command -v script >/dev/null || { echo "error: script(1) not found (util-linux)" >&2; exit 3; }

# Precondition: the demo needs --network localhost.
if ! (exec 3<>/dev/tcp/127.0.0.1/8545) 2>/dev/null; then
  echo "error: no JSON-RPC node on 127.0.0.1:8545 — start one with 'npx hardhat node'" >&2
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

script -q -f -c "npx hardhat run demo/index.js --network localhost" "$RAW" < "$FIFO" > /dev/null 2>&1 &
DEMO_PID=$!

# script -f flushes after each write, so the log grows as the demo speaks.
answered=0
deadline=$(( $(date +%s) + TIMEOUT_S ))

echo "▶ driving demo with: ${CHOICES[*]}"

while [[ $answered -lt ${#CHOICES[@]} ]]; do
  if [[ $(date +%s) -ge $deadline ]]; then
    echo "✗ timeout after ${TIMEOUT_S}s waiting for prompt #$((answered + 1))" >&2
    cp "$RAW" "$LOG" 2>/dev/null
    echo "  log: $LOG" >&2
    exit 2
  fi

  if ! kill -0 "$DEMO_PID" 2>/dev/null; then
    echo "✗ demo exited before consuming all choices (answered $answered/${#CHOICES[@]})" >&2
    cp "$RAW" "$LOG" 2>/dev/null
    echo "  log: $LOG" >&2
    exit 1
  fi

  # Count how many times the demo has asked for a menu choice. It asks once
  # per loop iteration, so "asked > answered" means it is waiting on us.
  # grep -c prints 0 and exits 1 when there are no matches; the `|| echo 0`
  # idiom would then emit TWO lines ("0\n0") and break the arithmetic below.
  asked=$(grep -c "$READY_RE" "$RAW" 2>/dev/null | head -1)
  asked=${asked:-0}

  if [[ "$asked" -gt "$answered" ]]; then
    choice="${CHOICES[$answered]}"
    echo "  → [$((answered + 1))/${#CHOICES[@]}] $choice"
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
echo "  choices sent : $answered/${#CHOICES[@]}"
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
