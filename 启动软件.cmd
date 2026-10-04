@echo off
set ELECTRON_RUN_AS_NODE=
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 请先在此目录运行 npm install 和 npm run build。
  pause
  exit /b 1
)
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
