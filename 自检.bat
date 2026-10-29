@echo off
chcp 65001 >nul
cd /d "%~dp0"
set MIAOMIAO_DATA=%~dp0data
rem 有些环境会带 ELECTRON_RUN_AS_NODE，导致 exe 被当成 node 跑
set ELECTRON_RUN_AS_NODE=
echo.
echo  课到卡 - 自检
echo  ======================================
echo.
if not exist "课到卡.exe" (
  echo  [x] 这个文件夹里没找到 课到卡.exe
  echo      你是不是把 exe 删了？重新解压一次发布包，
  echo      或者把 课到卡.exe 放回这个文件夹。
  echo.
  pause
  exit /b 1
)
"课到卡.exe" --selfcheck
echo.
echo  报告也存到了 data\reports\ 下面
echo.
pause
