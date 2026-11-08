@echo off
cd /d "%~dp0"
title Luan Barber — Servidor Ativo (Mantenha esta janela aberta)

echo ============================================================
echo LUAN BARBER — SERVIDOR INICIADO
echo IMPORTANTE: Mantenha esta janela aberta (ou minimizada)
echo enquanto estiver usando o sistema no navegador!
echo.
echo   Cliente:       http://localhost:3000/
echo   Painel Luan:   http://localhost:3000/admin
echo ============================================================

start "" http://localhost:3000
start "" http://localhost:3000/admin

set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe" src\server.js
pause
