#!/usr/bin/env bash
# Checks what the MIO Games demo needs and offers to install what is missing.
#
#   scripts/setup.sh            check, then ask before each install
#   scripts/setup.sh --check    check only, install nothing (exit 1 if something needed is missing)
#   scripts/setup.sh --yes      answer yes to every install question (Docker too, from the distro package;
#                               without --yes Docker is only installed after you answer y)
#   scripts/setup.sh --dev      also require node >= 24 and pnpm (for `pnpm test`, `pnpm lint`)
#
# Needed to run the stack and the demo: docker, the `docker compose` v2 plugin, a running Docker daemon the
# current user can reach, bash 4+, curl, jq, openssl.
# Needed only for development (--dev): node >= 24 and pnpm (package.json "engines" says node >= 24).
#
# Supported package managers: apt, dnf, pacman, brew. Safe to run repeatedly: it installs nothing that is
# already present. Exit code 0 only when everything needed is present.
set -euo pipefail

MODE=ask
DEV=0
for arg in "$@"; do
  case "$arg" in
    --check) MODE=check ;;
    --yes | -y) MODE=yes ;;
    --dev) DEV=1 ;;
    -h | --help)
      sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

DOCKER_DOCS="https://docs.docker.com/engine/install/"

# ---- package manager ---------------------------------------------------------------------------------

PM=""
for candidate in apt-get dnf pacman brew; do
  if command -v "$candidate" > /dev/null 2>&1; then
    PM="$candidate"
    break
  fi
done

SUDO=""
if [ "$(id -u)" -ne 0 ] && [ "$PM" != "brew" ]; then
  SUDO="sudo"
fi

# pkg_for <tool>: package name(s) for the detected package manager.
pkg_for() {
  case "$1:$PM" in
    curl:*) echo curl ;;
    jq:*) echo jq ;;
    openssl:*) echo openssl ;;
    bash:brew) echo bash ;;
    bash:*) echo bash ;;
    node:apt-get) echo "nodejs npm" ;;
    node:dnf) echo nodejs ;;
    node:pacman) echo nodejs ;;
    node:brew) echo node ;;
    docker:apt-get) echo "docker.io docker-compose-v2" ;;
    docker:dnf) echo "docker docker-compose-plugin" ;;
    docker:pacman) echo "docker docker-compose" ;;
    docker:brew) echo "docker docker-compose" ;;
    compose:apt-get) echo docker-compose-v2 ;;
    compose:dnf) echo docker-compose-plugin ;;
    compose:pacman) echo docker-compose ;;
    compose:brew) echo docker-compose ;;
    *) echo "" ;;
  esac
}

install_cmd() { # install_cmd <packages...>: prints the command that will run
  case "$PM" in
    apt-get) echo "$SUDO apt-get install -y $*" ;;
    dnf) echo "$SUDO dnf install -y $*" ;;
    pacman) echo "$SUDO pacman -S --noconfirm $*" ;;
    brew) echo "brew install $*" ;;
  esac
}

# ---- detection ---------------------------------------------------------------------------------------

declare -A VER STATE # STATE: ok | missing | bad
NEEDED=(docker compose daemon bash curl jq openssl)
OPTIONAL=(node pnpm)

first_line() { head -n 1; }

check_all() {
  local v
  if command -v docker > /dev/null 2>&1; then
    VER[docker]="$(docker --version 2> /dev/null | first_line || true)"
    STATE[docker]=ok
  else
    VER[docker]="not found"
    STATE[docker]=missing
  fi

  if [ "${STATE[docker]}" = ok ] && v="$(docker compose version --short 2> /dev/null)" && [ -n "$v" ]; then
    VER[compose]="v${v#v}"
    v="${v#v}"
    if [ "${v%%.*}" -ge 2 ] 2> /dev/null; then
      STATE[compose]=ok
    else
      STATE[compose]=bad
    fi
  else
    VER[compose]="docker compose v2 plugin not found"
    STATE[compose]=missing
  fi

  if [ "${STATE[docker]}" != ok ]; then
    VER[daemon]="needs docker"
    STATE[daemon]=missing
  elif docker info > /dev/null 2>&1; then
    VER[daemon]="running, reachable by $(id -un)"
    STATE[daemon]=ok
  else
    VER[daemon]="not reachable (daemon stopped, or $(id -un) lacks access to the socket)"
    STATE[daemon]=bad
  fi

  VER[bash]="${BASH_VERSION%%(*}"
  if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then STATE[bash]=ok; else STATE[bash]=bad; fi

  local t
  for t in curl jq openssl; do
    if command -v "$t" > /dev/null 2>&1; then
      case "$t" in
        curl) VER[$t]="$(curl --version | first_line | cut -d' ' -f1-2)" ;;
        jq) VER[$t]="$(jq --version)" ;;
        openssl) VER[$t]="$(openssl version | cut -d' ' -f1-2)" ;;
      esac
      STATE[$t]=ok
    else
      VER[$t]="not found"
      STATE[$t]=missing
    fi
  done

  if command -v node > /dev/null 2>&1; then
    v="$(node --version)"
    VER[node]="$v"
    if [ "$(echo "${v#v}" | cut -d. -f1)" -ge 24 ] 2> /dev/null; then STATE[node]=ok; else STATE[node]=bad; fi
  else
    VER[node]="not found"
    STATE[node]=missing
  fi
  if command -v pnpm > /dev/null 2>&1; then
    VER[pnpm]="$(pnpm --version 2> /dev/null || echo unknown)"
    STATE[pnpm]=ok
  else
    VER[pnpm]="not found (try: corepack enable)"
    STATE[pnpm]=missing
  fi
}

print_table() {
  local item note label
  printf '\n%-9s %-8s %s\n' "TOOL" "STATUS" "VERSION / DETAIL"
  printf '%-9s %-8s %s\n' "---------" "--------" "----------------"
  for item in "${NEEDED[@]}" "${OPTIONAL[@]}"; do
    case "${STATE[$item]}" in
      ok) label=found ;;
      missing) label=MISSING ;;
      *) label=PROBLEM ;;
    esac
    note=""
    case " ${OPTIONAL[*]} " in *" $item "*) [ "$DEV" -eq 1 ] || note=" (only for development)" ;; esac
    printf '%-9s %-8s %s%s\n' "$item" "$label" "${VER[$item]}" "$note"
  done
  echo
}

required_items() {
  local item
  for item in "${NEEDED[@]}"; do echo "$item"; done
  if [ "$DEV" -eq 1 ]; then for item in "${OPTIONAL[@]}"; do echo "$item"; done; fi
}

problems() { # prints required items that are not ok
  local item
  while read -r item; do
    [ "${STATE[$item]}" = ok ] || echo "$item"
  done < <(required_items)
}

# ---- install -----------------------------------------------------------------------------------------

confirm() { # confirm <question>
  [ "$MODE" = yes ] && return 0
  [ "$MODE" = check ] && return 1
  if [ ! -t 0 ]; then
    echo "  (no terminal to ask on; rerun interactively or with --yes)"
    return 1
  fi
  local reply
  read -r -p "$1 [y/N] " reply
  [ "$reply" = y ] || [ "$reply" = Y ] || [ "$reply" = yes ]
}

try_install() { # try_install <tool> <why>
  local tool="$1" pkgs cmd
  pkgs="$(pkg_for "$tool")"
  if [ -z "$PM" ] || [ -z "$pkgs" ]; then
    echo "  No supported package manager (apt, dnf, pacman, brew) knows '$tool' here. Install it by hand."
    return 1
  fi
  # shellcheck disable=SC2086
  cmd="$(install_cmd $pkgs)"
  echo "  Would run: $cmd"
  if confirm "  Run it?"; then
    # shellcheck disable=SC2086
    eval "$cmd"
  else
    echo "  Skipped."
    return 1
  fi
}

fix_item() { # fix_item <item>
  local item="$1"
  case "$item" in
    docker | compose)
      echo "Docker: $item is missing."
      echo "  Official install guide: $DOCKER_DOCS"
      if [ "$MODE" = check ]; then return 0; fi
      if [ "$item" = docker ]; then
        echo "  A distro package also works for local use (not the newest Docker)."
        try_install docker || true
      else
        try_install compose || true
      fi
      ;;
    daemon)
      if [ "${STATE[docker]}" != ok ]; then return 0; fi
      echo "Docker daemon: not reachable. This script does not start services or change groups."
      echo "  Start it:           sudo systemctl start docker   (Docker Desktop on macOS: open the app)"
      echo "  Allow your user:    sudo usermod -aG docker \"\$USER\"   then log out and in (or run: newgrp docker)"
      ;;
    bash)
      echo "bash ${VER[bash]} is older than 4 (macOS ships 3.2)."
      try_install bash || true
      echo "  After installing, run the demo with the new bash: scripts/demo.sh has a '#!/usr/bin/env bash' line,"
      echo "  so make sure the new bash comes first in PATH."
      ;;
    curl | jq | openssl)
      echo "$item is missing."
      try_install "$item" || true
      ;;
    node | pnpm)
      echo "$item is needed for development (--dev)."
      if [ "$item" = node ]; then
        try_install node || true
        echo "  The repository wants node >= 24 (package.json engines); a distro package may be older. nvm or"
        echo "  https://nodejs.org/ give you a current one."
      else
        echo "  Run: corepack enable   (ships with node) or: npm install -g pnpm"
      fi
      ;;
  esac
}

# ---- main --------------------------------------------------------------------------------------------

echo "MIO Games setup check (mode: $MODE$([ "$DEV" -eq 1 ] && echo ", dev"))"
[ -n "$PM" ] && echo "Package manager: $PM" || echo "Package manager: none of apt, dnf, pacman, brew found"

check_all
print_table

mapfile -t BAD < <(problems)

if [ "${#BAD[@]}" -gt 0 ]; then
  echo "Missing or not usable: ${BAD[*]}"
  echo
  for item in "${BAD[@]}"; do
    fix_item "$item"
    echo
  done
  if [ "$MODE" != check ]; then
    check_all
    print_table
    mapfile -t BAD < <(problems)
  fi
fi

if [ "${#BAD[@]}" -gt 0 ]; then
  echo "NOT READY: still missing or not usable: ${BAD[*]}"
  [ "$MODE" = check ] && echo "Run scripts/setup.sh without --check to be offered the installs."
  exit 1
fi

cat << 'EOF'
READY. Next:

  docker compose up -d --wait && scripts/demo.sh

The first run builds the images (a few minutes). The demo prints 40 steps and asserts each.
The operator console and the player widget are then at http://localhost:3000/en/operator
EOF
if [ "$DEV" -eq 1 ]; then
  echo
  echo "Development: pnpm install --frozen-lockfile && pnpm test"
fi
