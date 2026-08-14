@echo off
rem DeepSeek Harness desktop shell - build installer
rem Double-click this file to build the .exe installer into the "dist" folder.
cd /d "%~dp0"

rem Optional: uncomment the line below if GitHub downloads are too slow.
rem set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

echo [1/4] Syncing app version to the bundled dsh version...
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('dsh-runtime/node_modules/@deepseek-ai/dsh/package.json','utf8')).version;const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.version!==d){p.version=d;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');console.log('app version -> '+d)}else{console.log('app version already '+d)}"
if errorlevel 1 (
    echo ERROR: failed to sync version.
    pause
    exit /b 1
)

echo [2/4] Checking bundled dsh runtime...
if not exist "dsh-runtime\node_modules\@deepseek-ai\dsh\lib\bin.js" (
    echo ERROR: dsh-runtime is missing. See README.md for how to recreate it.
    pause
    exit /b 1
)

echo [3/4] Checking electron-builder...
if not exist "node_modules\.bin\electron-builder.cmd" (
    echo Installing electron-builder...
    call npm.cmd install --save-dev electron-builder --no-audit --no-fund
    if errorlevel 1 (
        echo ERROR: failed to install electron-builder.
        pause
        exit /b 1
    )
)

echo [4/4] Building installer...
call npm.cmd run dist
if errorlevel 1 (
    echo ERROR: build failed. See output above.
    pause
    exit /b 1
)

echo.
echo Done. The installer is in the "dist" folder.
pause
