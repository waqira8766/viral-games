#!/usr/bin/env bash
# VIRAL ARCADE — run every game's self-test suite.
# Exit code 1 if any suite fails. Used by the "loop until peak" iteration.
cd "$(dirname "$0")"
overall=0
total_pass=0

run() {
  local label="$1"; shift
  if [ ! -f "$2" ]; then echo "SKIP  ${label} (file not present yet)"; return; fi
  local out
  out=$("$@" 2>&1)
  local rc=$?
  local n
  n=$(echo "$out" | grep -cE "^PASS")
  total_pass=$((total_pass + n))
  if [ $rc -eq 0 ]; then
    echo "OK    ${label} — ${n} checks"
  else
    echo "FAIL  ${label} (exit ${rc})"
    echo "$out" | grep -E "^FAIL" | head -5 | sed 's/^/      /'
    overall=1
  fi
}

echo "=== VIRAL ARCADE test run $(date -u +%H:%M:%S) ==="
run "cryptfall: integration (gameplay+touch)" node cryptfall/test/integration.js
run "cryptfall: dungeon generator"        node cryptfall/js/dungeon.js
run "cryptfall: audio engine"             node cryptfall/js/audio.js
run "cryptfall: content/balance"           node cryptfall/js/content.js
run "cryptfall: main state machine"        node cryptfall/js/main.js
run "cryptfall: render3d helpers"          node cryptfall/test/render3d-test.js
run "shared: mobile controls"              node shared/mobile-controls.js
run "bank simulator"                       node bank-simulator/js/game.js
run "tiny office"                          node office-life/js/game.js
run "pull the pin: levels"                 node pull-the-pin/js/levels.js
run "pull the pin: game"                   node pull-the-pin/js/game.js
run "ultimate cooking"                     node ultimate-cooking/js/game.js
run "dopamine: content tables"            node dopamine-factory/js/content.js
run "dopamine: core economy"               node dopamine-factory/js/core.js
run "dopamine: board logic"               node dopamine-factory/js/board.js
run "dopamine: bonus wheel"               node dopamine-factory/js/wheel.js
run "dopamine: quests"                     node dopamine-factory/js/quests.js
run "dopamine: audio"                     node dopamine-factory/js/audio.js
run "dopamine: fx pools"                  node dopamine-factory/js/fx.js
run "dopamine: render3d helpers"          node dopamine-factory/js/render3d.js
run "dopamine: input gestures"            node dopamine-factory/js/input.js
run "dopamine: ui math"                   node dopamine-factory/js/ui.js
run "dopamine: game bus"                  node dopamine-factory/js/game.js
run "dopamine: integration bot"            node dopamine-factory/test/integration.js
echo "-------------------------------------------"
echo "TOTAL PASS CHECKS: ${total_pass}"
exit $overall
