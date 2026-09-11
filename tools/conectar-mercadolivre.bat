@echo off
chcp 65001 >nul
title OfertasDaHora - Conectar Mercado Livre
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0conectar-mercadolivre.ps1"
