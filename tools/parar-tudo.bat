@echo off
chcp 65001 >nul
title Robo das Ofertas - parar tudo
REM Para a API, o worker e o painel (node) e depois desliga o PostgreSQL portatil (pedido do usuario em 2026-10-30).
REM Antes o menu so parava o node e o banco ficava ligado; para desligar a maquina com tudo fechado era preciso
REM rodar tools\postgres.bat stop a parte.
call "%~dp0parar.bat" semaviso
echo.
echo Desligando o PostgreSQL...
call "%~dp0postgres.bat" stop
if errorlevel 1 (
  echo   O desligamento normal nao terminou; encerrando os processos do PostgreSQL deste projeto...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$bin = [IO.Path]::GetFullPath('%~dp0..\..\pgsql\bin'); Get-CimInstance Win32_Process -Filter \"Name='postgres.exe'\" | Where-Object { ($_.CommandLine -replace '/','\') -like ('*' + $bin + '*') } | ForEach-Object { Write-Host ('  parando ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
)
echo.
echo Pronto. Tudo parado: API, worker, painel e PostgreSQL.
timeout /t 4 >nul
