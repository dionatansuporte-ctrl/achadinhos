@echo off
chcp 65001 >nul
title Robo das Ofertas - reiniciar
cd /d "%~dp0.."
if not exist logs mkdir logs
echo ==========================================================
echo   Robo das Ofertas - reiniciando (para tudo e sobe de novo)
echo ==========================================================
echo.
call "%~dp0parar.bat"

REM Com tudo parado, o iniciar.bat roda o prisma generate sozinho (ele so gera com a API parada).
call "%~dp0iniciar.bat"
