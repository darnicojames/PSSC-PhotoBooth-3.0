@echo off
chcp 65001 >nul
title PSSC PhotoBooth 3.0 Launcher
color 0A
cls
echo ====================================================================
echo                   PSSC PHOTOBOOTH 3.0
echo ====================================================================
echo.
echo Starting self-hosted server at http://localhost:5000 ...
echo.

:: Launch default web browser to localhost after 2 seconds
start "" http://localhost:5000

echo ====================================================================
echo  [ONLINE] PSSC PhotoBooth 3.0 is ACTIVE at http://localhost:5000
echo  [NOTE] Keep this terminal window open while using the software.
echo ====================================================================
echo.

:: Run Python Flask server (unbuffered mode for instant real-time live terminal streaming)
python -u app.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Python server exited. Attempting auto-recovery...
    python -m pip install -r requirements.txt
    python -u app.py
)

pause
