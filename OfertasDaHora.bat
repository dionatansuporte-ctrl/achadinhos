@echo off
chcp 65001 >nul
setlocal
title OfertasDaHora
set "T=%~dp0tools"

REM Atalhos por argumento (para atalhos do Windows, agendador ou arrastar um .zip):
REM   OfertasDaHora.bat iniciar | parar | backup | restaurar | mercadolivre | autostart
REM   OfertasDaHora.bat "C:\caminho\backup.zip"   -> restaura esse backup
if /i "%~1"=="iniciar"      call "%T%\iniciar.bat" & goto :eof
if /i "%~1"=="parar"        call "%T%\parar.bat" & goto :eof
if /i "%~1"=="backup"       call "%T%\backup.bat" & goto :eof
if /i "%~1"=="restaurar"    call "%T%\restaurar.bat" & goto :eof
if /i "%~1"=="mercadolivre" call "%T%\conectar-mercadolivre.bat" & goto :eof
if /i "%~1"=="autostart"    call "%T%\instalar-inicio-automatico.bat" & goto :eof
if /i "%~x1"==".zip"        call "%T%\restaurar.bat" "%~1" & goto :eof

:menu
cls
echo.
echo   ==========================================
echo      OfertasDaHora
echo   ==========================================
echo.
echo     1  Iniciar tudo (PostgreSQL, API, worker, painel)
echo     2  Parar API, worker e painel
echo     3  Fazer backup agora
echo     4  Restaurar um backup
echo     5  Conectar Mercado Livre (tunel para o OAuth)
echo     6  Ligar / desligar inicio automatico com o Windows
echo.
echo     0  Sair
echo.
set "OP="
set /p "OP=  Escolha uma opcao: "
if "%OP%"=="1" call "%T%\iniciar.bat" & goto menu
if "%OP%"=="2" call "%T%\parar.bat" & goto menu
if "%OP%"=="3" call "%T%\backup.bat" & goto menu
if "%OP%"=="4" call "%T%\restaurar.bat" & goto menu
if "%OP%"=="5" call "%T%\conectar-mercadolivre.bat" & goto menu
if "%OP%"=="6" call "%T%\instalar-inicio-automatico.bat" & goto menu
if "%OP%"=="0" goto :eof
goto menu
