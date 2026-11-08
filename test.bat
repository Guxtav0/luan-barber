@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Luan Barber — Testes Automatizados

if exist "%APPDATA%\Antigravity\bin\agy-node.cmd" (
  call "%APPDATA%\Antigravity\bin\agy-node.cmd" --test tests\system.test.js
) else (
  set ELECTRON_RUN_AS_NODE=1
  "%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" --test tests\system.test.js
)
pause
