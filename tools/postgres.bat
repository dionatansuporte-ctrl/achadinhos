@echo off
REM Robo das Ofertas - controla o PostgreSQL portatil (sem Docker).
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
  REM Senha forte gerada agora e guardada criptografada (DPAPI) em apps\api\.db-secret.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0db-senha.ps1" nova > "%TEMP%\ofertasdahora-pgpw.txt"
  "%PGBIN%\initdb.exe" -D "%PGDATA%" -U postgres --pwfile="%TEMP%\ofertasdahora-pgpw.txt" -A scram-sha-256 -E UTF8 --locale=C --locale-provider=icu --icu-locale=pt-BR >> "%ROOT%\logs\postgres.log" 2>&1
  del "%TEMP%\ofertasdahora-pgpw.txt" >nul 2>&1
  if errorlevel 1 (echo   ERRO ao criar o banco. Veja logs\postgres.log & exit /b 1)
  powershell -NoProfile -Command "(Get-Content '%PGDATA%\postgresql.conf') -replace '^#?port = .*','port = 5432' -replace '^#?listen_addresses = .*','listen_addresses = ''localhost''' -replace '^#?logging_collector = .*','logging_collector = on' -replace '^#?log_directory = .*','log_directory = ''log''' | Set-Content '%PGDATA%\postgresql.conf'"
)
"%PGBIN%\pg_isready.exe" -h localhost -p 5432 >nul 2>&1
if not errorlevel 1 (echo   PostgreSQL ja estava ligado. & exit /b 0)
REM Servidor morto, mas com processo filho orfao segurando a porta 5432 e a memoria compartilhada
REM (aconteceu em 2026-09-26: o console do servidor recebeu Ctrl+C no meio de uma consulta e o
REM desligamento travou). Nesse estado o pg_ctl nao sobe de novo. Se o PID do postmaster.pid ja nao
REM existe, encerra os orfaos desta instalacao antes de tentar.
if exist "%PGDATA%\postmaster.pid" powershell -NoProfile -ExecutionPolicy Bypass -Command "$pm = [int](Get-Content '%PGDATA%\postmaster.pid' -TotalCount 1); if (-not (Get-Process -Id $pm -ErrorAction SilentlyContinue)) { Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { ($_.CommandLine -replace '/','\') -like ('*' + '%PGBIN%\postgres.exe' + '*') } | ForEach-Object { Write-Host ('  encerrando processo orfao do PostgreSQL (PID ' + $_.ProcessId + ')'); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1 }"
REM O servidor sobe num console PROPRIO e oculto (Start-Process -WindowStyle Hidden). Antes ele herdava o
REM console de quem chamou (menu, iniciar.bat): Ctrl+C ou fechar aquela janela derrubava uma consulta no
REM meio (0xC000013A) e o banco entrava em recuperacao (2026-09-26 e 2026-10-01). Sem -Wait: com ele trava.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%PGBIN%\pg_ctl.exe' -ArgumentList @('-D','\"%PGDATA%\"','-l','\"%ROOT%\logs\postgres.log\"','start') -WindowStyle Hidden"
set /a TENT=0
:espera
"%PGBIN%\pg_isready.exe" -h localhost -p 5432 >nul 2>&1
if not errorlevel 1 goto pronto
set /a TENT+=1
if %TENT% geq 60 (echo   ERRO: o PostgreSQL nao subiu. Veja logs\postgres.log & exit /b 1)
ping -n 2 127.0.0.1 >nul
goto espera
:pronto
call "%~dp0db-env.bat"
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
call "%~dp0db-env.bat"
"%PGBIN%\psql.exe" -h localhost -U postgres -d achadinhopro
exit /b %errorlevel%
