@echo off
chcp 65001 >nul
cd /d %~dp0
echo 正在打开登录窗口（Edge），请依次登录3个标签页，完成后关闭窗口...
node src/login.js
pause
