@echo off
cd /d "%~dp0"
echo Pasta atual: %cd%
if not exist package.json (
  echo ERRO: package.json nao esta nesta pasta. Coloque o iniciar.bat junto com server.js e package.json.
  pause
  exit /b
)
if not exist node_modules (
  echo Instalando dependencias, aguarde...
  call npm install
)
echo.
echo Ligando o servidor. Para desligar, feche esta janela ou aperte Ctrl+C.
node server.js
pause
