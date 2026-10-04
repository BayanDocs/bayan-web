#!/usr/bin/env bash
# Sets up everything needed to build and test bayan-web, at pinned versions with verified checksums (ADR-0017):
#   1. Node.js (the version in .nvmrc). Uses an existing installation of exactly that version; otherwise downloads it and checks its SHA-256.
#   2. pnpm (the version in package.json "packageManager"), through Corepack, which checks the SHA-512 written there.
#   3. The project's packages, with `pnpm install --frozen-lockfile` (pnpm checks every package against pnpm-lock.yaml).
#   4. The three browser engines Playwright tests in (Chromium's headless shell, Firefox, WebKit). Playwright says which builds this
#      machine needs; each archive is checked against the SHA-256 pinned below, and an archive without a pin is refused.
#   5. On Ubuntu 24.04, the libraries those browsers need, from the signed Ubuntu archive frozen at a snapshot date.
# It is idempotent: each step checks whether its result is already in place and skips the work if so.
# Used by developers, by agent sessions (the cloud environment's setup script calls it) and by CI, so all three test with the same tools.
#
# Supported platforms: Ubuntu 24.04 on x86-64, and macOS 14 or later on Apple Silicon or Intel.
# Written for bash 3.2, the version macOS ships: no associative arrays, mapfile or case-changing expansions, and no arrays at all,
# so `set -u` can never trip over an empty one (bash before 4.4 treats an empty "${array[@]}" as an unbound variable).
#
# Usage: scripts/dev-setup.sh
#
# Pins change only in the monthly dependency session (docs/plan/06-agent-workflow.md), together with package.json. To update the
# browser pins: list the archives with `pnpm exec playwright install --dry-run chromium-headless-shell firefox webkit`, once on
# Linux and once with PLAYWRIGHT_HOST_PLATFORM_OVERRIDE set to each of mac14, mac14-arm64, mac15, mac15-arm64, mac26 and
# mac26-arm64; then hash every archive from its publisher (Google's storage.googleapis.com for the Chromium headless shell,
# Microsoft's playwright.download.prss.microsoft.com for Firefox and WebKit; cdn.playwright.dev only redirects to those two) and
# from npmmirror (cdn.npmmirror.com/binaries/chrome-for-testing/… and cdn.npmmirror.com/binaries/playwright/builds/…), a mirror
# run by a different organization. Pin a hash only when both agree, and record any archive that has no independent copy yet.
set -euo pipefail

NODE_VERSION=24.21.0 # Active LTS, released 2026-09-07; must equal .nvmrc
PLAYWRIGHT_VERSION=1.63.0 # must equal @playwright/test in package.json; the browser builds below belong to this version
APT_SNAPSHOT=20261003T000000Z # Ubuntu archive as of 2026-10-03 00:00 UTC, the same snapshot as the BayanDocs cloud environment

# SHA-256 of each Node.js download, from nodejs.org's SHASUMS256.txt for v24.21.0, whose signature by a Node.js release key was checked.
node_sha256() {
  case "$1" in
    linux-x64) echo fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 ;;
    darwin-arm64) echo 6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe ;;
    darwin-x64) echo 0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299 ;;
    *) return 1 ;;
  esac
}

# SHA-256 and URL of every browser archive Playwright 1.63.0 may download on a supported platform (ffmpeg excluded: no test
# records video). Unless marked otherwise, each hash was read from the publisher and confirmed identical on npmmirror on 2026-10-04.
BROWSER_PINS='
# Ubuntu 24.04, x86-64
a9da028861a0cf789ff25c2fed45f5f1aaf969ed9247835b6a7821a4f7af9d1d  https://cdn.playwright.dev/builds/cft/153.0.8010.12/linux64/chrome-headless-shell-linux64.zip
b0905e84427cc162b9a6e4392be14e5e54e0ade911c83639962c8078b273565e  https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1543/firefox-ubuntu-24.04.zip
8c129d989a1c48d826ca11b45acbba919039de811623dc3819ccbd95b69eeb62  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-ubuntu-24.04.zip
# macOS, Intel and Apple Silicon (the Chromium headless shell and Firefox are the same build on every macOS version)
5c2eaa1aad62111bb5a70dd0889dd3093f3142277b8f78957a238257ee85f009  https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-x64/chrome-headless-shell-mac-x64.zip
89d80a6d26ccd0ccfd51e22d9e1297283862af2b0cd91dce07459b35ca0059f2  https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-headless-shell-mac-arm64.zip
717693ae50e22f6070895a73bc5546dc862ffdf87e6ba9892a5f9e423b312741  https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1543/firefox-mac.zip
12798eac57cad33a466d7315ddae1350a326dedd167ee4ac73307425f4fa8f28  https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1543/firefox-mac-arm64.zip
# WebKit on macOS 14 (revision 2251) and macOS 15 (revision 2359)
50ce5d7004274b01b106dda5ceee6703013b7bd0d0384457cd93a524ced34202  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2251/webkit-mac-14.zip
2754eca5bab8773a6b1315528e7d8f342977ace799b3a91314e1be0cb324ee49  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2251/webkit-mac-14-arm64.zip
b9d6206ef34cb6d764f7c9abf7b8fa94fa130947bc5d98ddbe52f011aa72792d  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-15.zip
33902c98fc0442f916eaa1e006af775f03c65c554eacba78e446581ba2f71ffd  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-15-arm64.zip
# WebKit on macOS 26 and later (revision 2359). NOT INDEPENDENTLY CONFIRMED: npmmirror had no copy of these two on 2026-10-04, so
# they are confirmed only across the two serving systems Microsoft runs (its download service and its separate CDN storage).
# Re-check them against npmmirror in the monthly dependency session (owner decision, 2026-10-04).
7b661e131cc479145ba6e18495c945b7fb9447e87857982e3a433c3232a7546a  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26.zip
f0c43ff8a566ef9cf57b5c0e349d985c60e6ffeb7416e8aac34a5c911bbb8ca7  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2359/webkit-mac-26-arm64.zip
'

# Ubuntu 24.04 packages the browsers need: Playwright 1.63.0's own lists (fonts and tools, Chromium, Firefox, WebKit), merged.
APT_PACKAGES='
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
'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="${BAYANDOCS_TOOLS_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/bayandocs}"
PATH_ADDED="" # directories this script put on PATH, for the hint printed at the end
TMP_ROOT="$(mktemp -d)" # downloads go here; removed however the script ends
trap 'rm -rf "$TMP_ROOT"' EXIT
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

# Prints the SHA-256 of a file as lowercase hex. Linux has sha256sum; macOS has shasum instead.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Downloads a URL over HTTPS only (redirects included) and checks the file against an expected SHA-256 before anything uses it.
fetch_verified() {
  local url="$1" expected="$2" dest="$3" actual
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url" ||
    die "could not download $url"
  actual="$(sha256_of "$dest")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$dest"
    die "checksum mismatch for $url (expected $expected, got $actual); refusing to use it"
  fi
}

# Puts a directory first on PATH for the rest of this script and, in GitHub Actions, for the job's later steps.
prepend_path() {
  export PATH="$1:$PATH"
  if [ -n "${GITHUB_PATH:-}" ]; then
    grep -qxF "$1" "$GITHUB_PATH" 2>/dev/null || echo "$1" >>"$GITHUB_PATH"
  else
    PATH_ADDED="$1:$PATH_ADDED"
  fi
}

# The build this machine needs: linux-x64 (glibc), darwin-arm64 or darwin-x64. Prints nothing on an unsupported machine.
host_target() {
  case "$(uname -s)/$(uname -m)" in
    Linux/x86_64)
      # The official Linux builds need glibc; distributions built on musl (such as Alpine) are not supported.
      if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then echo linux-x64; fi
      ;;
    Darwin/*)
      # This sysctl reports Apple Silicon even to programs running under Rosetta, so an Apple Silicon Mac always gets arm64 builds.
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then echo darwin-arm64; else echo darwin-x64; fi
      ;;
  esac
}

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
  local target sha dir
  target="$(host_target)"
  sha="$(node_sha256 "$target")" ||
    die "no pinned Node.js build for this machine; install Node.js $NODE_VERSION yourself (for example with nvm or fnm, which read .nvmrc), then run this script again"
  dir="$TOOLS_DIR/node-v$NODE_VERSION-$target"
  if [ "$("$dir/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    log "Node.js $NODE_VERSION: downloading and verifying the $target build"
    fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-$target.tar.xz" "$sha" "$TMP_ROOT/node.tar.xz"
    mkdir -p "$TOOLS_DIR"
    rm -rf "$dir"
    tar -xJf "$TMP_ROOT/node.tar.xz" -C "$TOOLS_DIR" --no-same-owner
  fi
  prepend_path "$dir/bin"
  log "Node.js $NODE_VERSION: installed in $dir"
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

# Prints the pinned SHA-256 for a browser archive URL; fails when the URL has no pin.
pinned_browser_sha256() {
  printf '%s\n' "$BROWSER_PINS" | awk -v url="$1" '$2 == url { print $1; found = 1 } END { exit found ? 0 : 1 }'
}

# Asks Playwright which browser builds this machine needs (it knows the macOS version, Apple Silicon and Rosetta) and prints one
# "install-location|download-url" line per browser, ffmpeg excluded. Playwright honours PLAYWRIGHT_BROWSERS_PATH when it reports the
# install location; otherwise it uses its default (~/.cache/ms-playwright on Linux, ~/Library/Caches/ms-playwright on macOS).
playwright_downloads() {
  local plan
  plan="$(cd "$REPO_ROOT" && pnpm exec playwright install --dry-run chromium-headless-shell firefox webkit)" ||
    die "could not ask Playwright which browser builds this machine needs"
  printf '%s\n' "$plan" | awk '
    /^ *Install location:/ { sub(/^ *Install location: */, ""); location = $0; next }
    /^ *Download url:/ { sub(/^ *Download url: */, ""); if (location != "") print location "|" $0; location = "" }
  ' | grep -v '/ffmpeg-[^/|]*|' || true
}

setup_browsers() {
  local downloads location url name sha pending="" count=0 pid number
  downloads="$(playwright_downloads)"
  [ -n "$downloads" ] || die "Playwright reported no browser builds to install; its dry-run output may have changed"
  while IFS='|' read -r location url; do
    [ -n "$location" ] || continue
    name="$(basename "$location")"
    if [ -f "$location/INSTALLATION_COMPLETE" ]; then
      log "browser $name: already installed in $location"
      continue
    fi
    case "$url" in https://*) ;; *) die "Playwright reported an unexpected download URL for $name: $url" ;; esac
    sha="$(pinned_browser_sha256 "$url")" ||
      die "no pinned SHA-256 for $url, so it is not downloaded. This machine is not a supported platform, or @playwright/test changed without this script's pins. On an unsupported platform, install the browsers yourself with 'pnpm exec playwright install chromium-headless-shell firefox webkit' and run this script again."
    count=$((count + 1))
    log "browser $name: downloading"
    (fetch_verified "$url" "$sha" "$TMP_ROOT/browser-$count.zip") </dev/null &
    pending="$pending$!|$count|$location
"
  done <<EOF
$downloads
EOF
  while IFS='|' read -r pid number location; do
    [ -n "$pid" ] || continue
    name="$(basename "$location")"
    wait "$pid" || die "could not download a verified copy of $name"
    mkdir -p "$(dirname "$location")"
    rm -rf "$location" "$location.partial"
    unzip -q "$TMP_ROOT/browser-$number.zip" -d "$location.partial"
    mv "$location.partial" "$location"
    # Playwright treats a browser directory as installed when this marker exists, so it never downloads an unverified copy itself.
    touch "$location/INSTALLATION_COMPLETE"
    log "browser $name: verified and installed in $location"
  done <<EOF
$pending
EOF
}

setup_browser_libraries() {
  if ! is_ubuntu_2404; then
    [ "$(uname -s)" = Darwin ] ||
      log "browser libraries: pinned for Ubuntu 24.04 only; on this system, 'pnpm exec playwright install-deps' lists what the browsers need"
    return 0
  fi
  local package missing="" count=0 total=0
  for package in $APT_PACKAGES; do
    total=$((total + 1))
    if [ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$package" 2>/dev/null || true)" != "ii " ]; then
      missing="$missing $package"
      count=$((count + 1))
    fi
  done
  if [ "$count" -eq 0 ]; then
    log "browser libraries: all $total Ubuntu packages already installed"
    return
  fi
  log "browser libraries: installing $count Ubuntu packages from snapshot $APT_SNAPSHOT"
  as_root apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update --snapshot "$APT_SNAPSHOT"
  # shellcheck disable=SC2086 # $missing is a space-separated list of package names and must split into words
  as_root env DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=120 install -y --no-install-recommends \
    --snapshot "$APT_SNAPSHOT" $missing
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
  if [ -n "$PATH_ADDED" ]; then
    log "add the pinned tools to your PATH (for example in your shell profile): export PATH=\"$PATH_ADDED\$PATH\""
  fi
  log "done. Run 'pnpm verify' to check everything."
}

main "$@"
