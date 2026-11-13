#!/usr/bin/env bash
# Installs Sanctum on a Raspberry Pi or another 64-bit Linux machine.
#
#   curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash -s -- --channel edge
#   curl -fsSL https://raw.githubusercontent.com/meetsanctum/sanctum/main/deploy/install.sh | sudo bash -s -- --uninstall
#
# It installs Docker where it is missing (on Raspberry Pi OS, Debian and
# Ubuntu), turns on the memory limits a Raspberry Pi leaves off, keeps a
# laptop awake with its lid closed, and starts the manager from compose.yml in
# /opt/sanctum. The manager then starts everything else and keeps it updated.
#
# Running it again is safe: it finishes an install that was cut short and
# leaves a running one alone.
#
# With --uninstall it removes what it set up, the home's data included, after
# asking. Docker stays.
set -euo pipefail

dir=/opt/sanctum
owner="${SANCTUM_IMAGE_OWNER:-meetsanctum}"
script="${BASH_SOURCE[0]:-}"
channel=""
restart_needed=""
uninstall=""
unasked=""
# Where a person answers: the script itself may arrive on standard input.
terminal=/dev/tty
sleep_settings=/etc/systemd/logind.conf.d/sanctum.conf

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
       install.sh --uninstall [--yes]

  --channel stable   tagged releases (the default)
  --channel edge     the latest build from main
  --uninstall        remove Sanctum from this machine, with the home's data
  --yes              with --uninstall, remove without asking
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
      --uninstall)
        uninstall=1
        shift
        ;;
      --yes)
        unasked=1
        shift
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
  if [[ -n "$uninstall" && -n "$channel" ]] || [[ -z "$uninstall" && -n "$unasked" ]]; then
    usage >&2
    exit 1
  fi
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
  [[ $EUID -eq 0 ]] || die "Run this as root: add sudo before bash."
}

# Docker comes from Docker's own package repository, which carries the Compose
# plugin the distributions' packages may lack. Apt checks every package
# against the repository's key, and nothing downloaded runs as a script.
install_docker() {
  if command -v docker >/dev/null; then
    docker compose version >/dev/null 2>&1 ||
      die "Docker is here without its Compose plugin. Install the plugin, then run this again: https://docs.docker.com/compose/install/linux/"
    return
  fi
  local id="" codename=""
  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    id="$(. /etc/os-release && echo "${ID:-}")"
    # shellcheck disable=SC1091
    codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"
  fi
  # Raspberry Pi OS (64-bit) says debian, and takes Debian's packages.
  [[ ("$id" == debian || "$id" == ubuntu) && -n "$codename" ]] ||
    die "Install Docker Engine with its Compose plugin, then run this again: https://docs.docker.com/engine/install/"
  say "Installing Docker"
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${id}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${id} ${codename} stable" \
    >/etc/apt/sources.list.d/docker.list
  DEBIAN_FRONTEND=noninteractive apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  # The package starts Docker, except where the system holds services back
  # while packages install.
  if command -v systemctl >/dev/null; then
    systemctl enable --now docker || true
  fi
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
  mkdir -p "$(dirname "$sleep_settings")"
  cat >"$sleep_settings" <<'EOF'
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

# Whether the manager here is the one this installer started. Compose's labels
# survive the manager replacing itself on update.
manager_is_the_installers() {
  [[ -f "$dir/compose.yml" && -f "$dir/.env" &&
    "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' sanctum-manager)" == sanctum &&
    "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' sanctum-manager)" == manager &&
    "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' sanctum-manager)" == "$dir/compose.yml" ]]
}

# Refuse a different installation before changing the machine's boot or sleep
# settings.
check_installation() {
  local kept saved_owner
  if docker inspect sanctum-manager >/dev/null 2>&1; then
    manager_is_the_installers ||
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

# Sanctum's own of one kind in Docker, by name: what its manager labelled and
# what Compose made for its project. On this machine none of it carries a
# stack's label, and everything of a development stack on the same Docker does.
# Docker can't filter on a label being absent, so each is listed with it.
listed() {
  local kind="$1" label name=Name
  shift
  [[ "$kind" != container ]] || name=Names
  for label in sanctum.managed=true com.docker.compose.project=sanctum; do
    docker "$kind" ls "$@" --filter "label=${label}" \
      --format "{{if .Label \"sanctum.stack\"}}{{else}}{{.${name}}}{{end}}" || return 1
  done | awk 'NF && !seen[$0]++'
}

# The images Sanctum is built into, and those the given containers run.
images_of() {
  local each images image_stack
  images="$(docker image ls -q --filter label=sanctum.service)" || return 1
  for each in $images; do
    image_stack="$(docker image inspect -f '{{index .Config.Labels "sanctum.stack"}}' "$each")" || return 1
    [[ -n "$image_stack" ]] || echo "$each"
  done
  for each in "$@"; do
    docker inspect -f '{{.Image}}' "$each" || return 1
  done
}

# Only what this installer set up, whole or cut short: its manager, or with no
# manager its files in /opt/sanctum. Returns 1 where there is no Sanctum.
check_removal() {
  local kept manager containers volumes networks
  manager="$(docker container ls -a --filter 'name=^/sanctum-manager$' --format '{{.Names}}')" ||
    die "Could not find Sanctum's manager. Nothing was changed."
  if [[ -n "$manager" ]]; then
    manager_is_the_installers ||
      die "Sanctum here was set up another way than by this installer, which removes only what it set up. Nothing was changed."
  elif [[ ! -f "$dir/compose.yml" && ! -f "$dir/.env" ]]; then
    containers="$(listed container -a)" || die "Could not list Sanctum's containers. Nothing was changed."
    volumes="$(listed volume)" || die "Could not list Sanctum's volumes. Nothing was changed."
    networks="$(listed network)" || die "Could not list Sanctum's networks. Nothing was changed."
    [[ -z "$containers$volumes$networks" ]] ||
      die "Sanctum here was set up another way than by this installer, which removes only what it set up. Nothing was changed."
    return 1
  fi
  kept="$(kept_setting SANCTUM_CHANNEL)" || die "Could not read Sanctum's settings. Nothing was changed."
  [[ -z "$kept" || "$kept" == stable || "$kept" == edge ]] ||
    die "Sanctum here is on the ${kept} channel, set up another way than by this installer. Nothing was changed."
}

confirm_removal() {
  local answer=""
  cat <<'EOF'

This removes Sanctum from this machine, with your home's data: its people,
rooms, devices, automations, history and backups. None of it can be brought
back.

Lights, switches and sensors stay joined to a Zigbee network that will be
gone. Each needs a reset before it can join another.

Docker stays installed.

EOF
  [[ -z "$unasked" ]] || return 0
  { : <"$terminal"; } 2>/dev/null ||
    die "There is no terminal to ask on. To remove Sanctum without being asked, add --yes. Nothing was changed."
  printf 'Type "remove" to go on: '
  read -r answer <"$terminal" || true
  [[ "$answer" == remove ]] || die "Sanctum stays. Nothing was changed."
}

# Each app's data is an image file in the manager's volume, attached to a loop
# device that outlives the volume and holds on to the file's space until the
# machine restarts. Only ever those files': a loop device can also be
# something else's.
detach_images() {
  local folder file
  folder="$(docker volume inspect -f '{{.Mountpoint}}' sanctum-manager-data)/images"
  for file in "$folder"/*.img; do
    [[ -e "$file" ]] || continue
    losetup -j "$file" -n -O NAME | xargs -r losetup -d
  done
}

remove_from_docker() {
  local containers volumes networks images each in_use
  containers="$(listed container -a)"
  if [[ -n "$containers" ]]; then
    say "Stopping Sanctum"
    # The updater first, so it can't put a manager back, and the manager
    # before its core and services, or it would start them again.
    for each in sanctum-manager-updater sanctum-manager; do
      grep -qx "$each" <<<"$containers" || continue
      docker stop "$each" >/dev/null
    done
    # With whatever the manager made while it stopped.
    containers="$(listed container -a)"
  fi
  say "Removing Sanctum and your home's data"
  # shellcheck disable=SC2086
  images="$(images_of $containers | sort -u)"
  # A retry must remember the third-party images after their containers go.
  if [[ -f "$dir/.uninstall-images" ]]; then
    images+=$'\n'"$(cat "$dir/.uninstall-images")"
  fi
  images="$(sort -u <<<"$images")"
  printf '%s\n' "$images" >"$dir/.uninstall-images.download"
  mv "$dir/.uninstall-images.download" "$dir/.uninstall-images"
  if [[ -n "$containers" ]]; then
    # shellcheck disable=SC2086
    docker rm -f -v $containers >/dev/null
  fi
  volumes="$(listed volume)"
  if grep -qx sanctum-manager-data <<<"$volumes"; then
    detach_images
  fi
  if [[ -n "$volumes" ]]; then
    # shellcheck disable=SC2086
    docker volume rm $volumes >/dev/null
  fi
  networks="$(listed network)"
  if [[ -n "$networks" ]]; then
    # shellcheck disable=SC2086
    docker network rm $networks >/dev/null
  fi
  # An image something else's container runs stays.
  for each in $images; do
    in_use="$(docker ps -aq --filter "ancestor=${each}")"
    [[ -z "$in_use" ]] || continue
    docker image rm -f "$each" >/dev/null 2>&1 || true
  done
}

# The file says this installer masked the targets, so it goes after them.
let_sleep() {
  [[ -f "$sleep_settings" ]] || return 0
  say "Letting this laptop sleep again"
  if command -v systemctl >/dev/null; then
    systemctl unmask --quiet sleep.target suspend.target hibernate.target hybrid-sleep.target
  fi
  rm -f "$sleep_settings"
  if command -v systemctl >/dev/null; then
    systemctl kill --signal=HUP systemd-logind 2>/dev/null || true
  fi
}

not_installed() {
  say "Sanctum is not installed on this machine"
}

# Running it again finishes a removal that was cut short: the files in
# /opt/sanctum, which say this installer set Sanctum up, go last.
remove() {
  local cmdline
  if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then
    if [[ ! -f "$dir/compose.yml" && ! -f "$dir/.env" ]]; then
      not_installed
      return 0
    fi
    die "Sanctum's containers and data are in Docker, which is not running. Start it (sudo systemctl start docker), then run this again. Nothing was changed."
  fi
  if ! check_removal; then
    not_installed
    return 0
  fi
  confirm_removal
  remove_from_docker
  let_sleep
  rm -f "$dir/compose.yml" "$dir/compose.yml.download" "$dir/.env" "$dir/.env.download" \
    "$dir/.uninstall-images" "$dir/.uninstall-images.download"
  rmdir "$dir" 2>/dev/null || true
  say "Sanctum is removed"
  echo "Docker stays installed."
  for cmdline in /boot/firmware/cmdline.txt /boot/cmdline.txt; do
    [[ -f "$cmdline" ]] || continue
    if grep -qw 'cgroup_enable=memory' "$cmdline"; then
      echo "So does cgroup_enable=memory in ${cmdline}, which gives containers memory limits."
    fi
  done
}

# All in a function, so a download cut short runs none of it.
main() {
  parse "$@"
  check_machine
  if [[ -n "$uninstall" ]]; then
    remove
    return
  fi
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
