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

REM Com a API parada o Windows solta a DLL do Prisma: aproveita para atualizar o cliente do banco
REM (necessario depois de atualizar o sistema; sem mudanca no banco e rapido e nao faz mal).
echo Atualizando o cliente do banco (Prisma)...
pushd apps\api
call npx prisma generate >> ..\..\logs\migrate.log 2>&1
if errorlevel 1 (echo   AVISO: prisma generate falhou, veja logs\migrate.log. Seguindo mesmo assim.) else (echo   ok.)
popd
echo.

call "%~dp0iniciar.bat"
