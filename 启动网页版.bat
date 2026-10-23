@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   课到卡 — 网页版（备用，开发用）
echo   ------------------------------------
start "" http://127.0.0.1:5173
node app\server.mjs
pause
