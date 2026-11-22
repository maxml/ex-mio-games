#!/bin/sh
# Runs once, on the first start of an empty Postgres data directory.
#
# One database per service, and TWO roles per database:
#  - <svc>_owner owns the database and, through it, every table. Only
#    `node dist/migrate.js` connects as it (MIGRATION_DATABASE_URL);
#  - <svc>_app is the runtime role (DATABASE_URL). It is NOT the owner, so it can
#    not ALTER a table or switch row-level security off; it can not create
#    objects; it holds exactly the table privileges one migration grants it
#    (`AppRoleGrants`), and nothing else.
# Both roles are NOT superusers and do NOT bypass row-level security (NOBYPASSRLS),
# and can connect to their own database only: PUBLIC loses CONNECT on every
# service database and on `postgres` and `template1` too.
# Passwords come from the container environment and there are NO defaults: a missing
# variable aborts the init (the container stays down) instead of creating a role with a
# well-known password. The local compose file passes its development values explicitly.
# Under Deckhand the six variables are passed inline in the db service `env:` of
# .deckhand/deploy.yml: this script runs as uid postgres, which cannot read the root:root 0640
# secrets file. As a fallback only, a variable that is not set in the environment is read from
# the mounted secrets file (/run/secrets/deckhand_secrets.env, KEY=value lines, hex values)
# when it is readable. Override the path with DECKHAND_SECRETS_FILE.
set -eu

secrets_file="${DECKHAND_SECRETS_FILE:-/run/secrets/deckhand_secrets.env}"

# require_password NAME: prints the value of NAME from the environment, else from the secrets
# file; exits non-zero when it is missing or empty (the caller's assignment aborts under set -e).
require_password() {
  name="$1"
  eval "value=\${$name:-}"
  if [ -z "$value" ] && [ -r "$secrets_file" ]; then
    value="$(sed -n "s/^${name}=//p" "$secrets_file" | tail -n 1)"
  fi
  if [ -z "$value" ]; then
    echo "init.sh: $name is not set (environment or $secrets_file); refusing to create roles without it" >&2
    exit 1
  fi
  printf '%s' "$value"
}

create_service_db() {
  svc="$1"
  owner_pass="$2"
  app_pass="$3"
  psql -v ON_ERROR_STOP=1 -v svc="$svc" -v owner="${svc}_owner" -v app="${svc}_app" \
    -v owner_pass="$owner_pass" -v app_pass="$app_pass" \
    --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE :"owner" LOGIN PASSWORD :'owner_pass'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"app" LOGIN PASSWORD :'app_pass'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE :"svc" OWNER :"owner";
REVOKE ALL ON DATABASE :"svc" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"svc" TO :"app";
SQL
  # Nobody but the owner creates objects in the public schema.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$svc" \
    -c 'REVOKE CREATE ON SCHEMA public FROM PUBLIC'
  # GRANT by a role that holds no grant option is only a WARNING in Postgres, so the
  # app role could still run it and look as if it had succeeded. An event trigger
  # (superuser-only to create) turns that into a hard error for the app role.
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$svc" <<'SQL'
CREATE FUNCTION public.deny_app_role_acl() RETURNS event_trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = current_database() || '_app' THEN
    RAISE EXCEPTION 'permission denied: role % may not run %', current_user, tg_tag;
  END IF;
END $$;
CREATE EVENT TRIGGER deny_app_role_acl ON ddl_command_start
  WHEN TAG IN ('GRANT', 'REVOKE') EXECUTE FUNCTION public.deny_app_role_acl();
SQL
}

# Resolve all six first: a missing one must abort before any role or database exists.
IDENTITY_OWNER_PW="$(require_password IDENTITY_OWNER_DB_PASSWORD)"
IDENTITY_APP_PW="$(require_password IDENTITY_APP_DB_PASSWORD)"
ENGAGEMENT_OWNER_PW="$(require_password ENGAGEMENT_OWNER_DB_PASSWORD)"
ENGAGEMENT_APP_PW="$(require_password ENGAGEMENT_APP_DB_PASSWORD)"
PAYMENTS_OWNER_PW="$(require_password PAYMENTS_OWNER_DB_PASSWORD)"
PAYMENTS_APP_PW="$(require_password PAYMENTS_APP_DB_PASSWORD)"

create_service_db identity "$IDENTITY_OWNER_PW" "$IDENTITY_APP_PW"
create_service_db engagement "$ENGAGEMENT_OWNER_PW" "$ENGAGEMENT_APP_PW"
create_service_db payments "$PAYMENTS_OWNER_PW" "$PAYMENTS_APP_PW"

# A service role has no business in the maintenance databases.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL
