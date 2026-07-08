#!/usr/bin/env bash
#
# Kin — one-command VPS installer (fresh Ubuntu/Debian → running stack).
#
# Path A (public-IP VPS + Traefik + Let's Encrypt). For the Mac/OrbStack tunnel path
# use scripts/install-tunnel.sh. This brings up docker-compose.prod.yml: installs Docker
# if missing, generates secrets, prompts ONLY for what can't be auto-generated (LLM gateway
# key, domain, Cloudflare token), pulls the prebuilt multi-arch images from GHCR, starts the
# stack, and waits until it serves.
#
# Usage (run from the cloned kin repo root):
#   sudo bash scripts/install-vps.sh           # interactive
#   sudo bash scripts/install-vps.sh --yes     # non-interactive (required values from env)
#
# Non-interactive required env: APP_HOSTNAME ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
#   ANTHROPIC_MODEL ACME_EMAIL CF_DNS_API_TOKEN   (datastore/auth secrets are auto-generated)
#
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env"
PROJECT="${KIN_PROJECT:-kin}"
REPO_ROOT="$(pwd -P)"

NONINTERACTIVE=0
case "${1:-}" in --yes | --non-interactive) NONINTERACTIVE=1 ;; esac

c_g=$'\033[1;32m'; c_y=$'\033[1;33m'; c_r=$'\033[1;31m'; c_0=$'\033[0m'
log()  { printf '%s[kin]%s %s\n' "$c_g" "$c_0" "$*"; }
warn() { printf '%s[kin]%s %s\n' "$c_y" "$c_0" "$*" >&2; }
die()  { printf '%s[kin ERROR]%s %s\n' "$c_r" "$c_0" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
rand() { openssl rand -hex 32; }
json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
model_seed_json() {
  local base_url="$1" model="$2" escaped_base escaped_model model_id
  escaped_base="$(json_escape "$base_url")"
  escaped_model="$(json_escape "$model")"
  model_id="default/${escaped_model}"
  printf '{"default":"%s","connections":[{"id":"default","label":"Default","baseUrl":"%s","authStyle":"bearer","tokenEnv":"ANTHROPIC_AUTH_TOKEN"}],"models":[{"id":"%s","label":"%s","connection":"default","model":"%s","enabled":true,"isDefault":true,"tags":["chat"]}]}' \
    "$model_id" "$escaped_base" "$model_id" "$escaped_model" "$escaped_model"
}
env_has_key() {
  grep -Eq "^$1=" "$ENV_FILE"
}
append_env_if_missing() {
  local key="$1" value="$2"
  shift 2
  env_has_key "$key" && return 0
  {
    [ "$#" -gt 0 ] && printf '\n'
    while [ "$#" -gt 0 ]; do
      printf '%s\n' "$1"
      shift
    done
    printf '%s=%s\n' "$key" "$value"
  } >> "$ENV_FILE"
}

ask() { # ask VAR "prompt" [default]   — env value > interactive prompt > default
  local var="$1" q="$2" def="${3:-}" cur="" ans=""
  eval "cur=\${$var:-}"
  if [ -n "$cur" ]; then printf '%s' "$cur"; return; fi
  if [ "$NONINTERACTIVE" -eq 1 ]; then
    [ -n "$def" ] && { printf '%s' "$def"; return; }
    die "missing required \$$var (non-interactive mode)"
  fi
  read -r -p "  $q${def:+ [$def]}: " ans </dev/tty || true
  printf '%s' "${ans:-$def}"
}

# --- 0. preflight -----------------------------------------------------------
[ -f "$COMPOSE_FILE" ] || die "run this from the cloned kin repo root (no $COMPOSE_FILE here)."
have openssl || die "openssl is required."
have curl || die "curl is required."
if [ "$(id -u)" -ne 0 ]; then
  have sudo || die "run as root, or install sudo."
  SUDO="sudo"
else
  SUDO=""
fi

# --- 1. Docker --------------------------------------------------------------
if ! have docker; then
  log "Docker not found — installing via get.docker.com…"
  curl -fsSL https://get.docker.com | $SUDO sh
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing (apt install docker-compose-plugin)."
log "Docker $(docker --version | awk '{print $3}' | tr -d ,) ready."

mem_gb=$(awk '/MemTotal/{printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 0)
[ "$mem_gb" -lt 8 ] && warn "Host has ~${mem_gb}GB RAM. Kin wants ~8GB to run; consider scripts/add-swap.sh."

# --- 2. .env (idempotent — never clobber existing secrets) ------------------
if [ -f "$ENV_FILE" ]; then
  log "$ENV_FILE exists — reusing it (secrets preserved)."
else
  log "Generating $ENV_FILE …"
  APP_HOSTNAME="$(ask APP_HOSTNAME 'Your domain (DNS on Cloudflare), e.g. kin.example.com')"
  [ -n "$APP_HOSTNAME" ] || die "APP_HOSTNAME is required."
  ANTHROPIC_AUTH_TOKEN="$(ask ANTHROPIC_AUTH_TOKEN 'LLM gateway token (ARK/Anthropic-compatible, Bearer)')"
  [ -n "$ANTHROPIC_AUTH_TOKEN" ] || die "ANTHROPIC_AUTH_TOKEN is required."
  ANTHROPIC_BASE_URL="$(ask ANTHROPIC_BASE_URL 'Gateway base URL' 'https://ark.cn-beijing.volces.com/api/coding')"
  ANTHROPIC_MODEL="$(ask ANTHROPIC_MODEL 'Default model id (per your gateway)')"
  [ -n "$ANTHROPIC_MODEL" ] || die "ANTHROPIC_MODEL is required (else the model menu is empty)."
  ACME_EMAIL="$(ask ACME_EMAIL 'Email for Lets Encrypt TLS')"
  [ -n "$ACME_EMAIL" ] || die "ACME_EMAIL is required for the default TLS path."
  CF_DNS_API_TOKEN="$(ask CF_DNS_API_TOKEN 'Cloudflare API token (Zone:DNS:Edit — for the wildcard cert)')"
  [ -n "$CF_DNS_API_TOKEN" ] || die "CF_DNS_API_TOKEN is required for the wildcard cert (or switch to Origin CA, see docker-compose.md)."
  OXY_MODELS_SEED="$(model_seed_json "$ANTHROPIC_BASE_URL" "$ANTHROPIC_MODEL")"

  uniq="$(openssl rand -hex 3)"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Generated by install-vps.sh $(date -u +%FT%TZ). SECRET — chmod 600. Do not commit.
# --- identity / domain ---
APP_HOSTNAME=${APP_HOSTNAME}
APP_NAME=Kin
APP_NAME_SANITIZED=kin-${uniq}
# --- image (prebuilt multi-arch from GHCR; pull by default) ---
# NOTE: :latest is published only on the main-branch release. Before that, pin a published
# tag, e.g. APP_TAG=<git-sha>. See: docker buildx imagetools inspect ghcr.io/deeptoai-com/kin/app
APP_IMAGE=${APP_IMAGE:-ghcr.io/deeptoai-com/kin/app}
APP_TAG=${APP_TAG:-latest}
APP_PULL_POLICY=${APP_PULL_POLICY:-always}
# --- datastore + auth (auto-generated random secrets) ---
POSTGRES_USER=kin
POSTGRES_PASSWORD=$(rand)
POSTGRES_DB=kin
MINIO_ROOT_USER=kin
MINIO_ROOT_PASSWORD=$(rand)
MINIO_BUCKET=kin-files
MEILI_MASTER_KEY=$(rand)
BETTER_AUTH_SECRET=$(rand)
JOBS_SECRET=$(rand)
# Registry v2 master key for admin-pasted credentials. Generate once per deployment;
# do not rotate casually, or stored credentials must be re-entered.
KIN_SECRET_KEY=$(rand)
UPDATER_TOKEN=$(rand)
# --- TLS (Let's Encrypt DNS-01 via Cloudflare → wildcard cert for previews) ---
ACME_EMAIL=${ACME_EMAIL}
CF_DNS_API_TOKEN=${CF_DNS_API_TOKEN}
# --- online auto-update ---
UPDATER_PROD_ENV_DIR=${REPO_ROOT}
UPDATER_COMPOSE_ENV_FILE=/run/updater/envd/.env
# --- LLM gateway (ARK uses Bearer ANTHROPIC_AUTH_TOKEN; do NOT set ANTHROPIC_API_KEY) ---
ANTHROPIC_AUTH_TOKEN=${ANTHROPIC_AUTH_TOKEN}
ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}
ANTHROPIC_MODEL=${ANTHROPIC_MODEL}
ANTHROPIC_DEFAULT_SONNET_MODEL=${ANTHROPIC_MODEL}
ANTHROPIC_DEFAULT_OPUS_MODEL=${ANTHROPIC_MODEL}
ANTHROPIC_DEFAULT_HAIKU_MODEL=${ANTHROPIC_DEFAULT_HAIKU_MODEL:-${ANTHROPIC_MODEL}}
CLAUDE_CODE_SUBAGENT_MODEL=${ANTHROPIC_MODEL}
OXY_MODELS_SEED=${OXY_MODELS_SEED}
# --- first-run UX (register the first account without an email round-trip) ---
ENABLE_EMAIL_VERIFICATION=false
EOF
  chmod 600 "$ENV_FILE"
  log "$ENV_FILE written (chmod 600)."
fi

# Keep older installer-generated .env files usable without clobbering any existing value.
chmod 600 "$ENV_FILE"
append_env_if_missing "KIN_SECRET_KEY" "$(rand)" \
  "# Registry v2 master key for admin-pasted credentials. Generate once per deployment;" \
  "# do not rotate casually, or stored credentials must be re-entered."
append_env_if_missing "UPDATER_TOKEN" "$(rand)" \
  "# Shared secret between app and updater sidecar. Empty or missing disables online updates."
append_env_if_missing "UPDATER_PROD_ENV_DIR" "$REPO_ROOT" \
  "# Directory mount for the full production env; survives inode-swapping edits."
append_env_if_missing "UPDATER_COMPOSE_ENV_FILE" "/run/updater/envd/.env"
if ! env_has_key "OXY_MODELS_SEED"; then
  env_base_url="$(grep -E '^ANTHROPIC_BASE_URL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  env_model="$(grep -E '^ANTHROPIC_MODEL=' "$ENV_FILE" | tail -1 | cut -d= -f2-)"
  if [ -n "$env_base_url" ] && [ -n "$env_model" ]; then
    append_env_if_missing "OXY_MODELS_SEED" "$(model_seed_json "$env_base_url" "$env_model")" \
      "# Registry v2 bootstrap seed; non-secret JSON. Secrets are referenced by tokenEnv name."
  fi
fi

host_domain="$(grep -E '^APP_HOSTNAME=' "$ENV_FILE" | cut -d= -f2-)"
img_ref="$(grep -E '^APP_IMAGE=' "$ENV_FILE" | cut -d= -f2-):$(grep -E '^APP_TAG=' "$ENV_FILE" | cut -d= -f2-)"

# --- 3. pre-flight: image tag exists + DNS (soft) ---------------------------
log "Pre-flight: checking image ${img_ref} is pullable…"
docker manifest inspect "$img_ref" >/dev/null 2>&1 || \
  die "image ${img_ref} not found. If :latest isn't published yet, set APP_TAG to a published sha in $ENV_FILE (docker buildx imagetools inspect ghcr.io/deeptoai-com/kin/app)."

cf_token="$(grep -E '^CF_DNS_API_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- || true)"
cf_token="${cf_token%\"}"; cf_token="${cf_token#\"}"
cf_token="${cf_token%\'}"; cf_token="${cf_token#\'}"
if [ -n "$cf_token" ]; then
  log "Pre-flight: checking Cloudflare token can read zones from this host…"
  cf_body="$(mktemp)"
  cf_status="$(curl -sS -o "$cf_body" -w '%{http_code}' \
    -H "Authorization: Bearer ${cf_token}" \
    "https://api.cloudflare.com/client/v4/zones?per_page=1" 2>/dev/null || true)"
  if [ "$cf_status" != "200" ]; then
    cf_error="$(tr '\n' ' ' < "$cf_body" | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c1-260)"
    rm -f "$cf_body"
    die "Cloudflare token cannot read zones from this host (HTTP ${cf_status:-000}). It needs Zone:Read + DNS:Edit on the zone, and any Client IP/location restriction must include this server. ${cf_error}"
  fi
  rm -f "$cf_body"
fi

pubip="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
dnsip="$(getent hosts "$host_domain" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [ -n "$pubip" ] && [ -n "$dnsip" ] && [ "$pubip" != "$dnsip" ]; then
  warn "DNS: ${host_domain} → ${dnsip}, this host is ${pubip}. With Cloudflare proxy (orange-cloud) that's expected; otherwise fix the A record."
fi
warn "Make sure DNS has BOTH: A '@' → your IP AND A '*' (wildcard) — the wildcard is required for the TLS cert + previews."

# --- 4. bring up ------------------------------------------------------------
dc() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" -p "$PROJECT" "$@"; }
log "Pulling images…"; dc pull
log "Starting the stack…"; dc up -d

# --- 5. health gate ---------------------------------------------------------
log "Waiting for trusted https://${host_domain}/health (up to ~5 min; first run also issues the TLS cert)…"
ok=0
last_probe=""
for _ in $(seq 1 60); do
  probe_err="$(mktemp)"
  code="$(curl -sS -o /dev/null -w '%{http_code}' "https://${host_domain}/health" 2>"$probe_err" || true)"
  err="$(tr '\n' ' ' < "$probe_err" | sed 's/[[:space:]][[:space:]]*/ /g' | cut -c1-240)"
  rm -f "$probe_err"
  last_probe="HTTP ${code:-000}${err:+ — ${err}}"
  [ "$code" = "200" ] && { ok=1; break; }
  sleep 5
done
echo
if [ "$ok" -eq 1 ]; then
  log "✅ Kin is up → https://${host_domain}"
  log "   Open it and register the first account (email verification is off)."
else
  warn "Stack started but trusted https://${host_domain}/health hasn't returned 200 yet."
  [ -n "$last_probe" ] && warn "Last probe: ${last_probe}"
  warn "Inspect:  $SUDO docker compose -f $COMPOSE_FILE -p $PROJECT ps   /   logs -f app traefik"
  warn "Usual causes: DNS '@'/'*' not live yet, Cloudflare token lacks Zone:Read/DNS:Edit, or the DNS-01 cert is still issuing."
fi
