#!/bin/sh
# Runs once, on the first start of an empty Postgres data directory.
#
# One database and one role per service. Each role:
#  - owns only its own database, and cannot connect to the others;
#  - is NOT a superuser and does NOT bypass row-level security (NOBYPASSRLS), so
#    the tenant-isolation policies bind the service's own connections;
#  - can create tables in its own database (it runs that service's migrations).
# Passwords come from the container environment; the defaults are for local use only.
set -eu

create_service_db() {
  svc="$1"
  pass="$2"
  psql -v ON_ERROR_STOP=1 -v svc="$svc" -v pass="$pass" --username "$POSTGRES_USER" --dbname postgres <<'SQL'
CREATE ROLE :"svc" LOGIN PASSWORD :'pass'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE DATABASE :"svc" OWNER :"svc";
REVOKE ALL ON DATABASE :"svc" FROM PUBLIC;
SQL
}

create_service_db identity   "${IDENTITY_DB_PASSWORD:-identity-dev}"
create_service_db engagement "${ENGAGEMENT_DB_PASSWORD:-engagement-dev}"
create_service_db payments   "${PAYMENTS_DB_PASSWORD:-payments-dev}"
