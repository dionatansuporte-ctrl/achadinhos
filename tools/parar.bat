@echo off
chcp 65001 >nul
title Robo das Ofertas - parar
echo Parando API, worker e painel do Robo das Ofertas...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*achadinhopro-final*' } | ForEach-Object { Write-Host ('  parando ' + $_.ProcessId); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
REM "semaviso": chamado pelo parar-tudo.bat, que desliga o banco em seguida.
if /i "%~1"=="semaviso" goto :eof
echo.
echo Pronto. O PostgreSQL continua ligado. Para parar tudo, inclusive o banco: opcao 8 do menu.
timeout /t 4 >nul
