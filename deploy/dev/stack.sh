#!/usr/bin/env bash
# A development stack: the manager and the core in Docker, as on a host, built
# from this worktree. Each worktree has a stack of its own, with its own port
# and data, so sessions can share one Docker.
#
#   pnpm dev           start this worktree's stack and rebuild what changes
#   pnpm dev:stop      stop it and keep its data
#   pnpm dev:seed      claim a new home and put its fake lights in rooms
#   pnpm dev:down      remove it and its data
#   pnpm dev:status    its address, port and containers, and any other stacks
#   pnpm dev:logs      follow a container's log: core (default), manager or a service
#
# SANCTUM_STACK names the stack, SANCTUM_STACK_PORT sets its port, and
# SANCTUM_STACK_HTTPS=true has its core serve HTTPS with the host CA, as on a
# host, for the desktop app. Plain HTTP is the default, for the client in a
# browser, which can't check a certificate.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

stack_file="$root/.sanctum-stack"
compose_file="deploy/dev/stack.compose.yml"

# Remembers what was chosen for this worktree: the port stays, so an address
# in a running desktop app stays good. A stack named by hand, as in a test,
# keeps nothing here.
named_by_hand="${SANCTUM_STACK:+true}"
if [[ -z "$named_by_hand" && -f "$stack_file" ]]; then
  # shellcheck disable=SC1090
  source "$stack_file"
fi

default_name() {
  local name path_id
  name="$(basename "$root" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9\n' '-')"
  name="$(printf '%s' "$name" | sed 's/^-*//;s/-*$//')"
  [[ -z "$name" || "$name" == "sanctum" ]] && name="main"
  # Folder names alone can collide, including after truncation.
  path_id="$(printf '%s' "$root" | cksum | cut -d' ' -f1)"
  echo "${name:0:30}-${path_id}"
}

stack="${SANCTUM_STACK:-${saved_stack:-$(default_name)}}"
export SANCTUM_STACK="$stack"

is_listening() {
  nc -z 127.0.0.1 "$1" 2>/dev/null
}

# Two ports in a row from one the worktree's path hints at: the core's and, if
# the stack needs it, its registry's.
pick_port() {
  local port=$((41000 + $(printf '%s' "$root" | cksum | cut -d' ' -f1) % 2000))
  while is_listening "$port" || is_listening "$((port + 1))"; do
    port=$((port + 2))
  done
  echo "$port"
}

container() {
  echo "sanctum-${stack}-$1"
}

running_core_port() {
  { docker port "$(container core)" 4100/tcp 2>/dev/null || true; } | sed -n 's/.*:\([0-9]*\)$/\1/p' | head -1
}

settings() {
  if [[ -z "${SANCTUM_STACK_PORT:-}" ]]; then
    SANCTUM_STACK_PORT="$(running_core_port)"
    if [[ -z "$SANCTUM_STACK_PORT" ]]; then
      SANCTUM_STACK_PORT="${saved_port:-}"
      # Something else took it while this stack was stopped.
      if [[ -z "$SANCTUM_STACK_PORT" ]] || is_listening "$SANCTUM_STACK_PORT"; then
        SANCTUM_STACK_PORT="$(pick_port)"
      fi
    fi
  fi
  export SANCTUM_STACK_PORT
  export SANCTUM_STACK_REGISTRY_PORT="$((SANCTUM_STACK_PORT + 1))"
  if [[ -z "$named_by_hand" ]]; then
    printf 'saved_stack=%q\nsaved_port=%q\n' "$stack" "$SANCTUM_STACK_PORT" >"$stack_file"
  fi

  if [[ "${SANCTUM_STACK_HTTPS:-false}" == "true" ]]; then
    scheme="https"
    SANCTUM_STACK_CORE_ENV=""
  else
    scheme="http"
    SANCTUM_STACK_CORE_ENV="CORE_PLAIN_HTTP=true"
  fi
  if [[ -n "${CORE_ALLOWED_ORIGINS:-}" ]]; then
    SANCTUM_STACK_CORE_ENV="${SANCTUM_STACK_CORE_ENV};CORE_ALLOWED_ORIGINS=${CORE_ALLOWED_ORIGINS}"
  fi
  export SANCTUM_STACK_CORE_ENV
  export SANCTUM_STACK_CORE_URL="${scheme}://127.0.0.1:${SANCTUM_STACK_PORT}"
  export SANCTUM_CORE_URL="$SANCTUM_STACK_CORE_URL"
}

# The worktree's built code over the image's, read-only. Compose mounts the
# manager's; the manager mounts these into the core it creates. Apps run
# apart, from the packages the manager stages.
core_binds() {
  local path binds=""
  for path in apps/core/dist apps/core/migrations \
    packages/app-sdk/dist packages/auth-protocol/dist; do
    [[ -e "$path" ]] && binds+="${root}/${path}:/app/${path}:ro;"
  done
  echo "$binds"
}

compose() {
  local profiles=()
  if [[ "${SANCTUM_STACK_REGISTRY:-false}" == "true" ]]; then
    profiles=(--profile registry)
  fi
  docker compose -f "$compose_file" "${profiles[@]+"${profiles[@]}"}" "$@"
}

image_id() {
  docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true
}

build_images() {
  local service
  for service in core manager; do
    # Local images need stable IDs when the inputs haven't changed, as the
    # dev host's builds do; provenance gives each export a new digest.
    docker build --quiet --provenance=false -f deploy/dev/stack.Dockerfile --target "$service" \
      --label "sanctum.stack=${stack}" \
      -t "sanctum-${stack}-${service}:dev" . >/dev/null
  done
}

wait_for_core() {
  local curl_options=(-fsS --max-time 2)
  [[ "$scheme" == "https" ]] && curl_options+=(-k)
  for _ in $(seq 120); do
    if curl "${curl_options[@]}" "${SANCTUM_STACK_CORE_URL}/api/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  echo "The core didn't come up; see: pnpm dev:logs manager" >&2
  exit 1
}

# A core made from another image or with other settings, such as plain HTTP
# after HTTPS or another port: the manager creates it again with these. It
# keeps a core it finds, so one must go for this to take effect.
remove_core_with_other_settings() {
  local name env binds port plain=false stale=false origins owner
  name="$(container core)"
  env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" 2>/dev/null || true)"
  [[ -n "$env" ]] || return 0
  owner="$(docker inspect -f '{{index .Config.Labels "sanctum.stack"}}' "$name")"
  if [[ "$owner" != "$stack" ]]; then
    echo "Refusing to manage ${name}: it doesn't belong to stack ${stack}" >&2
    exit 1
  fi
  grep -qx 'CORE_PLAIN_HTTP=true' <<<"$env" && plain=true
  [[ "$plain" == "$([[ "$scheme" == "http" ]] && echo true || echo false)" ]] || stale=true
  origins="$(sed -n 's/^CORE_ALLOWED_ORIGINS=//p' <<<"$env" | tail -1)"
  [[ "$origins" == "${CORE_ALLOWED_ORIGINS:-app://sanctum}" ]] || stale=true
  port="$(docker inspect -f '{{range (index .HostConfig.PortBindings "4100/tcp")}}{{.HostPort}}{{end}}' "$name")"
  [[ "$port" == "$SANCTUM_STACK_PORT" ]] || stale=true
  [[ "$(docker inspect -f '{{.Image}}' "$name")" == "$(image_id "sanctum-${stack}-core:dev")" ]] || stale=true
  binds="$(docker inspect -f '{{index .Config.Labels "sanctum.stack.core-binds"}}' "$name")"
  [[ "$binds" == "${SANCTUM_STACK_CORE_BINDS%;}" ]] || stale=true
  if [[ "$stale" == "true" ]]; then
    docker rm -f "$name" >/dev/null
    # It looks for a missing core only now and then.
    docker restart "$(container manager)" >/dev/null
  fi
}

up() {
  if ! docker info >/dev/null 2>&1; then
    echo "pnpm dev runs in Docker: start Docker first" >&2
    exit 1
  fi
  settings
  pnpm turbo run build --ui=stream --output-logs=errors-only \
    --filter=@meetsanctum/core... --filter=@meetsanctum/manager... \
    --filter='./catalog/apps/*'
  export SANCTUM_STACK_CORE_BINDS
  SANCTUM_STACK_CORE_BINDS="$(core_binds)"
  build_images
  compose up -d --no-build --remove-orphans
  remove_core_with_other_settings
  wait_for_core
  echo "Stack ${stack}: the core answers at ${SANCTUM_STACK_CORE_URL}"
}

stop_stack() {
  local ids role name owner
  # Stop the updater before the manager, so it cannot create a replacement.
  # The manager before its core and services, or it would start them again.
  for role in manager-updater manager; do
    name="$(container "$role")"
    owner="$(docker inspect -f '{{index .Config.Labels "sanctum.stack"}}' "$name" 2>/dev/null || true)"
    if [[ "$owner" == "$stack" ]]; then
      docker stop "$name" >/dev/null 2>&1 || true
    fi
  done
  ids="$(docker ps -q --filter "label=sanctum.stack=${stack}")"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker stop $ids >/dev/null
  fi
}

# Apps' images stay attached to loop devices, which outlive their volume and
# hold on to its space until Docker restarts (apps/manager/src/apps/images.ts).
# Only ever this stack's: a loop device can also be something else's.
detach_images() {
  local image
  # A test may have built it under another tag.
  image="$(docker image ls --filter "reference=sanctum-${stack}-manager" \
    --format '{{.Repository}}:{{.Tag}}' | head -1)"
  [[ -n "$image" ]] || return 0
  docker volume inspect "$(container manager-data)" >/dev/null 2>&1 || return 0
  docker run --rm --privileged -v "$(container manager-data):/sanctum-data" \
    --label "sanctum.stack=${stack}" "$image" sh -c '
      for file in /sanctum-data/images/*.img; do
        [ -e "$file" ] || continue
        losetup -j "$file" -n -O NAME | xargs -r losetup -d
      done' >/dev/null 2>&1 || echo "Could not detach this stack's images" >&2
}

down() {
  local ids
  stop_stack
  ids="$(docker ps -aq --filter "label=sanctum.stack=${stack}")"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker rm -f -v $ids >/dev/null
  fi
  detach_images
  ids="$(docker volume ls -q --filter "label=sanctum.stack=${stack}")"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker volume rm $ids >/dev/null
  fi
  ids="$(docker network ls -q --filter "label=sanctum.stack=${stack}")"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker network rm $ids >/dev/null
  fi
  ids="$(docker image ls -q --filter "label=sanctum.stack=${stack}" | sort -u)"
  if [[ -n "$ids" ]]; then
    # shellcheck disable=SC2086
    docker image rm -f $ids >/dev/null 2>&1 || true
  fi
  if [[ -z "$named_by_hand" ]]; then
    rm -f "$stack_file"
  fi
  echo "Stack ${stack} is gone"
}

dev() {
  trap stop_stack EXIT
  up
  # Rebuilds a package when its source changes, and Node in the container
  # restarts when its built code does.
  pnpm turbo watch build dev --concurrency=30 \
    --filter=@meetsanctum/core... --filter=@meetsanctum/manager... \
    --filter='./catalog/apps/*' --filter=@meetsanctum/client... \
    --filter=@meetsanctum/website
}

seed() {
  local env
  settings
  # This can run from a new shell that didn't start the stack with HTTPS.
  env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(container core)")"
  if grep -qx 'CORE_PLAIN_HTTP=true' <<<"$env"; then
    scheme="http"
  else
    scheme="https"
  fi
  docker exec -i -w /app/apps/core \
    -e SEED_CORE_URL="${scheme}://127.0.0.1:4100" \
    -e NODE_TLS_REJECT_UNAUTHORIZED="$([[ "$scheme" == "https" ]] && echo 0 || echo 1)" \
    "$(container core)" node --no-warnings --input-type=module - <deploy/dev/seed.mjs
}

status() {
  local port
  port="$(running_core_port)"
  echo "This worktree's stack: ${stack}"
  if [[ -n "$port" ]]; then
    echo "Its core: 127.0.0.1:${port}"
  fi
  docker ps -a --filter "label=sanctum.stack=${stack}" --format '  {{.Names}}: {{.Status}}'
  local others
  others="$(docker ps -a --filter label=sanctum.stack --format '{{.Label "sanctum.stack"}}' | sort -u | grep -vx "$stack" || true)"
  if [[ -n "$others" ]]; then
    echo "Other stacks on this Docker:"
    echo "${others//$'\n'/$'\n'  }" | sed '1s/^/  /'
  fi
}

case "${1:-}" in
  dev) dev ;;
  up) up ;;
  seed) seed ;;
  stop) stop_stack ;;
  down) down ;;
  status) status ;;
  logs) docker logs -f "$(container "${2:-core}")" ;;
  *)
    echo "Usage: $0 dev|up|seed|stop|down|status|logs [core|manager|<service>]" >&2
    exit 1
    ;;
esac
