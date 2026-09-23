@echo off
setlocal
cd /d "%~dp0"

rem Release-Paket: mitgeliefertes, signiertes node.exe. Entwicklung: Node.js aus PATH.
if exist "runtime\node.exe" (
  set "NODE=%~dp0runtime\node.exe"
) else (
  where node >nul 2>nul || (
    echo Node.js wurde nicht gefunden.
    echo Bitte das fertige Release-Paket verwenden oder Node.js installieren: https://nodejs.org
    pause
    exit /b 1
  )
  set "NODE=node"
)

rem Server minimiert starten; er oeffnet das App-Fenster und beendet sich,
rem sobald das Fenster geschlossen wird.
start "Animora" /min "%NODE%" "%~dp0web\server.mjs"
