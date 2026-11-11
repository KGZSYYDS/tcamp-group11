@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 深大日历 - 本机 + 公网
echo.
echo  正在启动，请稍等（第一次会慢一点）...
echo.
node scripts\online.mjs
echo.
echo  已退出。按任意键关闭窗口。
pause >nul
