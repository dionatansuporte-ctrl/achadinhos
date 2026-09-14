@echo off
chcp 65001 >nul
title OfertasDaHora - backup
echo Gerando backup completo (banco, credenciais, sessao do WhatsApp e codigo)...
echo O PostgreSQL precisa estar ligado (OfertasDaHora.bat, opcao Iniciar).
echo.
cd /d "%~dp0..\apps\api"
npx tsx src/scripts/backup.ts
echo.
if errorlevel 1 (echo FALHOU. Veja a mensagem acima.) else (echo Arquivos ficam na pasta backups, dentro do projeto.)
pause
