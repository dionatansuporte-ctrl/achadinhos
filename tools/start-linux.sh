#!/usr/bin/env bash
set -e

docker compose up -d
(cd apps/api && npm install && npx prisma generate && npx prisma migrate dev --name init)

echo 'Abra dois terminais:'
echo '1) cd apps/api && npm run dev'
echo '2) cd apps/api && npm run worker'
echo '3) cd apps/web && npm install && npm run dev'
