#!/usr/bin/env bash
# Builds the engine's WebAssembly package (bayan-core work package CORE-007) from the bayan-core commit pinned in bayan-core.pin, and
# puts it in engine-package/, where the app's build takes it from (config/engine-plugin.ts). During Phase 0 the shells build core from a
# pinned commit (ADR-0002 §4); there are no bayan-core releases yet.
#
#   1. Gets bayan-core at exactly the pinned commit: a clone of its own in ~/.cache/bayandocs/bayan-core (or $XDG_CACHE_HOME), or the
#      checkout in $BAYAN_CORE_DIR, which must have the pinned commit checked out with no changes.
#   2. Refuses a commit that is not on bayan-core's main branch at https://github.com/BayanDocs/bayan-core, so only reviewed and merged
#      engine code is built. (GitHub serves any commit of a repository's fork network by its hash, so a hash alone proves nothing.)
#   3. Runs bayan-core's own scripts/dev-setup.sh --no-node --no-miri from that commit, which installs the Rust toolchain of its
#      rust-toolchain.toml (rustup checks every download against the release's checksums) and wasm-bindgen at the version that commit
#      pins, from the project's release archive checked against a pinned SHA-256. So the pins of the build tools live in one place.
#   4. Builds the package with `cargo xtask wasm-package` (Cargo checks every crate against the SHA-256 in Cargo.lock) and records the
#      commit in engine-package/BUILT-FROM, which `pnpm verify` compares with bayan-core.pin (scripts/check-engine.ts).
#
# Needs git, and rustup (https://rustup.rs; bayan-core's AGENTS.md lists what else its build needs). Takes about a minute after the
# first run. Run it again whenever bayan-core.pin changes.
#
# Usage: scripts/engine-package.sh
# Written for bash 3.2, the version macOS ships (see scripts/dev-setup.sh).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN_FILE="$REPO_ROOT/bayan-core.pin"
OUT="$REPO_ROOT/engine-package"
CORE_URL="https://github.com/BayanDocs/bayan-core.git"
# The branch whose history the pinned commit must belong to, fetched into a ref of our own so that no other remote can stand in for it.
MAIN_REF="refs/bayan-web/bayan-core-main"

log() { printf '[engine-package] %s\n' "$*"; }
die() {
  printf '[engine-package] error: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is not installed"
command -v rustup >/dev/null 2>&1 || die "rustup is not installed; see https://rustup.rs (bayan-core installs its pinned toolchain through it)"

# The pin: exactly one line "commit=<40 lowercase hexadecimal digits>".
commit="$(sed -n 's/^commit=\([0-9a-f]\{40\}\)$/\1/p' "$PIN_FILE")"
[ -n "$commit" ] && [ "$(printf '%s\n' "$commit" | wc -l | tr -d ' ')" = 1 ] ||
  die "$PIN_FILE must contain exactly one line commit=<40 lowercase hexadecimal digits>"

if [ -n "${BAYAN_CORE_DIR:-}" ]; then
  core="$(cd "$BAYAN_CORE_DIR" && pwd)"
  log "using the bayan-core checkout in $core"
  [ "$(git -C "$core" rev-parse HEAD)" = "$commit" ] ||
    die "$core has $(git -C "$core" rev-parse HEAD) checked out, but bayan-core.pin names $commit"
  [ -z "$(git -C "$core" status --porcelain)" ] || die "$core has uncommitted changes; the package must be built from the pinned commit alone"
else
  core="${XDG_CACHE_HOME:-$HOME/.cache}/bayandocs/bayan-core"
  if [ ! -d "$core/.git" ]; then
    log "cloning $CORE_URL into $core (history without file contents; Git fetches the files of the pinned commit)"
    mkdir -p "$(dirname "$core")"
    git clone --quiet --filter=blob:none --no-checkout "$CORE_URL" "$core"
  fi
fi

log "checking that $commit is on bayan-core's main branch"
git -C "$core" fetch --quiet "$CORE_URL" "+refs/heads/main:$MAIN_REF"
git -C "$core" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$core" fetch --quiet "$CORE_URL" "$commit"
git -C "$core" merge-base --is-ancestor "$commit" "$MAIN_REF" ||
  die "$commit is not on the main branch of $CORE_URL; pin only merged bayan-core commits"

if [ -z "${BAYAN_CORE_DIR:-}" ]; then
  git -C "$core" checkout --quiet --detach --force "$commit"
  # Remove anything that is neither committed nor ignored (the build folder target/ is ignored and kept, so rebuilds are quick).
  git -C "$core" clean --quiet -d --force
fi
[ "$(git -C "$core" rev-parse HEAD)" = "$commit" ] || die "could not check out $commit in $core"

log "installing bayan-core's pinned build tools (its scripts/dev-setup.sh)"
(cd "$core" && ./scripts/dev-setup.sh --no-node --no-miri)

# Build into a fresh folder next to the result and replace the result only when the build has succeeded.
work="$REPO_ROOT/.engine-package.partial"
rm -rf "$work"
trap 'rm -rf "$work"' EXIT
log "building the WebAssembly package"
(cd "$core" && cargo xtask wasm-package --out "$work")
printf 'commit=%s\n' "$commit" >"$work/BUILT-FROM"
rm -rf "$OUT"
mv "$work" "$OUT"
log "done: $OUT, built from bayan-core $commit"
