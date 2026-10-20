@echo off
chcp 65001 >nul
cd /d "%~dp0"

set OUT=build\老郑荡的妙妙小工具
set APPDIR=%OUT%\resources\app

if not exist "%OUT%\老郑荡的妙妙小工具.exe" (
  echo [x] 没找到 %OUT%\老郑荡的妙妙小工具.exe
  echo     先把 electron 的 dist 放到这个目录里。
  pause
  exit /b 1
)

echo [1/5] 关闭正在运行的程序...
taskkill /IM "老郑荡的妙妙小工具.exe" /F >nul 2>nul
timeout /t 2 >nul

echo [2/5] 复制程序代码...
if exist "%APPDIR%" rmdir /s /q "%APPDIR%"
mkdir "%APPDIR%"
robocopy app "%APPDIR%\app" /E /NFL /NDL /NJH /NJS /NP >nul
robocopy tools "%APPDIR%\tools" /E /NFL /NDL /NJH /NJS /NP >nul
copy /y package.json "%APPDIR%\package.json" >nul

echo [3/5] 复制内置 Python 运行环境...
if not exist "runtime\python\python.exe" (
  echo [!] 没有 runtime\python，导入功能会要求系统装 Python。
  echo     想打包进去：把 Python 嵌入式版解压到 runtime\python，再装 pymupdf。
) else (
  robocopy runtime "%APPDIR%\runtime" /E /NFL /NDL /NJH /NJS /NP >nul
)

echo [4/5] 准备数据目录...
if not exist "%OUT%\data\db" mkdir "%OUT%\data\db"

echo [5/5] 启动...
start "" "%OUT%\老郑荡的妙妙小工具.exe"
echo.
echo 打包完成。给别人时，整个 "%OUT%" 文件夹拷过去就行。
pause
