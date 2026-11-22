# Postgres for the Deckhand deploy: the stock image plus the init script that creates the
# three service databases and their six roles (see init.sh; it fails closed when a password
# is missing). Build from the repo root:  docker build -f docker/postgres/Dockerfile .
# The init script runs once, on an empty data directory. Local compose keeps the stock image
# and mounts the same script.
FROM postgres:16
COPY docker/postgres/init.sh /docker-entrypoint-initdb.d/10-init.sh
RUN chmod 0755 /docker-entrypoint-initdb.d/10-init.sh
