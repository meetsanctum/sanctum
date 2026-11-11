#!/usr/bin/env bash
# The dev channel: builds dev-<commit> images on this Mac, pushes them to the
# registry on a dev host and has the host's manager update to them, through
# the same update path a household host uses.
#
#   pnpm host:setup    once: turn a fresh Pi into a dev host
#   pnpm host:push     build, push and update
#   pnpm host:publish  build and push only, to update from Settings → System
#   pnpm host:status   the last update's progress
#
# The host is an SSH destination, in SANCTUM_HOST or deploy/dev/.env.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
if [[ -f deploy/dev/.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source deploy/dev/.env
  set +a
fi

host="${SANCTUM_HOST:?Set SANCTUM_HOST to the dev host, e.g. pi@sanctum-dev.local, in deploy/dev/.env}"
remote_dir="${SANCTUM_HOST_DIR:-sanctum}"
platform="${SANCTUM_HOST_PLATFORM:-linux/arm64}"
tunnel_port="${SANCTUM_HOST_TUNNEL_PORT:-15000}"
# The host's registry listens on its loopback only. Buildx pushes from its own
# container, which reaches this Mac's end of the SSH tunnel through Docker
# Desktop's host.docker.internal.
push_registry="host.docker.internal:${tunnel_port}"
builder="sanctum-host-${tunnel_port}"

on_host() {
  ssh -o BatchMode=yes "$host" "$@"
}

version() {
  local sha
  sha="$(git rev-parse --short=7 HEAD)"
  if [[ -n "$(git status --porcelain)" ]]; then
    # Uncommitted changes get a build of their own.
    echo "dev-${sha}-$(date +%Y%m%d%H%M%S)"
  else
    echo "dev-${sha}"
  fi
}

ensure_builder() {
  if docker buildx inspect "$builder" >/dev/null 2>&1; then
    return
  fi
  local config
  config="$(mktemp)"
  printf '[registry."%s"]\n  http = true\n' "$push_registry" >"$config"
  docker buildx create --name "$builder" --driver docker-container \
    --buildkitd-config "$config" >/dev/null
  rm -f "$config"
}

tunnel_pid=""
close_tunnel() {
  if [[ -n "$tunnel_pid" ]]; then
    kill "$tunnel_pid" 2>/dev/null || true
  fi
}
trap close_tunnel EXIT

open_tunnel() {
  if nc -z 127.0.0.1 "$tunnel_port" 2>/dev/null; then
    echo "Local port ${tunnel_port} is already in use; no registry tunnel was opened" >&2
    exit 1
  fi
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -N \
    -L "127.0.0.1:${tunnel_port}:127.0.0.1:5000" "$host" &
  tunnel_pid=$!
  for _ in $(seq 50); do
    if nc -z 127.0.0.1 "$tunnel_port" 2>/dev/null; then
      return
    fi
    if ! kill -0 "$tunnel_pid" 2>/dev/null; then
      echo "Could not open an SSH tunnel to ${host}" >&2
      exit 1
    fi
    sleep 0.2
  done
  echo "The SSH tunnel to ${host} did not come up" >&2
  exit 1
}

build_and_push() {
  local version="$1"
  ensure_builder
  open_tunnel
  for service in core manager; do
    echo "Building sanctum-${service}:${version} for ${platform}"
    docker buildx build --builder "$builder" --platform "$platform" \
      --provenance=false --build-arg "SANCTUM_VERSION=${version}" \
      -f "apps/${service}/Dockerfile" \
      -t "${push_registry}/sanctum-${service}:${version}" --push .
  done
  close_tunnel
  tunnel_pid=""
}

manager_channel() {
  on_host "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' sanctum-manager 2>/dev/null" |
    sed -n 's/^SANCTUM_CHANNEL=//p'
}

setup() {
  # A failed inspect must mean a missing container, not an unreachable daemon.
  # Check before writing the host's Compose configuration.
  on_host "docker info >/dev/null"
  if on_host "docker inspect sanctum-manager >/dev/null 2>&1"; then
    local channel
    channel="$(manager_channel)"
    if [[ "$channel" == "dev" ]]; then
      echo "${host} is already a dev host; use pnpm host:push" >&2
    else
      echo "${host} runs a ${channel:-stable} host. The dev channel is only for a host set up for development." >&2
    fi
    exit 1
  fi

  local version
  version="$(version)"
  echo "Setting up ${host} as a dev host"
  on_host "mkdir -p '${remote_dir}'"
  scp -q deploy/compose.yml "${host}:${remote_dir}/compose.yml"
  printf 'SANCTUM_CHANNEL=dev\nCOMPOSE_PROFILES=dev\n' |
    on_host "cat > '${remote_dir}/.env'"
  on_host "docker compose -f '${remote_dir}/compose.yml' up -d registry"

  build_and_push "$version"

  # Compose installs only the manager; the manager then creates the core
  # from the same build.
  on_host "echo SANCTUM_MANAGER_IMAGE=localhost:5000/sanctum-manager:${version} >> '${remote_dir}/.env' &&
    docker compose -f '${remote_dir}/compose.yml' up -d manager"
  echo "Waiting for the manager to start the core"
  for _ in $(seq 90); do
    # Over HTTPS, trusting only the host CA.
    if on_host "docker exec sanctum-manager node dist/cli.js core-health" 2>/dev/null; then
      echo
      echo "${host} runs ${version}"
      return
    fi
    sleep 2
  done
  echo "The core did not come up; see: ssh ${host} docker logs sanctum-manager" >&2
  exit 1
}

require_dev_host() {
  if [[ "$(manager_channel)" != "dev" ]]; then
    echo "${host} is not a dev host; set it up with pnpm host:setup" >&2
    exit 1
  fi
}

# Leaves the build in the host's registry, where Settings → System lists it.
publish() {
  require_dev_host
  local version
  version="$(version)"
  build_and_push "$version"
  echo "Published ${version} to ${host}; update to it from Settings → System or pnpm host:push"
}

push() {
  require_dev_host
  local version
  version="$(version)"
  build_and_push "$version"
  echo "Updating ${host} to ${version}"
  # The update replaces the manager's container, so it is followed from a
  # container of its own that reaches the manager through its socket.
  on_host "docker run --rm -v sanctum-manager-socket:/run/sanctum \$(docker inspect -f '{{.Image}}' sanctum-manager) node dist/cli.js update ${version}"
}

status() {
  on_host "docker exec sanctum-manager node dist/cli.js status"
}

case "${1:-}" in
  setup) setup ;;
  push) push ;;
  publish) publish ;;
  status) status ;;
  *)
    echo "Usage: deploy/dev/host.sh setup | push | publish | status" >&2
    exit 1
    ;;
esac
