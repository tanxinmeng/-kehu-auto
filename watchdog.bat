@echo off
chcp 65001 >nul
rem 看门狗：探测 8766 掉线才拉起（由计划任务每 5 分钟经 watchdog.vbs 静默调用）
cd /d %~dp0
curl -s --max-time 5 http://localhost:8766/api/status >nul 2>&1
if %errorlevel%==0 exit /b 0
echo [%date% %time%] 8766 探测失败，自动拉起 >> "%~dp0data\watchdog.log"
start "kehu-auto" /min node src/server.js
