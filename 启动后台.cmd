@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24，再重新打开此文件。
  pause
  exit /b 1
)
if not exist "node_modules\yaml\package.json" (
  echo 首次使用，请在本目录安装依赖：npm ci
  pause
  exit /b 1
)
echo 后台地址：http://127.0.0.1:4180/
echo 加载完成后将自动在默认浏览器打开后台。关闭此窗口会停止服务。
call npm run build:editor
if errorlevel 1 (
  echo 编辑器构建失败，请运行 npm ci 后重试。
  pause
  exit /b 1
)
node server.mjs --local --open-browser
pause
