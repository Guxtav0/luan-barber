@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Luan Barber — Atualizar GitHub e Site Online

set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" scripts\deploy-github.js
pause
