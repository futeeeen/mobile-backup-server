@echo off
title Expo App Server - iOS Wi-Fi Photo Backup
cd /d "%~dp0Expo-app"

echo ==================================================
echo 🚀 正在準備啟動 iOS 照片備份手機 APP 伺服器...
echo ==================================================

if not exist node_modules (
    echo [資訊] 偵測到尚未安裝套件，正在自動執行 npm install...
    echo [資訊] 這通常需要 1-2 分鐘，請稍候...
    call npm install
)

echo.
echo [資訊] 正在啟動 Expo 伺服器...
echo [提示] 啟動後，請在 iPhone 開啟 Expo Go 並掃描畫面上顯示的 QR Code 連線。
echo ==================================================
echo.

call npm start

pause
