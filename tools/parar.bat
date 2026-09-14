@echo off
chcp 65001 >nul
title OfertasDaHora - parar
echo Parando API, worker e painel do OfertasDaHora...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*achadinhopro-final*' } | ForEach-Object { Write-Host ('  parando ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
echo.
echo Pronto. O PostgreSQL continua ligado. Para desligar o banco: tools\postgres.bat stop
timeout /t 4 >nul
