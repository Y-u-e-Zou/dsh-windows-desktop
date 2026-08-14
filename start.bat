@echo off
rem DeepSeek Harness desktop shell - launcher
rem Double-click this file (or run it from cmd) to start the Electron shell.
rem This bypasses the PowerShell execution-policy issue entirely.
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" .
