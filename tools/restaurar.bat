@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title OfertasDaHora - restaurar backup
for %%I in ("%~dp0..") do set "ROOT=%%~fI"

echo ================================================================
echo   OfertasDaHora - RESTAURAR BACKUP
echo ================================================================
echo.
echo  Isto substitui o banco de dados, as credenciais (.env) e a sessao
echo  do WhatsApp desta instalacao pelo conteudo do backup.
echo.

rem --- escolhe o .zip: argumento (arraste o arquivo sobre este .bat) ou o mais novo em backups\
set "ZIP=%~1"
if "%ZIP%"=="" (
  for /f "delims=" %%F in ('dir /b /o-d "%ROOT%\backups\ofertasdahora-*.zip" 2^>nul') do if not defined ZIP set "ZIP=%ROOT%\backups\%%F"
)
if "%ZIP%"=="" (
  echo Nenhum backup encontrado. Arraste o arquivo .zip sobre o OfertasDaHora.bat.
  pause & exit /b 1
)
if not exist "%ZIP%" (echo Arquivo nao encontrado: %ZIP% & pause & exit /b 1)
echo Backup escolhido: %ZIP%
echo.
set /p OK="Digite SIM para continuar: "
if /i not "%OK%"=="SIM" (echo Cancelado. & pause & exit /b 0)

rem --- para os servicos (se estiverem rodando)
echo.
echo [1/6] Parando servicos...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*achadinhopro-final*' -or $_.CommandLine -like '*%ROOT:\=\\%*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

rem --- extrai
echo [2/6] Extraindo...
set "TMPD=%TEMP%\ofertasdahora-restore-%RANDOM%"
mkdir "%TMPD%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%TMPD%' -Force"
if not exist "%TMPD%\db.sql" (echo O zip nao tem db.sql. Backup invalido. & pause & exit /b 1)

rem --- configuracoes e sessao do WhatsApp
echo [3/6] Restaurando credenciais (.env) e sessao do WhatsApp...
if exist "%TMPD%\config\api.env" copy /y "%TMPD%\config\api.env" "%ROOT%\apps\api\.env" >nul
if exist "%TMPD%\config\web.env" copy /y "%TMPD%\config\web.env" "%ROOT%\apps\web\.env" >nul
if exist "%TMPD%\wa-auth" (
  rmdir /s /q "%ROOT%\apps\api\.wa-auth" >nul 2>&1
  xcopy /e /i /q /y "%TMPD%\wa-auth" "%ROOT%\apps\api\.wa-auth" >nul
)

rem --- dependencias (primeira vez em outra maquina)
echo [4/6] Instalando dependencias (pode demorar na primeira vez)...
if not exist "%ROOT%\apps\api\node_modules" (cd /d "%ROOT%\apps\api" && call npm install --no-audit --no-fund)
if not exist "%ROOT%\apps\web\node_modules" (cd /d "%ROOT%\apps\web" && call npm install --no-audit --no-fund)

rem --- banco
echo [5/6] Subindo o Docker e restaurando o banco...
cd /d "%ROOT%"
docker compose up -d
if errorlevel 1 (echo Docker nao respondeu. Abra o Docker Desktop e rode de novo. & pause & exit /b 1)
echo   aguardando o Postgres...
:waitpg
docker compose exec -T postgres pg_isready -U postgres >nul 2>&1
if errorlevel 1 (timeout /t 2 >nul & goto waitpg)
docker compose exec -T postgres psql -U postgres -d achadinhopro -v ON_ERROR_STOP=0 -q < "%TMPD%\db.sql" >nul
if errorlevel 1 (echo   Aviso: o psql reportou erros; confira se o sistema abre normalmente.)
cd /d "%ROOT%\apps\api"
call npx prisma generate >nul
call npx prisma migrate deploy

rem --- limpeza e subida
echo [6/6] Limpando e subindo os servicos...
rmdir /s /q "%TMPD%" >nul 2>&1
cd /d "%ROOT%"
cscript //nologo "%ROOT%\tools\iniciar-oculto.vbs"
echo.
echo ================================================================
echo   Restaurado! Painel: http://localhost:5173
echo   Se o WhatsApp pedir QR de novo, escaneie em Canais.
echo ================================================================
pause
endlocal
