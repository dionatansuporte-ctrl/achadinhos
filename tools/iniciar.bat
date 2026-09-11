@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title OfertasDaHora - iniciar tudo
cd /d "%~dp0.."
if not exist logs mkdir logs

echo ==========================================================
echo   OfertasDaHora - subindo o projeto completo
echo ==========================================================
echo.

REM ---------- 1) Docker Desktop ----------
echo [1/5] Docker Desktop...
docker info >nul 2>&1
if not errorlevel 1 goto docker_ok

set "DD=%LOCALAPPDATA%\Programs\DockerDesktop\frontend\Docker Desktop.exe"
if not exist "%DD%" set "DD=%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
if not exist "%DD%" (
  echo   ERRO: nao achei o Docker Desktop instalado. Abra ele manualmente e rode este arquivo de novo.
  pause
  exit /b 1
)
echo   abrindo o Docker Desktop, aguarde...
start "" "%DD%"
set /a tentativas=0
:espera_docker
ping -n 6 127.0.0.1 >nul
docker info >nul 2>&1
if not errorlevel 1 goto docker_ok
set /a tentativas+=1
if !tentativas! geq 36 (
  echo   ERRO: o Docker nao ficou pronto em 3 minutos. Veja se ele abriu e rode de novo.
  pause
  exit /b 1
)
echo   ainda iniciando... (!tentativas!/36)
goto espera_docker
:docker_ok
echo   Docker pronto.

REM ---------- 2) Banco e Redis ----------
echo [2/5] PostgreSQL e Redis...
docker compose up -d >> logs\docker.log 2>&1
if errorlevel 1 (
  echo   ERRO ao subir os containers. Veja logs\docker.log
  pause
  exit /b 1
)
set /a tentativas=0
:espera_pg
docker compose exec -T postgres pg_isready -U postgres >nul 2>&1
if not errorlevel 1 goto pg_ok
set /a tentativas+=1
if !tentativas! geq 30 (
  echo   ERRO: o PostgreSQL nao respondeu em 60 segundos.
  pause
  exit /b 1
)
ping -n 3 127.0.0.1 >nul
goto espera_pg
:pg_ok
echo   banco pronto.

REM ---------- 3) Migracoes pendentes (seguro: so aplica o que falta) ----------
echo [3/5] Migracoes do banco...
pushd apps\api
call npx prisma migrate deploy >> ..\..\logs\migrate.log 2>&1
if errorlevel 1 (
  echo   AVISO: migracao falhou, veja logs\migrate.log. Seguindo mesmo assim.
) else (
  echo   banco atualizado.
)
popd

REM ---------- 4) API, worker e painel ----------
echo [4/5] API, worker e painel...
call :ja_rodando
if "!RODANDO!"=="1" (
  echo   ja estao rodando, nao vou subir de novo.
  goto abrir
)
start "OfertasDaHora - API"    /min cmd /k "chcp 65001 >nul && cd /d "%~dp0..\apps\api" && npm run dev"
start "OfertasDaHora - Worker" /min cmd /k "chcp 65001 >nul && cd /d "%~dp0..\apps\api" && npm run worker"
start "OfertasDaHora - Painel" /min cmd /k "chcp 65001 >nul && cd /d "%~dp0..\apps\web" && npm run dev"
echo   iniciados em janelas minimizadas (barra de tarefas).

REM ---------- 5) Espera a API responder e abre o navegador ----------
:abrir
echo [5/5] Aguardando a API responder...
set /a tentativas=0
:espera_api
ping -n 3 127.0.0.1 >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://localhost:3333/health'; exit 0 } catch { if ($_.Exception.Response) { exit 0 } else { exit 1 } }" >nul 2>&1
if not errorlevel 1 goto api_ok
set /a tentativas+=1
if !tentativas! geq 45 (
  echo   a API demorou mais de 90 segundos.
  if "!RODANDO!"=="1" (echo   Ela ja estava rodando antes e nao responde: use OfertasDaHora.bat opcao Parar e depois Iniciar de novo.) else (echo   Veja a janela "OfertasDaHora - API" na barra de tarefas.)
  goto fim
)
goto espera_api
:api_ok
echo   API no ar.
start "" "http://localhost:5173"

:fim
echo.
echo ==========================================================
echo   Pronto. Painel: http://localhost:5173
echo   Para parar tudo: OfertasDaHora.bat, opcao Parar
echo ==========================================================
ping -n 11 127.0.0.1 >nul
exit /b 0

REM ---------- funcao: verifica se a API ja esta rodando ----------
:ja_rodando
set "RODANDO=0"
powershell -NoProfile -Command "exit ((Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*achadinhopro-final*' -and $_.CommandLine -like '*server.ts*' } | Measure-Object).Count)"
if errorlevel 1 set "RODANDO=1"
exit /b 0
