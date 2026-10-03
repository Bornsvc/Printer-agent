@echo off
rem Double-click to install / repair the print agent (pm2 service, auto-start on boot).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-agent.ps1"
