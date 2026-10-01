@echo off
REM Carrega a senha do PostgreSQL (criptografada em apps\api\.db-secret) para quem chamou:
REM PGPASSWORD para o psql e DATABASE_URL para o Prisma CLI. Uso: call "%~dp0db-env.bat"
for /f "usebackq delims=" %%P in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0db-senha.ps1" get`) do set "PGPASSWORD=%%P"
set "DATABASE_URL=postgresql://postgres:%PGPASSWORD%@localhost:5432/achadinhopro"
