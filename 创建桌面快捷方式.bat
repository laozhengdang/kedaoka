@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  课到卡 - 创建桌面快捷方式
echo  ======================================
echo.

if exist "%~dp0课到卡.exe" goto here
if exist "%~dp0build\课到卡\课到卡.exe" goto root

echo  [x] 当前目录没有 课到卡.exe
echo      请把这个 bat 放到程序目录（和 exe 同一个文件夹）再运行。
echo.
pause
exit /b 1

:here
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0make_shortcut.ps1" -ExePath "%~dp0课到卡.exe"
if errorlevel 1 goto fail
goto end

:root
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\make_shortcut.ps1"
if errorlevel 1 goto fail
goto end

:fail
echo.
echo  [x] 创建失败，请把上面的红字发给作者。
echo.
pause
exit /b 1

:end
echo.
pause
