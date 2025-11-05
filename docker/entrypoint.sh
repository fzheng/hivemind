#!/bin/sh
set -e

echo "[entrypoint] running migrations..."
node /app/scripts/migrate.js up

echo "[entrypoint] starting app..."
exec "$@"

