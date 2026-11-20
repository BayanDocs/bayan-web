#!/usr/bin/env bash
# Sets up everything needed to build and test bayan-web, at pinned versions with verified checksums (ADR-0017):
#   1. Node.js (the version in .nvmrc). Uses an existing installation of exactly that version; otherwise downloads it and checks its SHA-256.
#   2. pnpm (the version in package.json "packageManager"): its native binary for this machine, checked against the sha512 that
#      pnpm-lock.yaml records for it. Corepack is not used (Node.js 25 and later no longer ship it, and it checks only pnpm's wrapper).
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

NODE_VERSION=24.22.3 # LTS security release of 2026-11-10 (high-severity fixes in HTTP/2, TLS and the HTTP parser); must equal .nvmrc
PLAYWRIGHT_VERSION=1.65.1 # must equal @playwright/test in package.json; the browser builds below belong to this version
APT_SNAPSHOT=20261025T000000Z # Ubuntu archive as of 2026-10-25 00:00 UTC, the same snapshot as the BayanDocs cloud environment

# SHA-256 of each Node.js download, from nodejs.org's SHASUMS256.txt for v24.22.3, whose signature by a Node.js release key was checked.
node_sha256() {
  case "$1" in
    linux-x64) echo 4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;;
    darwin-arm64) echo 1d64136c8a43d648d1b3bad10797a4c995b1ca032d2bde8799de43b37f058fe5 ;;
    darwin-x64) echo 4daeec962855c1a6e66cda398a25037319dc1bbd4a0939188b3547afbbfb6490 ;;
    *) return 1 ;;
  esac
}

# SHA-256 and URL of every browser archive Playwright 1.65.1 may download on a supported platform (ffmpeg excluded: no test
# records video). Unless marked otherwise, each hash was read from the publisher and confirmed identical on npmmirror on 2026-11-20.
BROWSER_PINS='
# Ubuntu 24.04, x86-64
77a6442fd3c8acd3bef9e1067fc26f5ef464277d22f0e8cb58dc3e4077a3e458  https://cdn.playwright.dev/builds/cft/159.0.8154.6/linux64/chrome-headless-shell-linux64.zip
189ce3e09c61776010ab8a7cbffaa016b8b1914d3c9b50cb5ab6d0c5db4c368f  https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1572/firefox-ubuntu-24.04.zip
4375ca56620d92f4bc8710b6f0cddc8afd2f50c4cca616a50355d63d715c7803  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2388/webkit-ubuntu-24.04.zip
# macOS, Intel and Apple Silicon (the Chromium headless shell and Firefox are the same build on every macOS version)
89c56fb080ab4e9ba76656d5669af2b2dfc313c11434871e8f4e351c08a5ffca  https://cdn.playwright.dev/builds/cft/159.0.8154.6/mac-x64/chrome-headless-shell-mac-x64.zip
b08e7beaf02a19e2ee5ed6955f9c3853ab9176cd5bb57ba87afbb82e9f81cc29  https://cdn.playwright.dev/builds/cft/159.0.8154.6/mac-arm64/chrome-headless-shell-mac-arm64.zip
f31ac41e6450c5c9040fc7290f3da8a6a5f5672b0075f18b37cbd28fbf95ad36  https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1572/firefox-mac.zip
9691b4a07405d8faf8a44f6378d66db480d36159d9e9c4ed1d6066687697e1f2  https://cdn.playwright.dev/dbazure/download/playwright/builds/firefox/1572/firefox-mac-arm64.zip
# WebKit on macOS 14 (revision 2251, unchanged since Playwright 1.63.0) and macOS 15 (revision 2388)
50ce5d7004274b01b106dda5ceee6703013b7bd0d0384457cd93a524ced34202  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2251/webkit-mac-14.zip
2754eca5bab8773a6b1315528e7d8f342977ace799b3a91314e1be0cb324ee49  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2251/webkit-mac-14-arm64.zip
c1220c739a2dbb6450059bfd678d5f5057e807d1d004464ef890ee1e6a9db727  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2388/webkit-mac-15.zip
50b4238e145b8018e48aacefc15e9b3a43fafd18eee42ed4cb29a2e5c5a2e385  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2388/webkit-mac-15-arm64.zip
# WebKit on macOS 26 and later (revision 2388). NOT INDEPENDENTLY CONFIRMED: npmmirror does not mirror WebKit for macOS 26 (on
# 2026-11-20 its lists for revisions 2359 and 2388 ended at mac-15), so these two are confirmed only across the two serving systems
# Microsoft runs: its download service and its separate CDN storage (cdn.playwright.dev/builds/..., which serves them directly).
# Re-check them in the monthly dependency session (owner decision, 2026-10-04), and look for another independent copy.
43603b6130fc1341e02b87dde0d635f02b6d2defb90bc4f4e4b4a2d101900872  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2388/webkit-mac-26.zip
d3cc730027105a014d0cbf53925bd7eababbdf8dbccbb4a3a1713c5f631dbcaf  https://cdn.playwright.dev/dbazure/download/playwright/builds/webkit/2388/webkit-mac-26-arm64.zip
'

# Ubuntu 24.04 packages the browsers need: Playwright 1.65.1's own lists (fonts and tools, Chromium, Firefox, WebKit), merged.
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

# Downloads a URL over HTTPS only, redirects included.
download() {
  curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL --retry 3 --retry-delay 2 -o "$2" "$1" || die "could not download $1"
}

# Downloads a URL and checks the file against an expected SHA-256 before anything uses it.
fetch_verified() {
  local url="$1" expected="$2" dest="$3" actual
  download "$url" "$dest"
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

# Installs pnpm's native binary for this machine, pinned by pnpm-lock.yaml: package.json "packageManager" names the version, and the
# lockfile's first YAML document records the sha512 of the @pnpm/exe.<target> tarball that contains the binary.
setup_pnpm() {
  local target plan version url integrity dir
  target="$(host_target)"
  [ -n "$target" ] || die "no pinned pnpm build for this machine; README.md lists the supported platforms"
  cd "$REPO_ROOT"
  plan="$(node scripts/pnpm-binary.ts plan "$target")" || die "could not read pnpm's pins from package.json and pnpm-lock.yaml"
  read -r version url integrity <<EOF
$plan
EOF
  dir="$TOOLS_DIR/pnpm-$version"
  if [ ! -x "$dir/pnpm" ] || [ "$(cat "$dir/.lockfile-integrity" 2>/dev/null || true)" != "$integrity" ]; then
    log "pnpm $version: downloading the $target binary and checking it against pnpm-lock.yaml"
    download "$url" "$TMP_ROOT/pnpm.tgz"
    node scripts/pnpm-binary.ts verify "$TMP_ROOT/pnpm.tgz" "$integrity" ||
      die "the pnpm download does not match the sha512 in pnpm-lock.yaml; refusing to use it"
    mkdir -p "$TMP_ROOT/pnpm"
    tar -xzf "$TMP_ROOT/pnpm.tgz" -C "$TMP_ROOT/pnpm" package/pnpm
    rm -rf "$dir"
    mkdir -p "$dir"
    mv "$TMP_ROOT/pnpm/package/pnpm" "$dir/pnpm"
    chmod 755 "$dir/pnpm"
    printf '%s\n' "$integrity" >"$dir/.lockfile-integrity"
  fi
  prepend_path "$dir"
  hash -r
  [ "$(command -v pnpm)" = "$dir/pnpm" ] || die "pnpm resolves to $(command -v pnpm), not the verified $dir/pnpm"
  [ "$(pnpm --version)" = "$version" ] || die "the verified pnpm reports version $(pnpm --version), not $version"
  log "pnpm $version: ready in $dir (checked against pnpm-lock.yaml)"
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
