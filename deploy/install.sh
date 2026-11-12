#!/usr/bin/env bash
# Installs Sanctum on a Raspberry Pi or another 64-bit Linux machine.
#
#   curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash -s -- --channel edge
#
# It installs Docker where it is missing (on Raspberry Pi OS, Debian and
# Ubuntu), turns on the memory limits a Raspberry Pi leaves off, keeps a
# laptop awake with its lid closed, and starts the manager from compose.yml in
# /opt/sanctum. The manager then starts everything else and keeps it updated.
#
# Running it again is safe: it finishes an install that was cut short and
# leaves a running one alone.
set -euo pipefail

dir=/opt/sanctum
owner="${SANCTUM_IMAGE_OWNER:-meetsanctum}"
script="${BASH_SOURCE[0]:-}"
channel=""
restart_needed=""

say() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\n%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: install.sh [--channel stable|edge]

  --channel stable   tagged releases (the default)
  --channel edge     the latest build from main
EOF
}

parse() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --channel)
        channel="${2:-}"
        [[ "$channel" == stable || "$channel" == edge ]] || {
          usage >&2
          exit 1
        }
        shift 2
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        exit 1
        ;;
    esac
  done
}

check_machine() {
  [[ "$(uname -s)" == Linux ]] ||
    die "Sanctum installs on Linux: a Raspberry Pi or another 64-bit Linux machine."
  # A 64-bit kernel under a 32-bit system reports a 64-bit machine, and Docker
  # there asks for 32-bit images, so ask the system itself.
  [[ "$(getconf LONG_BIT)" == 64 ]] ||
    die "Sanctum needs a 64-bit system. On a Raspberry Pi, that is Raspberry Pi OS (64-bit)."
  case "$(uname -m)" in
    aarch64 | arm64 | x86_64 | amd64) ;;
    *) die "Sanctum runs on 64-bit ARM and 64-bit Intel or AMD machines, not on $(uname -m)." ;;
  esac
  [[ $EUID -eq 0 ]] || die "Run the installer as root: add sudo before bash."
}

# Docker's own script sets up Docker's package repository, which carries the
# Compose plugin the distributions' own packages may lack.
install_docker() {
  if command -v docker >/dev/null; then
    docker compose version >/dev/null 2>&1 ||
      die "Docker is here without its Compose plugin. Install the plugin, then run this again: https://docs.docker.com/compose/install/linux/"
    return
  fi
  local distro=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    distro="$(. /etc/os-release && echo "${ID:-} ${ID_LIKE:-}")"
  fi
  case " $distro " in
    *" debian "* | *" ubuntu "* | *" raspbian "*) ;;
    *) die "Install Docker Engine with its Compose plugin, then run this again: https://docs.docker.com/engine/install/" ;;
  esac
  say "Installing Docker"
  if ! command -v curl >/dev/null; then
    apt-get update
    apt-get install -y curl ca-certificates
  fi
  curl -fsSL https://get.docker.com | sh
}

# Raspberry Pi OS leaves the memory cgroup off, and Docker then ignores every
# container's memory limit with only a warning. The kernel takes the setting
# at boot, so the Pi restarts once at the end.
enable_memory_limits() {
  [[ "$(docker info --format '{{.MemoryLimit}}')" == true ]] && return
  local cmdline
  for cmdline in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    [[ -f "$cmdline" ]] || continue
    if grep -qw 'cgroup_enable=memory' /proc/cmdline; then
      # Already booted with it: another restart would change nothing.
      break
    fi
    if ! grep -qw 'cgroup_enable=memory' "$cmdline"; then
      say "Turning on memory limits"
      sed -i '1s/$/ cgroup_enable=memory/' "$cmdline"
      # The boot partition has no journal: without this a power cut soon
      # after loses the edit.
      sync
    fi
    restart_needed=1
    return
  done
  printf '\nThis system gives containers no memory limits, so an app that runs away can take all of its memory. Sanctum runs without them.\n' >&2
}

# A laptop suspends when its lid closes, and a desktop system on it when
# nobody has touched it for a while. A home's Sanctum stays on.
keep_awake() {
  compgen -G '/proc/acpi/button/lid/*' >/dev/null || return 0
  command -v systemctl >/dev/null || return 0
  say "Keeping this laptop awake with its lid closed"
  mkdir -p /etc/systemd/logind.conf.d
  cat >/etc/systemd/logind.conf.d/sanctum.conf <<'EOF'
# Sanctum runs on this laptop with its lid closed.
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
  systemctl mask --quiet sleep.target suspend.target hibernate.target hybrid-sleep.target
  # Logind reads the new file on this signal, without ending anyone's session.
  systemctl kill --signal=HUP systemd-logind 2>/dev/null || true
}

kept_setting() {
  [[ -f "$dir/.env" ]] || return 0
  sed -n "s/^${1}=//p" "$dir/.env" | tail -n 1
}

# Refuse a different installation before changing the machine's boot or sleep
# settings. Compose's labels survive the manager replacing itself on update.
check_installation() {
  local kept saved_owner
  if docker inspect sanctum-manager >/dev/null 2>&1; then
    [[ -f "$dir/compose.yml" && -f "$dir/.env" &&
      "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' sanctum-manager)" == sanctum &&
      "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' sanctum-manager)" == manager &&
      "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' sanctum-manager)" == "$dir/compose.yml" ]] ||
      die "Sanctum already runs here, set up another way than by this installer. Nothing was changed."
  fi
  kept="$(kept_setting SANCTUM_CHANNEL)"
  [[ -z "$kept" || "$kept" == stable || "$kept" == edge ]] ||
    die "Sanctum here is on the ${kept} channel, and this installer does not change it. Nothing was changed."
  [[ -z "$kept" || -z "$channel" || "$channel" == "$kept" ]] ||
    die "Sanctum here is on the ${kept} channel, and this installer does not change it. Nothing was changed."
  channel="${channel:-${kept:-stable}}"
  saved_owner="$(kept_setting SANCTUM_IMAGE_OWNER)"
  owner="${saved_owner:-$owner}"
}

# The compose file of the commit the image was built from, which the image
# names in its labels, so the two always match. From a checkout, the file
# beside this script.
write_compose() {
  local image="$1" beside revision source
  mkdir -p "$dir"
  beside="$(dirname "$script")/compose.yml"
  if [[ -n "$script" && -f "$beside" ]]; then
    cp "$beside" "$dir/compose.yml"
    return
  fi
  revision="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
  source="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.source"}}')"
  [[ -n "$revision" && "$source" == https://github.com/* ]] ||
    die "${image} does not say which code it was built from, so its compose file can't be found."
  curl -fsSL "https://raw.githubusercontent.com/${source#https://github.com/}/${revision}/deploy/compose.yml" \
    -o "$dir/compose.yml.download" ||
    die "Could not download Sanctum's compose file. Check this machine's internet connection, then run this again."
  mv "$dir/compose.yml.download" "$dir/compose.yml"
}

start() {
  local image

  if docker inspect sanctum-manager >/dev/null 2>&1; then
    if [[ "$(docker inspect -f '{{.State.Running}}' sanctum-manager)" == true ]]; then
      say "Sanctum is already installed"
      return
    fi
    say "Starting Sanctum"
    # Compose can recreate it from the installation image, undoing an update.
    docker start sanctum-manager
    return
  fi

  image="ghcr.io/${owner}/sanctum-manager:${channel}"
  say "Downloading Sanctum"
  docker pull "$image" ||
    die "Could not download ${image}. Check this machine's internet connection; --channel edge installs the latest build from main instead of a release."
  write_compose "$image"
  printf 'SANCTUM_IMAGE_OWNER=%s\nSANCTUM_CHANNEL=%s\n' "$owner" "$channel" >"$dir/.env.download"
  mv "$dir/.env.download" "$dir/.env"
  say "Starting Sanctum"
  # Shell variables override .env in Compose. Start exactly what was pulled,
  # even from a shell configured for another installation or the dev channel.
  SANCTUM_IMAGE_OWNER="$owner" SANCTUM_CHANNEL="$channel" SANCTUM_MANAGER_IMAGE="$image" \
    docker compose --project-name sanctum --env-file "$dir/.env" -f "$dir/compose.yml" up -d manager
}

# The manager downloads and starts the rest, which takes a few minutes on a
# Pi's card.
running() {
  timeout 15s docker exec sanctum-manager node dist/cli.js core-health >/dev/null 2>&1
}

wait_until_running() {
  local deadline=$((SECONDS + 900))
  running && return
  say "Waiting for Sanctum to start (a few minutes the first time)"
  until running; do
    if ((SECONDS >= deadline)); then
      die "Sanctum did not start within 15 minutes. What it was doing: sudo docker logs sanctum-manager"
    fi
    sleep 5
    printf '.'
  done
  printf '\n'
}

finish() {
  say "Sanctum is running"
  echo "Open the Sanctum app on your Mac: it finds your home on this network."
  [[ -n "$restart_needed" ]] || return 0
  echo
  echo "This Pi restarts in 10 seconds to turn on memory limits, and Sanctum"
  echo "comes back by itself. Press Ctrl-C to restart it yourself later."
  sleep 10
  systemctl reboot
}

# All in a function, so a download cut short runs none of it.
main() {
  parse "$@"
  check_machine
  install_docker
  docker info >/dev/null 2>&1 ||
    die "Docker is installed but not running. Start it (sudo systemctl enable --now docker), then run this again."
  check_installation
  enable_memory_limits
  keep_awake
  start
  wait_until_running
  finish
}

main "$@"
