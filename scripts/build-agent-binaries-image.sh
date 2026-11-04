#!/usr/bin/env bash
# Build a new local binaries image carrying the fork's freshly built agent
# (Windows signed + Linux) and point the stack at it, so agents auto-upgrade
# over heartbeat instead of being reinstalled.
#
#   ./scripts/build-agent-binaries-image.sh 0.125.0
#
# What it does:
#   1. Downloads the binaries for <version> from the GitHub release
#      kreslab-agent-v<version> of this fork.
#   2. Copies /binaries out of the CURRENT binaries image (BREEZE_BINARIES_IMAGE_REF),
#      replaces the rebuilt files, drops any upstream release manifest (it would
#      not match the fork's binaries) and writes VERSION=<version>.
#   3. Builds  <repo>:kreslab-<version>  on top of the current image.
#   4. Backs up .env, then sets BREEZE_BINARIES_IMAGE_REF and BREEZE_VERSION
#      (the API serves the volume only when VERSION == BREEZE_VERSION; otherwise
#      it falls back to upstream's GitHub release).
#   5. Recreates binaries-init + api so the new binaries are registered.
#
# Nothing is promoted: with AGENT_AUTO_PROMOTE=false the fleet keeps its current
# target until you promote <version> (see the message printed at the end).
set -euo pipefail

VERSION="${1:-}"
if [[ ! "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Usage: $0 <version, e.g. 0.125.0>" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${REPO_DIR}"
ENV_FILE="${REPO_DIR}/.env"
RELEASE_BASE="${RELEASE_BASE:-https://github.com/trungthang2601/breeze/releases/download/kreslab-agent-v${VERSION}}"
COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.override.yml.podman -f docker-compose.override.yml.selfbuild)

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

BASE_IMAGE="$(grep -E '^BREEZE_BINARIES_IMAGE_REF=' "${ENV_FILE}" | tail -1 | cut -d= -f2-)"
[[ -n "${BASE_IMAGE}" ]] || { echo "BREEZE_BINARIES_IMAGE_REF not found in .env" >&2; exit 1; }
NEW_IMAGE="${BASE_IMAGE%:*}:kreslab-${VERSION}"
log "Current binaries image: ${BASE_IMAGE}"
log "New binaries image:     ${NEW_IMAGE}"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# 1. Download the new binaries.
FILES=(
  breeze-agent-windows-amd64.exe
  breeze-user-helper-windows-amd64.exe
  breeze-watchdog-windows-amd64.exe
  breeze-agent-linux-amd64
)
mkdir -p "${WORK}/new"
for f in "${FILES[@]}"; do
  log "Downloading ${f}"
  curl -fL --retry 3 -o "${WORK}/new/${f}" "${RELEASE_BASE}/${f}"
done
curl -fL --retry 3 -o "${WORK}/new/SHA256SUMS" "${RELEASE_BASE}/SHA256SUMS"
(cd "${WORK}/new" && sha256sum -c --ignore-missing SHA256SUMS)

# 2. Copy the current image's /binaries out and swap in the new files.
cid="$(docker create "${BASE_IMAGE}")"
docker cp "${cid}:/binaries" "${WORK}/binaries"
docker rm "${cid}" >/dev/null
mkdir -p "${WORK}/binaries/agent"
for f in "${FILES[@]}"; do
  install -m 0755 "${WORK}/new/${f}" "${WORK}/binaries/agent/${f}"
done
rm -f "${WORK}/binaries/release-artifact-manifest.json" "${WORK}/binaries/release-artifact-manifest.json.ed25519"
printf '%s\n' "${VERSION}" > "${WORK}/binaries/VERSION"

log "Agent dir now contains:"
ls -la "${WORK}/binaries/agent"
stale=()
for p in "${WORK}/binaries/agent"/breeze-*; do
  name="$(basename "${p}")"
  printf '%s\n' "${FILES[@]}" | grep -qx "${name}" || stale+=("${name}")
done
if ((${#stale[@]})); then
  log "Not rebuilt this time (kept from ${BASE_IMAGE}, will be labelled ${VERSION}): ${stale[*]}"
fi

# 3. Build the image on top of the current one (keeps its entrypoint).
cat > "${WORK}/Dockerfile" <<EOF
FROM ${BASE_IMAGE}
RUN rm -rf /binaries
COPY binaries/ /binaries/
EOF
docker build -t "${NEW_IMAGE}" -f "${WORK}/Dockerfile" "${WORK}"

# 4. Point .env at it (backup first).
cp "${ENV_FILE}" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
sed -i "s|^BREEZE_BINARIES_IMAGE_REF=.*|BREEZE_BINARIES_IMAGE_REF=${NEW_IMAGE}|" "${ENV_FILE}"
if grep -qE '^BREEZE_VERSION=' "${ENV_FILE}"; then
  sed -i "s|^BREEZE_VERSION=.*|BREEZE_VERSION=${VERSION}|" "${ENV_FILE}"
else
  printf 'BREEZE_VERSION=%s\n' "${VERSION}" >> "${ENV_FILE}"
fi
log ".env updated (backup kept next to it)."

# 5. Re-seed the binaries volume and let the API register the new version.
"${COMPOSE[@]}" up -d --force-recreate binaries-init
"${COMPOSE[@]}" up -d --force-recreate api
log "Waiting for the API to register ${VERSION}..."
for _ in $(seq 1 60); do
  if docker logs --tail 400 breeze-api 2>&1 | grep -q "${VERSION}"; then break; fi
  sleep 5
done
docker logs --tail 400 breeze-api 2>&1 | grep -i "binarySync" | tail -15 || true

cat <<EOF

Done. Version ${VERSION} is registered but NOT yet pushed to the fleet.
Next:
  - Test on one machine first, then promote ${VERSION} (platform admin + MFA),
    or set AGENT_AUTO_PROMOTE in docker-compose.override.yml.podman to "true"
    and run:  ${COMPOSE[*]} up -d api
To undo: restore the .env.bak-* file and run
  ${COMPOSE[*]} up -d --force-recreate binaries-init api
EOF
