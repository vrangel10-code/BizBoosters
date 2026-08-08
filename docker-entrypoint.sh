#!/bin/sh
set -e

# Apply pending migrations before serving.
#
# `migrate deploy` is idempotent and takes a Postgres advisory lock, so several
# instances starting at once is safe — one applies, the others wait and find
# nothing to do. It is forward-only and never resets, so it cannot destroy data
# the way `migrate dev` can.
if [ -n "$DATABASE_URL" ]; then
  echo "Applying database migrations..."
  ./node_modules/prisma/build/index.js migrate deploy
else
  echo "DATABASE_URL is not set — refusing to start." >&2
  exit 1
fi

exec "$@"
