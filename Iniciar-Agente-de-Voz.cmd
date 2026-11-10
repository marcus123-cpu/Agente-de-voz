@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Agente de Voz
powershell -NoProfile -Command "try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',5173);$c.Close();exit 0}catch{exit 1}"
if %errorlevel%==0 (
  echo O painel ja esta rodando. Abrindo no navegador...
  start "" http://localhost:5173
  exit /b
)
echo Iniciando o painel e o servidor. NAO FECHE a janela que vai abrir.
start "Agente de Voz - servidor (nao feche)" cmd /k "npm run dev"
powershell -NoProfile -Command "for($i=0;$i -lt 90;$i++){try{$c=New-Object Net.Sockets.TcpClient;$c.Connect('127.0.0.1',5173);$c.Close();break}catch{Start-Sleep 1}}"
start "" http://localhost:5173
echo.
echo Painel aberto em http://localhost:5173
echo Para abrir o navegador do cVortex (login), use o botao "Abrir perfil cVortex" na aba Conexoes do painel.
timeout /t 6 >nul