@echo off
chcp 65001 >nul
cd /d %~dp0
echo 启动客诉自动化系统（网页，手动同步模式）...
echo 网页: http://localhost:8766  （点"同步并查询"按钮手动拉取源表新数据）
start /b node src/server.js
echo 已启动，关闭本窗口不会停止网页服务。
pause
