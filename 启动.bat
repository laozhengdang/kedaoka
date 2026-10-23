@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   课到卡 — 桌面版
echo   ------------------------------------
if not exist "node_modules\electron\dist\electron.exe" (
  echo   还没装依赖，先执行：npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
exit
