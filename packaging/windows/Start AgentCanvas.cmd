@echo off
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0app\scripts\start-excalidraw.ps1"
if errorlevel 1 pause
