@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  老郑荡的妙妙小工具 - 源码安装
echo  ================================
echo.
echo  提示：如果你只是想用这个工具，不要装这个。
echo  直接下载成品包，解压双击就能用：
echo  https://github.com/laozhengdang/miaomiao-study/releases/latest
echo.
echo  继续安装需要 Node 22+ 和 Python 3.10+。
echo.
pause
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
pause
