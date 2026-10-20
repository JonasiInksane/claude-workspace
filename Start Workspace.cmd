@echo off
rem Double-click to open the workspace launcher (start.ps1).
rem -ExecutionPolicy Bypass applies to this one PowerShell process only; no policy is changed.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
