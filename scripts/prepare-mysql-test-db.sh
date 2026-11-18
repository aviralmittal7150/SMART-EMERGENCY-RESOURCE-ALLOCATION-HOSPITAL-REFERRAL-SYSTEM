#!/usr/bin/env bash
# Create a DISPOSABLE MySQL test database and a restricted user for the automated MySQL tests.
# Used by GitHub Actions (against the job's throwaway MySQL service container) and runnable locally
# against a throwaway server.
#
# Safety:
#  - only talks to a loopback host (127.0.0.1 / localhost): it can never be pointed at a real server
#  - the database name must end in "_test"
#  - the user gets a random password generated here (never stored in the repository) and privileges on
#    that one database only
#  - it FAILS if the database or user already exists; it never drops or overwrites anything
#
# Environment (all optional):
#   MYSQL_ADMIN_HOST      (127.0.0.1)   MYSQL_ADMIN_PORT (3306)   MYSQL_ADMIN_USER (root)
#   MYSQL_ADMIN_PASSWORD  (empty)       admin password; passed to the client via MYSQL_PWD, never on the command line
#   MYSQL_TEST_DB         (emergency_system_test)    MYSQL_TEST_USER (eris_test)    MYSQL_TEST_USER_HOST (%)
#   ENV_OUT               file to append MYSQL_TEST_* lines to (CI passes $GITHUB_ENV); stdout if unset
#   WAIT_SECONDS          (90)          how long to wait for the server to accept connections
set -euo pipefail

HOST="${MYSQL_ADMIN_HOST:-127.0.0.1}"
PORT="${MYSQL_ADMIN_PORT:-3306}"
ADMIN_USER="${MYSQL_ADMIN_USER:-root}"
DB="${MYSQL_TEST_DB:-emergency_system_test}"
TEST_USER="${MYSQL_TEST_USER:-eris_test}"
USER_HOST="${MYSQL_TEST_USER_HOST:-%}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"
export MYSQL_PWD="${MYSQL_ADMIN_PASSWORD:-}"

case "$HOST" in
  127.0.0.1|localhost|::1) ;;
  *) echo "Refusing to run against non-loopback host '$HOST': this script is only for throwaway test servers." >&2; exit 2 ;;
esac
[[ "$DB" =~ _test$ ]] || { echo "Refusing: database name '$DB' must end in _test." >&2; exit 2; }
[[ "$DB" =~ ^[A-Za-z0-9_]+$ && "$TEST_USER" =~ ^[A-Za-z0-9_]+$ ]] || { echo "Refusing: database/user names may contain only letters, digits and underscores." >&2; exit 2; }

mysql_admin() { mysql --protocol=TCP -h "$HOST" -P "$PORT" -u "$ADMIN_USER" "$@"; }

echo "Waiting up to ${WAIT_SECONDS}s for MySQL at ${HOST}:${PORT} ..."
ready=0
for ((i = 0; i < WAIT_SECONDS; i++)); do
  if mysql_admin -N -e 'SELECT 1' >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ $ready -eq 1 ]] || { echo "MySQL did not become ready in ${WAIT_SECONDS}s." >&2; exit 1; }
echo "MySQL is accepting connections (server version: $(mysql_admin -N -e 'SELECT VERSION()'))."

PASSWORD="$(openssl rand -hex 16)"
# Hide the generated password from GitHub Actions logs before it can appear anywhere.
if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then echo "::add-mask::${PASSWORD}"; fi

# The SQL goes through stdin so the password never appears in a process list.
mysql_admin <<SQL
CREATE DATABASE \`${DB}\` CHARACTER SET utf8mb4;
CREATE USER '${TEST_USER}'@'${USER_HOST}' IDENTIFIED BY '${PASSWORD}';
GRANT ALL PRIVILEGES ON \`${DB}\`.* TO '${TEST_USER}'@'${USER_HOST}';
SQL
echo "Created database '${DB}' and user '${TEST_USER}'@'${USER_HOST}' (privileges on that database only)."

emit() {
  printf 'MYSQL_TEST_HOST=%s\nMYSQL_TEST_PORT=%s\nMYSQL_TEST_USER=%s\nMYSQL_TEST_PASS=%s\nMYSQL_TEST_DB=%s\n' \
    "$HOST" "$PORT" "$TEST_USER" "$PASSWORD" "$DB"
}
if [[ -n "${ENV_OUT:-}" ]]; then emit >> "$ENV_OUT"; echo "Connection settings appended to ${ENV_OUT} (password not printed)."; else emit; fi
