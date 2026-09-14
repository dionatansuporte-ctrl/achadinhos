#!/usr/bin/env bash
set -e

# Precisa de um PostgreSQL local rodando (ex.: sudo apt install postgresql) com o banco
# "achadinhopro" e o DATABASE_URL em apps/api/.env apontando para ele. Não usa Redis nem Docker.
(cd apps/api && npm install && npx prisma generate && npx prisma migrate deploy)

echo 'Abra dois terminais:'
echo '1) cd apps/api && npm run dev'
echo '2) cd apps/api && npm run worker'
echo '3) cd apps/web && npm install && npm run dev'
