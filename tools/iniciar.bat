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

REM ---------- 1) PostgreSQL portatil (pasta pgsql ao lado do projeto) ----------
echo [1/4] PostgreSQL...
call "%~dp0postgres.bat" start
if errorlevel 1 (
  pause
  exit /b 1
)

REM ---------- 2) Migracoes pendentes (seguro: so aplica o que falta) ----------
echo [2/4] Migracoes do banco...
pushd apps\api
call npx prisma migrate deploy >> ..\..\logs\migrate.log 2>&1
if errorlevel 1 (
  echo   AVISO: migracao falhou, veja logs\migrate.log. Seguindo mesmo assim.
) else (
  echo   banco atualizado.
)
popd

REM ---------- 3) API, worker e painel ----------
echo [3/4] API, worker e painel...
call :ja_rodando
if "!RODANDO!"=="1" (
  echo   ja estao rodando, nao vou subir de novo.
  goto abrir
)
start "OfertasDaHora - API"    /min cmd /k "chcp 65001 >nul && cd /d "%~dp0..\apps\api" && npm run dev"
start "OfertasDaHora - Worker" /min cmd /k "chcp 65001 >nul && cd /d "%~dp0..\apps\api" && npm run worker"
start "OfertasDaHora - Painel" /min cmd /k "chcp 65001 >nul && cd /d "%~dp0..\apps\web" && npm run dev"
echo   iniciados em janelas minimizadas (barra de tarefas).

REM ---------- 4) Espera a API responder e abre o navegador ----------
:abrir
echo [4/4] Aguardando a API responder...
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
start "" "http://127.0.0.1:8080"

:fim
echo.
echo ==========================================================
echo   Pronto. Painel: http://127.0.0.1:8080
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
