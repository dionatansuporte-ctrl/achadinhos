@echo off
REM OfertasDaHora - controla o PostgreSQL portatil (sem Docker).
REM Uso: postgres.bat start | stop | status | psql
REM O PostgreSQL fica na pasta "pgsql" ao lado da pasta do projeto
REM (ex.: C:\Criar sites\pgsql). Para usar outro lugar, defina a variavel PGSQL_DIR.

setlocal
if not defined PGSQL_DIR (
  for %%I in ("%~dp0..\..\pgsql") do set "PGSQL_DIR=%%~fI"
)
if not exist "%PGSQL_DIR%\bin\pg_ctl.exe" (
  for %%I in ("%~dp0..\pgsql") do set "PGSQL_DIR=%%~fI"
)
if not exist "%PGSQL_DIR%\bin\pg_ctl.exe" (
  echo   ERRO: nao achei o PostgreSQL em "%PGSQL_DIR%\bin".
  echo   Baixe o zip do PostgreSQL e extraia em "C:\Criar sites\pgsql" ^(deve existir pgsql\bin\pg_ctl.exe^).
  exit /b 2
)
set "PGDATA=%PGSQL_DIR%\data"
set "PGBIN=%PGSQL_DIR%\bin"
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
if not exist "%ROOT%\logs" mkdir "%ROOT%\logs"

if /i "%~1"=="stop"   goto stop
if /i "%~1"=="status" goto status
if /i "%~1"=="psql"   goto psql
goto start

:start
if not exist "%PGDATA%\PG_VERSION" (
  echo   Primeira vez: criando o banco em "%PGDATA%"...
  echo postgres> "%TEMP%\ofertasdahora-pgpw.txt"
  "%PGBIN%\initdb.exe" -D "%PGDATA%" -U postgres --pwfile="%TEMP%\ofertasdahora-pgpw.txt" -A scram-sha-256 -E UTF8 --locale=C --locale-provider=icu --icu-locale=pt-BR >> "%ROOT%\logs\postgres.log" 2>&1
  del "%TEMP%\ofertasdahora-pgpw.txt" >nul 2>&1
  if errorlevel 1 (echo   ERRO ao criar o banco. Veja logs\postgres.log & exit /b 1)
  powershell -NoProfile -Command "(Get-Content '%PGDATA%\postgresql.conf') -replace '^#?port = .*','port = 5432' -replace '^#?listen_addresses = .*','listen_addresses = ''localhost''' -replace '^#?logging_collector = .*','logging_collector = on' -replace '^#?log_directory = .*','log_directory = ''log''' | Set-Content '%PGDATA%\postgresql.conf'"
)
"%PGBIN%\pg_isready.exe" -h localhost -p 5432 >nul 2>&1
if not errorlevel 1 (echo   PostgreSQL ja estava ligado. & exit /b 0)
"%PGBIN%\pg_ctl.exe" -D "%PGDATA%" -l "%ROOT%\logs\postgres.log" -w -t 60 start >nul 2>&1
"%PGBIN%\pg_isready.exe" -h localhost -p 5432 >nul 2>&1
if errorlevel 1 (echo   ERRO: o PostgreSQL nao subiu. Veja logs\postgres.log & exit /b 1)
set "PGPASSWORD=postgres"
"%PGBIN%\psql.exe" -h localhost -U postgres -d postgres -Atq -c "SELECT 1 FROM pg_database WHERE datname='achadinhopro'" 2>nul | findstr /x 1 >nul
if errorlevel 1 (
  echo   criando o banco achadinhopro...
  "%PGBIN%\psql.exe" -h localhost -U postgres -d postgres -q -c "CREATE DATABASE achadinhopro" >nul 2>&1
)
echo   PostgreSQL ligado (porta 5432).
exit /b 0

:stop
"%PGBIN%\pg_ctl.exe" -D "%PGDATA%" -m fast -w stop
exit /b %errorlevel%

:status
"%PGBIN%\pg_isready.exe" -h localhost -p 5432
exit /b %errorlevel%

:psql
set "PGPASSWORD=postgres"
"%PGBIN%\psql.exe" -h localhost -U postgres -d achadinhopro
exit /b %errorlevel%
