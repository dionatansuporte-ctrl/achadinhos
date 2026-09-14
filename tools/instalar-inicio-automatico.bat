@echo off
chcp 65001 >nul
title OfertasDaHora - iniciar com o Windows
set "VBS=%~dp0iniciar-oculto.vbs"
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\OfertasDaHora.lnk"
if exist "%LNK%" (
  del "%LNK%"
  echo Inicio automatico REMOVIDO. O OfertasDaHora nao sobe mais sozinho ao ligar o PC.
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%'); $s.TargetPath='wscript.exe'; $s.Arguments='\"%VBS%\"'; $s.WorkingDirectory='%~dp0..'; $s.Description='OfertasDaHora em segundo plano'; $s.Save()"
  echo Inicio automatico INSTALADO. Ao ligar o PC, tudo sobe oculto em segundo plano.
  echo Use a mesma opcao de novo para remover.
)
echo.
echo O PostgreSQL (pasta pgsql) sobe junto. Nao precisa de Docker.
timeout /t 8 >nul
