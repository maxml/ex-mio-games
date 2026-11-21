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
# Passwords come from the container environment; the defaults are for local use only.
set -eu

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
}

create_service_db identity "${IDENTITY_OWNER_DB_PASSWORD:-identity-owner-dev}" "${IDENTITY_APP_DB_PASSWORD:-identity-app-dev}"
create_service_db engagement "${ENGAGEMENT_OWNER_DB_PASSWORD:-engagement-owner-dev}" "${ENGAGEMENT_APP_DB_PASSWORD:-engagement-app-dev}"
create_service_db payments "${PAYMENTS_OWNER_DB_PASSWORD:-payments-owner-dev}" "${PAYMENTS_APP_DB_PASSWORD:-payments-app-dev}"

# A service role has no business in the maintenance databases.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<'SQL'
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL
