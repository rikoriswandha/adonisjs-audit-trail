#!/usr/bin/env bash
set -Eeuo pipefail

# End-to-end consumer harness for @rikology/adonisjs-audit-trail.
#
# It verifies the package consumers receive from npm: build once, pack once,
# configure a fresh AdonisJS application using explicit named connections, then
# compile, migrate, and boot the provider's commands. SQLite is always local.
# PostgreSQL and MySQL are opt-in through explicit connection URLs.

readonly PACKAGE_NAME='@rikology/adonisjs-audit-trail'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PACKAGE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"

E2E_ROOT="${E2E_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/adonisjs-audit-trail-consumer.XXXXXX")}"
KEEP_WORKSPACE=false
DRY_RUN=false
BUILD_PACKAGE=true
declare -a REQUESTED_DIALECTS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/e2e-configure.sh [options]

Builds and packs this package once, then verifies fresh, strict AdonisJS consumers.

Options:
  --dialect NAME       sqlite, postgres, mysql, or all (repeatable; default: sqlite)
  --all                Equivalent to --dialect all
  --no-build           Reuse an existing build before packing
  --keep               Preserve the generated consumer workspace
  --dry-run            Validate the plan without network, Docker, or package commands
  -h, --help           Show this help

External dialects are explicit and never provisioned implicitly:
  E2E_POSTGRES_URL     PostgreSQL connection URL used for the postgres consumer
  E2E_MYSQL_URL        MySQL connection URL used for the mysql consumer
  E2E_REQUIRE_DIALECTS=1  Fail instead of skipping an external dialect with no URL
  MySQL migrations need CREATE TRIGGER/function privileges, or log_bin_trust_function_creators=1.

Examples:
  npm run e2e:consumer
  E2E_POSTGRES_URL=postgres://audit:audit@localhost:5432/audit \
    bash scripts/e2e-configure.sh --dialect postgres
EOF
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

info() {
  printf '==> %s\n' "$*"
}

cleanup() {
  if [[ "$KEEP_WORKSPACE" != true ]]; then
    rm -rf -- "$E2E_ROOT"
  else
    printf 'Preserved consumer workspace: %s\n' "$E2E_ROOT"
  fi
}

run() {
  if [[ "$DRY_RUN" == true ]]; then
    printf '[dry run]'
    printf ' %q' "$@"
    printf '\n'
    return
  fi

  "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command is unavailable: $1"
}

append_dialect() {
  local dialect="$1"
  case "$dialect" in
    sqlite|postgres|mysql)
      REQUESTED_DIALECTS+=("$dialect")
      ;;
    all)
      REQUESTED_DIALECTS+=(sqlite postgres mysql)
      ;;
    *)
      fail "Unsupported dialect '$dialect'. Expected sqlite, postgres, mysql, or all."
      ;;
  esac
}

unique_dialects() {
  local dialect
  local selected=' '
  declare -a unique=()

  for dialect in "${REQUESTED_DIALECTS[@]}"; do
    if [[ "$selected" != *" $dialect "* ]]; then
      unique+=("$dialect")
      selected+="$dialect "
    fi
  done

  REQUESTED_DIALECTS=("${unique[@]}")
}

external_url_for() {
  case "$1" in
    postgres) printf '%s' "${E2E_POSTGRES_URL:-}" ;;
    mysql) printf '%s' "${E2E_MYSQL_URL:-}" ;;
    *) fail "No external URL is required for dialect '$1'" ;;
  esac
}

assert_file() {
  [[ -f "$1" ]] || fail "Configure did not generate required artifact: $1"
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Eq -- "$pattern" "$file" || fail "Expected '$file' to contain: $pattern"
}

assert_single_migration() {
  local consumer_dir="$1"
  local suffix="$2"
  local -a matches=()

  shopt -s nullglob
  matches=("$consumer_dir"/database/migrations/*_"$suffix".ts)
  shopt -u nullglob

  [[ ${#matches[@]} -eq 1 ]] || fail "Expected exactly one generated ${suffix} migration; found ${#matches[@]}"
}

write_database_config() {
  local consumer_dir="$1"
  local dialect="$2"
  local database_url="${3:-}"
  local client

  case "$dialect" in
    sqlite)
      cat > "$consumer_dir/config/database.ts" <<'EOF'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'

export default defineConfig({
  connection: 'primary',
  connections: {
    primary: {
      client: 'better-sqlite3',
      connection: { filename: app.makePath('tmp/consumer.sqlite') },
      useNullAsDefault: true,
    },
    audit: {
      client: 'better-sqlite3',
      connection: { filename: app.makePath('tmp/consumer.sqlite') },
      useNullAsDefault: true,
    },
  },
})
EOF
      ;;
    postgres)
      cat > "$consumer_dir/config/database.ts" <<'EOF'
import { defineConfig } from '@adonisjs/lucid'

const databaseUrl = process.env.E2E_DATABASE_URL
if (!databaseUrl) {
  throw new Error('E2E_DATABASE_URL is required for the postgres consumer')
}

export default defineConfig({
  connection: 'primary',
  connections: {
    primary: { client: 'pg', connection: databaseUrl },
    audit: { client: 'pg', connection: databaseUrl },
  },
})
EOF
      ;;
    mysql)
      cat > "$consumer_dir/config/database.ts" <<'EOF'
import { defineConfig } from '@adonisjs/lucid'

const value = process.env.E2E_DATABASE_URL
if (!value) {
  throw new Error('E2E_DATABASE_URL is required for the mysql consumer')
}
const databaseUrl = new URL(value)
const connection = {
  host: databaseUrl.hostname,
  port: databaseUrl.port ? Number(databaseUrl.port) : 3306,
  user: decodeURIComponent(databaseUrl.username),
  password: decodeURIComponent(databaseUrl.password),
  database: databaseUrl.pathname.slice(1),
}

export default defineConfig({
  connection: 'primary',
  connections: {
    primary: { client: 'mysql2', connection },
    audit: { client: 'mysql2', connection },
  },
})
EOF
      ;;
  esac
}

write_public_import_fixture() {
  local consumer_dir="$1"

  cat > "$consumer_dir/app/audit-trail-consumer.ts" <<'EOF'
import { defineConfig, stores, type HttpStoreOptions } from '@rikology/adonisjs-audit-trail'
import type {
  AuditOutboxConfig,
  AuditQuery,
  AuditReadOptions,
  AuditableModelInstance,
} from '@rikology/adonisjs-audit-trail'
import { Auditable } from '@rikology/adonisjs-audit-trail/auditable'
import Audit from '@rikology/adonisjs-audit-trail/models/audit'

export const config = defineConfig({
  default: 'lucid',
  stores: {
    lucid: stores.lucid({ connection: 'audit', table: 'audit_log' }),
  },
})

export const outbox: AuditOutboxConfig = {
  connection: 'primary',
  table: 'audit_outbox',
  maxAttempts: 5,
  retryDelayMs: 0,
  staleClaimMs: 300_000,
}

export const read: AuditReadOptions = { connection: 'audit' }
export const http: HttpStoreOptions = {
  url: 'https://audit.example.test/events',
  maxRetainedPerStream: 100,
}

export type ConsumerAuditQuery = AuditQuery
export type ConsumerAuditableModel = AuditableModelInstance
export const consumerArtifacts = { Auditable, Audit }
EOF
}
write_outbox_consumer_command() {
  local consumer_dir="$1"

  mkdir -p "$consumer_dir/commands"
  cat > "$consumer_dir/commands/audit_outbox_consumer_smoke.ts" <<'EOF'
import { BaseCommand } from '@adonisjs/core/ace'

type OutboxIntent = {
  id: unknown
  payload: unknown
  status: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parsePayload(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function payloadEventId(value: unknown): unknown {
  const payload = parsePayload(value)
  return isRecord(payload?.event) ? payload.event.id : undefined
}

function isUuidV7(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
}

export default class AuditOutboxConsumerSmoke extends BaseCommand {
  static commandName = 'audit:outbox-consumer-smoke'
  static description = 'Assert transactional outbox rows are application-identified'
  static options = { startApp: true as const }

  async run() {
    const audit = await this.app.container.make('audit')
    const db = await this.app.container.make('lucid.db')
    const event = await audit.assemble({
      event: 'consumer.outbox.smoke',
      metadata: { source: 'packed-consumer-harness' },
    })

    await db.transaction(async (transaction) => {
      await audit.submit(event, { transaction })
    })

    const pending = (await db
      .from('audit_outbox')
      .select(['id', 'payload', 'status'])
      .where('status', 'pending')) as OutboxIntent[]
    const matching = pending.filter((intent) => payloadEventId(intent.payload) === event.id)

    if (matching.length !== 1) {
      throw new Error(
        `Expected exactly one pending outbox intent for event ${event.id}, found ${matching.length}`
      )
    }

    const intent = matching[0]!
    if (intent.status !== 'pending') {
      throw new Error(`Expected pending outbox intent status, found ${String(intent.status)}`)
    }
    if (!isUuidV7(intent.id)) {
      throw new Error(`Expected outbox row id to be a UUIDv7, found ${String(intent.id)}`)
    }
    if (intent.id === event.id) {
      throw new Error('Outbox row id must be distinct from its payload event id')
    }

    this.logger.success(`Validated pending outbox intent ${intent.id}`)
  }
}
EOF
}


assert_configured_artifacts() {
  local consumer_dir="$1"
  local config_file="$consumer_dir/config/audit.ts"

  assert_file "$config_file"
  assert_file "$consumer_dir/app/transformers/audit_transformer.ts"
  assert_file "$consumer_dir/start/audit_events.ts"
  assert_file "$consumer_dir/adonisrc.ts"
  assert_single_migration "$consumer_dir" 'create_audits_table'
  assert_single_migration "$consumer_dir" 'create_audit_outbox_table'

  assert_contains "$config_file" "connection: ['\"]audit['\"]"
  assert_contains "$config_file" "table: ['\"]audit_log['\"]"
  assert_contains "$config_file" "guarantee: ['\"]transactional-outbox['\"]"
  assert_contains "$config_file" "outbox"
  assert_contains "$config_file" "connection: ['\"]primary['\"]"
  assert_contains "$config_file" "table: ['\"]audit_outbox['\"]"
  assert_contains "$consumer_dir/adonisrc.ts" "$PACKAGE_NAME/audit_provider"
  assert_contains "$consumer_dir/adonisrc.ts" "$PACKAGE_NAME/commands"
}

assert_packed_docs() {
  local tarball="$1"
  local listing
  listing="$(tar -tzf "$tarball")"

  [[ "$listing" == *'package/docs/README.md'* ]] || fail 'Packed tarball is missing docs/README.md'
  [[ "$listing" == *'package/docs/configuration.md'* ]] || fail 'Packed tarball is missing docs/configuration.md'
}

configure_consumer() {
  local dialect="$1"
  local tarball="$2"
  local database_url="${3:-}"
  local consumer_dir="$E2E_ROOT/$dialect"
  local -a install_args=(npm install "$tarball")

  info "Scaffolding $dialect consumer"
  run npx --yes create-adonisjs@latest "$consumer_dir" --kit=api --pkg=npm
  [[ "$DRY_RUN" == true ]] && return

  if [[ "$dialect" == postgres ]]; then
    install_args+=(pg)
  elif [[ "$dialect" == mysql ]]; then
    install_args+=(mysql2)
  fi

  (
    cd "$consumer_dir"
    "${install_args[@]}"
  )

  write_database_config "$consumer_dir" "$dialect" "$database_url"
  write_public_import_fixture "$consumer_dir"

  info "Configuring strict $dialect artifacts"
  (
    cd "$consumer_dir"
    node ace configure "$PACKAGE_NAME" \
      --outbox \
      --multi-tenant=false \
      --immutability \
      --audit-connection=audit \
      --audit-table=audit_log \
      --outbox-connection=primary \
      --outbox-table=audit_outbox
  )

  assert_configured_artifacts "$consumer_dir"
  write_outbox_consumer_command "$consumer_dir"


  info "Compiling public API and generated configuration for $dialect"
  (
    cd "$consumer_dir"
    npm run typecheck
  )

  info "Migrating and booting provider commands for $dialect"
  (
    cd "$consumer_dir"
    if ! E2E_DATABASE_URL="$database_url" node ace migration:run; then
      if [[ "$dialect" == mysql ]]; then
        fail 'MySQL consumer migrations require a privileged database account for immutability triggers, or log_bin_trust_function_creators=1.'
      fi
      exit 1
    fi
    E2E_DATABASE_URL="$database_url" node ace audit:outbox-consumer-smoke
    E2E_DATABASE_URL="$database_url" node ace audit:replay-outbox
    E2E_DATABASE_URL="$database_url" node ace audit:stats
    E2E_DATABASE_URL="$database_url" node ace audit:verify --json
  )
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dialect)
      [[ $# -ge 2 ]] || fail '--dialect requires a value'
      append_dialect "$2"
      shift 2
      ;;
    --dialect=*)
      append_dialect "${1#*=}"
      shift
      ;;
    --all)
      append_dialect all
      shift
      ;;
    --no-build)
      BUILD_PACKAGE=false
      shift
      ;;
    --keep)
      KEEP_WORKSPACE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

if [[ ${#REQUESTED_DIALECTS[@]} -eq 0 ]]; then
  REQUESTED_DIALECTS=(sqlite)
fi
unique_dialects

if [[ "$DRY_RUN" == false ]]; then
  require_command npm
  require_command npx
  require_command node
  require_command tar
fi

if [[ "$DRY_RUN" == false ]]; then
  trap cleanup EXIT
fi

info "Consumer harness dialects: ${REQUESTED_DIALECTS[*]}"
if [[ "$DRY_RUN" == true ]]; then
  for dialect in "${REQUESTED_DIALECTS[@]}"; do
    dialect_env="$(printf '%s' "$dialect" | tr '[:lower:]' '[:upper:]')"
    if [[ "$dialect" != sqlite && -z "$(external_url_for "$dialect")" ]]; then
      if [[ "${E2E_REQUIRE_DIALECTS:-0}" == 1 ]]; then
        fail "${dialect} was requested but E2E_${dialect_env}_URL is not set"
      fi
      info "Skipping $dialect: explicit E2E_${dialect_env}_URL is not set"
      continue
    fi
    info "Would configure, compile, migrate, and boot $dialect consumer"
  done
  exit 0
fi

mkdir -p "$E2E_ROOT/pack"
if [[ "$BUILD_PACKAGE" == true ]]; then
  info 'Building package once'
  (
    cd "$PACKAGE_DIR"
    npm run build
  )
fi

info 'Packing package once'
tarball="$(cd "$PACKAGE_DIR" && npm pack --pack-destination "$E2E_ROOT/pack" --json | node -e 'let data=""; process.stdin.on("data", (chunk) => (data += chunk)); process.stdin.on("end", () => { const packed = JSON.parse(data); if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== "string") process.exit(1); process.stdout.write(packed[0].filename) })')"
tarball="$E2E_ROOT/pack/$tarball"
[[ -f "$tarball" ]] || fail "npm pack did not produce its reported tarball: $tarball"
assert_packed_docs "$tarball"

for dialect in "${REQUESTED_DIALECTS[@]}"; do
  dialect_env="$(printf '%s' "$dialect" | tr '[:lower:]' '[:upper:]')"
  database_url=''
  if [[ "$dialect" != sqlite ]]; then
    database_url="$(external_url_for "$dialect")"
    if [[ -z "$database_url" ]]; then
      if [[ "${E2E_REQUIRE_DIALECTS:-0}" == 1 ]]; then
        fail "$dialect was requested but E2E_${dialect_env}_URL is not set"
      fi
      info "Skipping $dialect: set E2E_${dialect_env}_URL to opt in"
      continue
    fi
  fi

  configure_consumer "$dialect" "$tarball" "$database_url"
done

info 'Packed consumer harness passed'
