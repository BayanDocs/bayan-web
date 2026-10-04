#!/usr/bin/env bash
# Sets up everything needed to build and test bayan-web, at pinned versions with verified checksums (ADR-0017):
#   1. Node.js (the version in .nvmrc). Uses an existing installation of exactly that version; otherwise, on Linux x86-64, downloads it and checks its SHA-256.
#   2. pnpm (the version in package.json "packageManager"), through Corepack, which checks the SHA-512 written there.
#   3. The project's packages, with `pnpm install --frozen-lockfile` (pnpm checks every package against pnpm-lock.yaml).
#   4. The three browser engines Playwright tests in (Chromium, Firefox, WebKit), checked against the SHA-256 hashes below.
#   5. The Ubuntu 24.04 libraries those browsers need, from the signed Ubuntu archive frozen at a snapshot date.
# It is idempotent: each step checks whether its result is already in place and skips the work if so.
# Used by developers, by agent sessions (the cloud environment's setup script calls it) and by CI, so all three test with the same tools.
#
# Usage: scripts/dev-setup.sh
#
# Pins change only in the monthly dependency session (docs/plan/06-agent-workflow.md), together with package.json:
# the browser revisions and download URLs come from `pnpm exec playwright install --dry-run chromium-headless-shell firefox webkit`,
# and each hash must be checked against two independent download hosts before it is written here.
set -euo pipefail

NODE_VERSION=24.21.0 # Active LTS, released 2026-09-07; must equal .nvmrc
NODE_SHA256=fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 # node-v24.21.0-linux-x64.tar.xz, as in nodejs.org SHASUMS256.txt
PLAYWRIGHT_VERSION=1.63.0 # must equal @playwright/test in package.json; the browser builds below belong to this version
APT_SNAPSHOT=20261003T000000Z # Ubuntu archive as of 2026-10-03 00:00 UTC, the same snapshot as the BayanDocs cloud environment

# Browser builds for Playwright 1.63.0 on Linux x86-64: Playwright's name | install directory | SHA-256 of the archive | download URL.
# Each hash was confirmed identical from two independent hosts (Playwright's CDN and Google's or Microsoft's own download server) on 2026-10-04.
BROWSERS=(
  "chromium-headless-shell|chromium_headless_shell-1243|a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d|https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip"
  "firefox|firefox-1543|b0905e84427cc162b9a6e4392be14e5e54e0ade911c83639962c8078b273565e|https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1543/firefox-ubuntu-24.04.zip"
  "webkit|webkit-2359|8c129d989a1c48d826ca11b45acbba919039de811623dc3819ccbd95b69eeb62|https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-ubuntu-24.04.zip"
)

# Ubuntu 24.04 packages the browsers need: Playwright 1.63.0's own lists (fonts and tools, Chromium, Firefox, WebKit), merged.
APT_PACKAGES=(
  xvfb fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 xfonts-cyrillic xfonts-scalable
  fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf libasound2t64
  libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1
  libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3
  libxkbcommon0 libxrandr2 libavcodec60 libcairo-gobject2 libgdk-pixbuf-2.0-0 libgtk-3-0t64 libpangocairo-1.0-0
  libx11-xcb1 libxcb-shm0 libxcursor1 libxi6 libxrender1 gstreamer1.0-libav gstreamer1.0-plugins-bad
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good libicu74 libatomic1 libenchant-2-2 libepoxy0 libevent-2.1-7t64
  libflite1 libgles2 libgstreamer-gl1.0-0 libgstreamer-plugins-bad1.0-0 libgstreamer-plugins-base1.0-0
  libgstreamer1.0-0 libgtk-4-1 libharfbuzz-icu0 libharfbuzz0b libhyphen0 libjpeg-turbo8 liblcms2-2 libmanette-0.2-0
  libopus0 libpng16-16t64 libsecret-1-0 libvpx9 libwayland-client0 libwayland-egl1 libwayland-server0 libwebp7
  libwebpdemux2 libwoff1 libxml2 libxslt1.1 libx264-164 libavif16
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${BAYANDOCS_TOOLS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/bayandocs}"
BROWSERS_DIR="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_DEFAULT_TO_LATEST=0

log() { printf '[dev-setup] %s\n' "$*"; }
die() {
  printf '[dev-setup] error: %s\n' "$*" >&2
  exit 1
}

# Runs a command as root: directly when we are root, otherwise through sudo (CI runners allow it without a password).
as_root() {
  if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi
}

# Downloads a URL over HTTPS only and checks the file against an expected SHA-256 before anything uses it.
fetch_verified() {
  local url="$1" sha256="$2" dest="$3"
  curl --proto '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url"
  if ! printf '%s  %s\n' "$sha256" "$dest" | sha256sum --check --status; then
    rm -f "$dest"
    die "checksum mismatch for $url; refusing to use it"
  fi
}

# Puts a directory first on PATH for the rest of this script and, in GitHub Actions, for the job's later steps.
prepend_path() {
  export PATH="$1:$PATH"
  if [ -n "${GITHUB_PATH:-}" ] && ! grep -qxF "$1" "$GITHUB_PATH" 2>/dev/null; then
    echo "$1" >>"$GITHUB_PATH"
  fi
}

is_linux_x64() { [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; }

is_ubuntu_2404() {
  # shellcheck disable=SC1091 # a system file, not part of this repository
  [ -r /etc/os-release ] && (. /etc/os-release && [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ])
}

check_pins_match_repository() {
  [ "$(tr -d '[:space:]' <"$REPO_ROOT/.nvmrc")" = "$NODE_VERSION" ] ||
    die ".nvmrc does not match NODE_VERSION=$NODE_VERSION in this script; update both together"
  grep -q "\"@playwright/test\": \"$PLAYWRIGHT_VERSION\"" "$REPO_ROOT/package.json" ||
    die "package.json does not pin @playwright/test $PLAYWRIGHT_VERSION; update this script's browser pins together with it"
}

setup_node() {
  if [ "$(node --version 2>/dev/null || true)" = "v$NODE_VERSION" ]; then
    log "Node.js $NODE_VERSION: already installed"
    return
  fi
  # BayanDocs cloud sessions install the pinned Node.js under /opt/bayandocs; non-login shells may not have it on PATH yet.
  if [ -r /etc/profile.d/zz-bayandocs.sh ]; then
    # shellcheck disable=SC1091
    . /etc/profile.d/zz-bayandocs.sh
    if [ "$(node --version 2>/dev/null || true)" = "v$NODE_VERSION" ]; then
      log "Node.js $NODE_VERSION: found in the BayanDocs cloud environment"
      return
    fi
  fi
  is_linux_x64 || die "install Node.js $NODE_VERSION yourself (for example with nvm or fnm, which read .nvmrc), then run this script again"

  local dir="$TOOLS_DIR/node-v$NODE_VERSION-linux-x64" tmp
  if [ "$("$dir/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    log "Node.js $NODE_VERSION: downloading and verifying"
    tmp="$(mktemp -d)"
    fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$NODE_SHA256" "$tmp/node.tar.xz"
    mkdir -p "$TOOLS_DIR"
    rm -rf "$dir"
    tar -xJf "$tmp/node.tar.xz" -C "$TOOLS_DIR" --no-same-owner
    rm -rf "$tmp"
  fi
  prepend_path "$dir/bin"
  [ -n "${GITHUB_PATH:-}" ] || log "Node.js $NODE_VERSION is in $dir/bin; add that directory to your PATH"
  log "Node.js $NODE_VERSION: installed"
}

setup_pnpm() {
  local want
  want="$(sed -n 's/.*"packageManager": "pnpm@\([0-9.]*\)+sha512\..*/\1/p' "$REPO_ROOT/package.json")"
  [ -n "$want" ] || die 'package.json "packageManager" must pin pnpm with a sha512 hash'
  cd "$REPO_ROOT"
  if [ "$(pnpm --version 2>/dev/null || true)" != "$want" ]; then
    # Missing, or some other pnpm comes first on PATH: put Corepack's shim first. Corepack ships with Node.js 24; its pnpm shim
    # reads "packageManager" and verifies the download against the hash written there.
    local shim_dir
    shim_dir="$(dirname "$(command -v node)")"
    if [ ! -w "$shim_dir" ]; then
      shim_dir="$TOOLS_DIR/bin"
      mkdir -p "$shim_dir"
    fi
    corepack enable pnpm --install-directory "$shim_dir"
    prepend_path "$shim_dir"
    hash -r
  fi
  corepack install # downloads the pinned pnpm once and checks its SHA-512; a no-op when it is cached
  [ "$(pnpm --version)" = "$want" ] || die "pnpm $(pnpm --version) is running instead of the pinned $want"
  log "pnpm $want: ready (through Corepack)"
}

install_packages() {
  cd "$REPO_ROOT"
  pnpm install --frozen-lockfile
  local installed
  installed="$(node -p 'require("./node_modules/@playwright/test/package.json").version')"
  [ "$installed" = "$PLAYWRIGHT_VERSION" ] || die "@playwright/test $installed is installed, but this script pins browsers for $PLAYWRIGHT_VERSION"
  log "project packages: installed from pnpm-lock.yaml"
}

setup_browsers() {
  if ! is_linux_x64 || ! is_ubuntu_2404; then
    log "browsers: verified downloads are pinned for Ubuntu 24.04 on x86-64 only; elsewhere run: pnpm exec playwright install chromium-headless-shell firefox webkit"
    return
  fi
  mkdir -p "$BROWSERS_DIR"
  local entry name dir sha url tmp pending=()
  tmp="$(mktemp -d)"
  for entry in "${BROWSERS[@]}"; do
    IFS='|' read -r name dir sha url <<<"$entry"
    if [ -f "$BROWSERS_DIR/$dir/INSTALLATION_COMPLETE" ]; then
      log "browser $name: already installed in $BROWSERS_DIR/$dir"
      continue
    fi
    log "browser $name: downloading"
    (fetch_verified "$url" "$sha" "$tmp/$dir.zip") &
    pending+=("$!|$entry")
  done
  for job in "${pending[@]}"; do
    IFS='|' read -r pid name dir sha url <<<"$job"
    wait "$pid" || die "could not download a verified copy of $name"
    rm -rf "${BROWSERS_DIR:?}/$dir" "$BROWSERS_DIR/$dir.partial"
    unzip -q "$tmp/$dir.zip" -d "$BROWSERS_DIR/$dir.partial"
    mv "$BROWSERS_DIR/$dir.partial" "$BROWSERS_DIR/$dir"
    # Playwright treats a browser directory as installed when this marker exists, so it never downloads an unverified copy itself.
    touch "$BROWSERS_DIR/$dir/INSTALLATION_COMPLETE"
    log "browser $name: verified and installed in $BROWSERS_DIR/$dir"
  done
  rm -rf "$tmp"
}

setup_browser_libraries() {
  is_ubuntu_2404 || return 0
  local missing=() package
  for package in "${APT_PACKAGES[@]}"; do
    if [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null || true)" != "ii " ]; then
      missing+=("$package")
    fi
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    log "browser libraries: all ${#APT_PACKAGES[@]} Ubuntu packages already installed"
    return
  fi
  log "browser libraries: installing ${#missing[@]} Ubuntu packages from snapshot $APT_SNAPSHOT"
  as_root apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update --snapshot "$APT_SNAPSHOT"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends \
    --snapshot "$APT_SNAPSHOT" "${missing[@]}"
  log "browser libraries: installed"
}

main() {
  [ "$#" -eq 0 ] || die "usage: scripts/dev-setup.sh (it takes no arguments)"
  check_pins_match_repository
  setup_node
  setup_pnpm
  install_packages
  setup_browsers
  setup_browser_libraries
  log "done. Run 'pnpm verify' to check everything."
}

main "$@"
