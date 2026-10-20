@echo off
rem Double-click to open the workspace app: dashboard, projects, agents and images in one window.
rem It runs tools\workspace-app\start-app.ps1, which starts the app in the background.
rem -ExecutionPolicy Bypass applies to this one PowerShell process only; no policy is changed.
rem -WindowStyle Hidden also hides this console; problems are shown in a dialog.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0tools\workspace-app\start-app.ps1"
