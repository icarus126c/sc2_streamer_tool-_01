@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$desk=[Environment]::GetFolderPath('Desktop');$target=Join-Path '%~dp0' '一键启动-自动读取录像.bat';$link=Join-Path $desk 'SC2直播姬自动读取录像.lnk';$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut($link);$s.TargetPath=$target;$s.WorkingDirectory='%~dp0';$s.IconLocation='%SystemRoot%\System32\shell32.dll,167';$s.Save()"
echo 已创建桌面快捷方式：SC2直播姬自动读取录像
pause
