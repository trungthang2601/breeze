#!/usr/bin/env bash
#
# Breeze RMM — update a self-hosted stack from this git checkout
#
# Pulls the latest commit of the current branch, backs up the database,
# rebuilds the api/web/portal images from source and restarts the stack.
# Database migrations run automatically when the API starts (AUTO_MIGRATE).
#
# Usage (from anywhere, on the server):
#   ./scripts/update-from-source.sh               # git pull + backup + rebuild + restart
#   ./scripts/update-from-source.sh --no-pull     # deploy the checkout as it is now
#   ./scripts/update-from-source.sh --skip-backup # skip the pg_dump step
#
# Environment variables:
#   BACKUP_DIR              Where database dumps go (default: /var/backups/breeze)
#   BACKUP_KEEP             Number of pre-update dumps to keep (default: 10)
#   HEALTH_TIMEOUT_SECONDS  How long to wait for the API to become healthy (default: 900)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_DIR}"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/breeze}"
BACKUP_KEEP="${BACKUP_KEEP:-10}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-900}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.override.yml.selfbuild)
BUILD_SERVICES=(api web portal)

DO_PULL=true
DO_BACKUP=true
for arg in "$@"; do
  case "${arg}" in
    --no-pull) DO_PULL=false ;;
    --skip-backup) DO_BACKUP=false ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: ${arg}" >&2; exit 2 ;;
  esac
done

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { log "ERROR: $*" >&2; exit 1; }

# Reads KEY from .env without sourcing it (values may contain shell metacharacters).
env_value() {
  local line
  line="$(grep -E "^[[:space:]]*$1=" .env | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%\"}"; line="${line#\"}"
  line="${line%\'}"; line="${line#\'}"
  printf '%s' "${line}"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

command -v git >/dev/null || die "git is not installed."
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available."
[[ -f .env ]] || die "No .env in ${REPO_DIR}. Copy the .env from your existing Breeze install here first."

project="$("${COMPOSE[@]}" config 2>/dev/null | awk '/^name:/ {print $2; exit}')"
[[ -n "${project}" ]] || die "docker compose config failed — run '${COMPOSE[*]} config' to see why."

# The data volumes are named <project>_postgres_data etc. If the running stack
# belongs to a different Compose project, this run would start an EMPTY
# database next to it instead of upgrading it.
running_project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' breeze-postgres 2>/dev/null || true)"
if [[ -n "${running_project}" && "${running_project}" != "${project}" ]]; then
  die "The running Breeze stack uses Compose project '${running_project}', but this checkout resolves to '${project}'.
       Add COMPOSE_PROJECT_NAME=${running_project} to ${REPO_DIR}/.env so the existing data volumes stay attached,
       then stop the old stack from its own directory ('docker compose down', never 'down -v') and rerun this script."
fi
if [[ -z "${running_project}" ]] && ! docker volume inspect "${project}_postgres_data" >/dev/null 2>&1; then
  log "WARNING: no running stack and no volume '${project}_postgres_data' — this will start a NEW, empty database."
  log "         If you already have Breeze data, set COMPOSE_PROJECT_NAME in .env to the old project name first."
  read -r -p "Continue anyway? [y/N] " answer
  [[ "${answer}" =~ ^[Yy]$ ]] || exit 1
fi

# ---------------------------------------------------------------------------
# 1. Fetch the new code
# ---------------------------------------------------------------------------

old_rev="$(git rev-parse --short HEAD)"
if [[ "${DO_PULL}" == true ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    die "There are local edits on the server (git status). Commit or discard them — the server should only run what is on GitHub."
  fi
  log "Pulling latest code ($(git rev-parse --abbrev-ref HEAD))..."
  git pull --ff-only
fi
new_rev="$(git rev-parse --short HEAD)"
log "Deploying ${new_rev} (was ${old_rev}): $(git log -1 --format=%s)"

# ---------------------------------------------------------------------------
# 2. Back up the database (migrations are forward-only)
# ---------------------------------------------------------------------------

if [[ "${DO_BACKUP}" == true ]]; then
  if [[ "$(docker inspect -f '{{.State.Running}}' breeze-postgres 2>/dev/null || true)" == true ]]; then
    pg_user="$(env_value POSTGRES_USER)"; pg_user="${pg_user:-breeze}"
    pg_db="$(env_value POSTGRES_DB)"; pg_db="${pg_db:-breeze}"
    mkdir -p "${BACKUP_DIR}"
    dump="${BACKUP_DIR}/pre-update-$(date +%Y%m%d_%H%M%S)-${old_rev}.dump"
    log "Backing up database to ${dump}..."
    if ! docker exec breeze-postgres pg_dump -U "${pg_user}" -d "${pg_db}" -Fc > "${dump}"; then
      rm -f "${dump}"
      die "Database backup failed; nothing was changed. Rerun with --skip-backup to proceed without one."
    fi
    log "Backup done ($(du -h "${dump}" | cut -f1))."
    # shellcheck disable=SC2012
    ls -1t "${BACKUP_DIR}"/pre-update-*.dump 2>/dev/null | tail -n +"$((BACKUP_KEEP + 1))" | xargs -r rm -f
  else
    log "Postgres is not running; skipping backup."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Build and restart
# ---------------------------------------------------------------------------

log "Building images: ${BUILD_SERVICES[*]} (first build can take 10+ minutes)..."
"${COMPOSE[@]}" build "${BUILD_SERVICES[@]}"

log "Restarting the stack..."
"${COMPOSE[@]}" up -d

# ---------------------------------------------------------------------------
# 4. Wait for the API (migrations run before it reports healthy)
# ---------------------------------------------------------------------------

log "Waiting for the API to become healthy (migrations may take a while)..."
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while true; do
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' breeze-api 2>/dev/null || echo missing)"
  [[ "${status}" == healthy ]] && break
  if (( SECONDS >= deadline )); then
    docker logs --tail 60 breeze-api 2>&1 || true
    die "API is still '${status}' after ${HEALTH_TIMEOUT_SECONDS}s. Check: docker logs breeze-api
       Database backup (if taken): ${dump:-none}"
  fi
  sleep 5
done

docker image prune -f >/dev/null
"${COMPOSE[@]}" ps
log "Update complete: running ${new_rev}."
