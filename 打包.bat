@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 正在关闭程序...
taskkill /IM "老郑荡的妙妙小工具.exe" /F >nul 2>nul
timeout /t 2 >nul

echo.
node tools\pack.mjs
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo [x] 打包失败，别启动，先看上面的红字
  pause
  exit /b %RC%
)

echo 启动程序...
start "" "build\老郑荡的妙妙小工具\老郑荡的妙妙小工具.exe"
timeout /t 3 >nul
pause
