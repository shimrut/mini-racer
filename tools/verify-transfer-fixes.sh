#!/bin/bash
# Proves each guest transfer fix is covered by its regression test.
#
# For every fix commit: reverse-apply only that commit's source change on top of the current tree,
# keep every test as it is now, and run the tests that commit added. They must FAIL. A test that
# still passes without its fix is not testing the fix.
#
# Reverse-applying the one commit, rather than restoring whole files, leaves every later fix in
# place, so a failure can only come from the fix under test. If a revert cannot apply, the script
# stops: a silent revert would test the fixed code and report nonsense.
#
# Usage: tools/verify-transfer-fixes.sh
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree has changes. Commit or stash them first." >&2
  exit 2
fi

# Subject | finding. Subjects, not hashes, so a rewritten branch still resolves.
FIXES=(
  "Settle the Keep Progress choice when the receipt cannot be saved|1"
  "Scope the Garage transfer baseline to the transfer that froze it|2"
  "Keep the player's name out of the transfer's logging|4"
  "Say why a race will not start during a transfer|5"
  "Report Garage transfer contention as retryable from every path|7"
  "Give a contested queue slot to the faster run|9"
  "Judge a recorded Daily day under its own locks|6, 11, 12"
)

restore() { git checkout -q -- . 2>/dev/null; }
trap restore EXIT

# node_modules may be a symlink in a worktree; resolve it once so a temporary worktree can share it.
MODULES="$(cd node_modules 2>/dev/null && pwd -P)"

# A fix whose lines a later fix also edited cannot be reversed on top of HEAD. Prove it where it
# landed instead: a throwaway worktree at that commit, where its own diff always reverses cleanly.
prove_in_own_commit() {
  local sha="$1"; shift
  local tmp; tmp="$(mktemp -d)/wt"
  git worktree add -q --detach "$tmp" "$sha" || return 3
  ln -s "$MODULES" "$tmp/node_modules"
  local result=0
  (
    cd "$tmp" || exit 3
    git diff "$sha^" "$sha" -- "${src[@]}" | git apply -R --whitespace=nowarn || exit 3
    npx vitest run "${tests[@]}" --reporter=dot >/dev/null 2>&1 && exit 1
    exit 0
  ) || result=$?
  git worktree remove --force "$tmp" >/dev/null 2>&1
  return $result
}

proven=0; unproven=0
for row in "${FIXES[@]}"; do
  subject="${row%%|*}"; finding="${row##*|}"
  sha=$(git log --format=%H --fixed-strings --grep="$subject" -1)
  if [ -z "$sha" ]; then
    echo "  ??    finding $finding — commit not found: $subject"; unproven=$((unproven+1)); continue
  fi
  src=(); tests=()
  while IFS= read -r f; do
    case "$f" in
      tests/*.test.js) tests+=("$f") ;;
      tests/*|docs/*|CHANGELOG.md|*.md) ;;
      *) src+=("$f") ;;
    esac
  done < <(git diff --name-only "$sha^" "$sha")

  if ! git diff "$sha^" "$sha" -- "${src[@]}" | git apply -R --whitespace=nowarn 2>/dev/null; then
    restore
    prove_in_own_commit "$sha"
    case $? in
      0) echo "  ok    finding $finding — tests fail with the fix removed (proved at its own commit;"
         echo "        later fixes edit the same lines)"; proven=$((proven+1)) ;;
      1) echo "  FAIL  finding $finding — tests still pass with the fix removed (at its own commit)"
         unproven=$((unproven+1)) ;;
      *) echo "  STOP  finding $finding — could not remove the fix even at its own commit"
         unproven=$((unproven+1)) ;;
    esac
    continue
  fi
  if npx vitest run "${tests[@]}" --reporter=dot >/dev/null 2>&1; then
    echo "  FAIL  finding $finding — tests still pass with the fix removed"
    unproven=$((unproven+1))
  else
    echo "  ok    finding $finding — tests fail with the fix removed"
    proven=$((proven+1))
  fi
  restore
done

echo
echo "$proven proven, $unproven not."
[ "$unproven" -eq 0 ]
