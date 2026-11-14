@echo off
chcp 65001 >nul
title Overleaf MCP Gateway
cd /d "%~dp0"
set "NODE=%~dp0node\node.exe"
if not exist "%NODE%" set "NODE=node"

"%NODE%" "%~dp0launcher.mjs"

rem ---- cleanup: the launcher may have been closed via the window's X, which
rem ---- on Windows does not always run its exit handler. Sweep any leftover
rem ---- gateway process so the next launch does not hit EADDRINUSE.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'mcp-proxy' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" >nul 2>&1

echo.
echo =========================================
echo   Service stopped.
echo   Press any key to close.
echo =========================================
pause >nul
