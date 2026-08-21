@echo off
rem DeepSeek Harness desktop shell - build installer
rem Double-click this file to build the .exe installer into the "dist" folder.
cd /d "%~dp0"

rem Enable the upload privacy guard (pre-commit / pre-push git hooks).
rem core.hooksPath is a per-clone local setting and cannot travel with the
rem repo, so dist.bat re-enables it automatically after a fresh clone.
where git >nul 2>nul
if errorlevel 1 (
  echo [guard] Git not found; privacy hooks will NOT be enabled on this machine.
) else (
  git rev-parse --git-dir >nul 2>nul
  if errorlevel 1 (
    echo [guard] not a git repository; privacy hooks skipped. Clone the repo to enable them.
  ) else (
    if exist ".githooks\pre-commit" (
      git config core.hooksPath .githooks
      echo [guard] privacy hooks enabled: .githooks
      if exist ".githooks\private-rules.example.txt" (
        if not exist ".githooks\private-rules.txt" (
          echo [guard] tip: copy .githooks\private-rules.example.txt to .githooks\private-rules.txt to enable personal path/e-mail warnings
        )
      )
    ) else (
      echo [guard] .githooks missing; privacy hooks skipped.
    )
  )
)

rem Packaging requires Node.js (electron-builder runs on Node/npm).
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js not found. Packaging requires Node.js and npm.
  echo Install Node.js LTS from https://nodejs.org/ and run this script again.
  pause
  exit /b 1
)

rem Optional: uncomment the line below if GitHub downloads are too slow.
rem set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo [1/5] Checking installed app runtime vs bundled runtime...
for /f "delims=" %%i in ('node runtime-refresh-check.js') do set NEED_REFRESH=%%i
if "%NEED_REFRESH%"=="REFRESH" (
    echo Installed runtime is newer or bundled one is missing - mirroring installed runtime into dsh-runtime...
    robocopy "%APPDATA%\dsh-windows-desktop\dsh-runtime" "dsh-runtime" /MIR /XF __test-worker.cjs /NFL /NDL /NJH /NP
    if errorlevel 8 (
        echo ERROR: robocopy failed.
        pause
        exit /b 1
    )
    if exist "dsh-runtime\__test-worker.cjs" del /q "dsh-runtime\__test-worker.cjs"
) else (
    echo Bundled runtime is up to date.
)

echo [2/5] Syncing app version to the bundled dsh version...
if not exist "dsh-runtime\node_modules\@deepseek-ai\dsh\package.json" goto skip_version_sync
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('dsh-runtime/node_modules/@deepseek-ai/dsh/package.json','utf8')).version;const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.version!==d){p.version=d;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log('app version -> '+d)}else{console.log('app version already '+d)}"
if errorlevel 1 goto version_sync_failed
echo Version sync OK.
goto version_synced
:skip_version_sync
echo Skipping version sync: dsh-runtime not prepared yet (see check below).
goto version_synced
:version_sync_failed
echo ERROR: failed to sync version.
pause
exit /b 1
:version_synced

echo [3/5] Checking bundled dsh runtime...
if not exist "dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js" (
    echo ERROR: dsh-runtime is missing. See README.md "build-from-source" section.
    echo Hint: the desktop app is installed and updated? Just re-run dist.bat -
    echo it auto-mirrors the installed runtime. Or run refresh-runtime.bat first.
    pause
    exit /b 1
)

echo [4/5] Checking electron-builder...
if not exist "node_modules\.bin\electron-builder.cmd" (
    echo Installing electron-builder...
    call npm.cmd install --save-dev electron-builder --no-audit --no-fund
    if errorlevel 1 (
        echo ERROR: failed to install electron-builder.
        pause
        exit /b 1
    )
)

echo [5/5] Building installer...
call npm.cmd run dist
if errorlevel 1 (
    echo ERROR: build failed. See output above.
    pause
    exit /b 1
)

echo.
echo Done. The installer is in the "dist" folder.
pause
