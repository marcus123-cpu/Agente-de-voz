@echo off
chcp 65001 >nul
title Instalador - Agente de Voz
echo.
echo  Iniciando o instalador do Agente de Voz...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar.ps1" %*
echo.
pause
