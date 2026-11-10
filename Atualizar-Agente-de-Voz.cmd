@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Atualizando o Agente de Voz...
git pull --ff-only
call npm install --no-audit --no-fund
echo.
echo Pronto. Feche e abra o painel de novo para usar a versao nova.
pause