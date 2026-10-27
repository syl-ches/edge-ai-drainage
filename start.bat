@echo off
REM Double-click to install everything (first run) and launch the digital twin.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 20+ is required: https://nodejs.org & pause & exit /b 1)
node scripts\start.mjs %*
pause
