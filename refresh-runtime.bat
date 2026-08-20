@echo off
rem Mirror the ACTIVE runtime (the updated + patched copy the desktop app is
rem running) into the electron source copy, so the next dist.bat ships the
rem current Harness version with all shell patches applied.
rem
rem When to run: after the desktop app's "检查更新" has upgraded the Harness,
rem before you want a freshly built installer to carry that version.
rem Note: dist.bat already does this check automatically before packaging.
cd /d "%~dp0"

set "SRC=%APPDATA%\dsh-windows-desktop\dsh-runtime"
if not exist "%SRC%\node_modules\@deepseek-ai\dsh\lib\bin.js" (
    echo.
    echo [ERROR] No installed runtime found at:
    echo   %SRC%
    echo Run the desktop app once (and use "检查更新" if needed), then retry.
    pause
    exit /b 1
)

echo Mirroring installed runtime into dsh-runtime ...
robocopy "%SRC%" "%~dp0dsh-runtime" /MIR /XF __test-worker.cjs /NFL /NDL /NJH /NP
if %ERRORLEVEL% GEQ 8 (
    echo.
    echo [ERROR] robocopy failed with code %ERRORLEVEL%
    pause
    exit /b 1
)
if exist "%~dp0dsh-runtime\__test-worker.cjs" del /q "%~dp0dsh-runtime\__test-worker.cjs"

echo.
echo Done. dsh-runtime now mirrors the installed runtime.
echo Next: double-click dist.bat to build an installer that ships this version.
pause
