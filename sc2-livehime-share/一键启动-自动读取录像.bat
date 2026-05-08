@echo off
chcp 65001 >nul
cd /d "%~dp0"
title SC2直播姬统计工具

echo 正在检查运行环境...
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 没有检测到 Node.js。
  echo 请先安装 Node.js LTS：https://nodejs.org/
  echo 安装后重新双击这个文件。
  pause
  exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo 没有检测到 Python。
  echo 请先安装 Python：https://www.python.org/downloads/
  echo 安装时记得勾选 Add python.exe to PATH。
  pause
  exit /b 1
)

echo 正在检查录像解析组件 s2protocol...
python -c "import s2protocol" >nul 2>nul
if errorlevel 1 (
  echo 首次使用需要安装 s2protocol，请稍等...
  python -m pip install --user s2protocol
  if errorlevel 1 (
    echo.
    echo s2protocol 安装失败。请检查网络，或者手动运行：
    echo python -m pip install --user s2protocol
    pause
    exit /b 1
  )
)

echo.
echo 已启动。
echo 直播姬网页源地址：http://127.0.0.1:27392/view
echo 控制台地址：http://127.0.0.1:27392/control
echo.
start "" "http://127.0.0.1:27392/control"
node livehime-stats-server.js
pause
