@echo off
title Psych! Launcher
cd /d "%~dp0"
echo ============================================
echo   PSYCH!  -  starting server + public tunnel
echo ============================================
echo.

REM Start the game server in its own window
start "Psych Server" cmd /k node server.js

REM Give the server a moment to boot
timeout /t 2 >nul

REM Start the Cloudflare tunnel in its own window (public HTTPS link appears here)
set "CF=C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist "%CF%" set "CF=C:\Program Files\cloudflared\cloudflared.exe"
start "Psych Public Link" cmd /k ""%CF%" tunnel --url http://localhost:4000"

echo.
echo Two windows opened:
echo   1) Psych Server       - keep it running
echo   2) Psych Public Link  - find your https://XXXX.trycloudflare.com link here
echo.
echo Share that https link with friends anywhere. Close the windows to stop.
echo.
pause
