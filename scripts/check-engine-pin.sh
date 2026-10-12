#!/usr/bin/env bash
# Checks that a bayan-core commit may be pinned in bayan-core.pin (ADR-0002 §4, ADR-0017 rule 4). scripts/engine-package.sh runs it
# after fetching bayan-core's main branch; tests/unit/engine-pin.test.ts runs it against Git repositories it builds. It refuses:
#
#   - a bayan-web clone without its full history (a shallow clone), which lacks the commit that pinned the engine;
#   - a commit that is not one of the commits of bayan-core's main branch itself, its first parents. Pull requests reach that branch as
#     one commit each, which GitHub writes when it merges them, so such a commit's committer date is when its code reached main; a
#     commit merged into main from elsewhere keeps an earlier date and is refused;
#   - a commit that reached main less than 24 hours ago, or less than 24 hours before the bayan-web commit that pinned it: the last
#     commit that changed bayan-core.pin, at the earlier of its author and committer times, because amending or rebasing a commit gives
#     it a new committer time (as bayan-core's own age check does, xtask/src/supply_chain/git.rs). While the change to bayan-core.pin is
#     not committed, the pin time is now.
#
# It needs no network: the caller fetches bayan-core's main branch into <main-ref> first.
#
# Usage: scripts/check-engine-pin.sh <bayan-core-dir> <main-ref> <commit> <bayan-web-dir>
# Written for bash 3.2, the version macOS ships (see scripts/dev-setup.sh).
set -euo pipefail

die() {
  printf '[engine-pin] error: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 4 ] || die "usage: scripts/check-engine-pin.sh <bayan-core-dir> <main-ref> <commit> <bayan-web-dir>"
core="$1"
main_ref="$2"
commit="$3"
web="$4"
day=86400

[ "$(git -C "$web" rev-parse --is-shallow-repository)" = false ] ||
  die "this clone of bayan-web is shallow, so it lacks the commit that pinned the engine. Fetch the full history (git fetch --unshallow); in GitHub Actions, check out with fetch-depth: 0."

# Main's own commits are its first parents. (Matched without a pipe: grep -q would stop reading at the match, and pipefail would count
# rev-list's broken pipe as a failure.)
first_parents="$(git -C "$core" rev-list --first-parent "$main_ref")"
case $'\n'"$first_parents"$'\n' in
*$'\n'"$commit"$'\n'*) ;;
*) die "$commit is not one of the commits of bayan-core's main branch; pin only a commit of main itself" ;;
esac

# When the commit reached main: its committer time, which GitHub sets when it merges (the later of its two times, to be safe).
read -r authored committed <<EOF
$(git -C "$core" log -1 --format='%at %ct' "$commit")
EOF
merged_at="$committed"
[ "$authored" -le "$committed" ] || merged_at="$authored"

now="$(date +%s)"
pinned_at="$now"
if git -C "$web" diff --quiet HEAD -- bayan-core.pin; then
  times="$(git -C "$web" log -1 --format='%at %ct' -- bayan-core.pin)"
  if [ -n "$times" ]; then
    read -r authored committed <<EOF
$times
EOF
    pinned_at="$authored"
    [ "$committed" -ge "$authored" ] || pinned_at="$committed"
  fi
fi

[ $((now - merged_at)) -ge "$day" ] ||
  die "$commit reached bayan-core's main less than 24 hours ago; pin a commit at least 24 hours old (ADR-0017 rule 4)"
[ $((pinned_at - merged_at)) -ge "$day" ] ||
  die "$commit was pinned less than 24 hours after it reached bayan-core's main; pin a commit at least 24 hours old (ADR-0017 rule 4)"
printf '[engine-pin] %s is one of the commits of bayan-core'"'"'s main branch, merged at least 24 hours before it was pinned\n' "$commit"
