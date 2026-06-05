@echo off
title Expo App Server
cd /d "%~dp0"

echo ==================================================
echo Starting Backup Server...
echo ==================================================
start "" "%~dp0backup-server.exe"

cd Expo-app

echo.
echo ==================================================
echo Starting Expo App Server...
echo ==================================================

if not exist node_modules (
    echo [Info] node_modules not found. Running npm install...
    echo [Info] Please wait, this may take a minute...
    call npm install
)

echo.
echo [Info] Starting Expo...
echo [Info] Once started, scan the QR code with your iPhone Camera to open Expo Go.
echo ==================================================
echo.

call npm start

pause
