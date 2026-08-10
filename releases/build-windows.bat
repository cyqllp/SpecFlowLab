@echo off
REM Build SpecFlowLab for Windows locally.
REM Prerequisites: Node.js 20+, Rust stable (MSVC toolchain), WebView2 runtime.
REM Run this from the repository root.

echo === SpecFlowLab Windows Build ===
echo.

REM 1. Install frontend dependencies
call npm ci
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

REM 2. Run tests
call npm test
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

REM 3. Build Vite frontend + Tauri Windows bundle
call npx tauri build --ci
if %ERRORLEVEL% neq 0 exit /b %ERRORLEVEL%

REM 4. Copy outputs to releases folder
if not exist releases mkdir releases
copy /Y src-tauri\target\release\specflowlab.exe releases\SpecFlowLab-portable.exe
if exist src-tauri\target\release\bundle\msi\*.msi copy /Y src-tauri\target\release\bundle\msi\*.msi releases\
if exist src-tauri\target\release\bundle\nsis\*.exe copy /Y src-tauri\target\release\bundle\nsis\*.exe releases\

echo.
echo === Build complete ===
echo Outputs in releases\:
dir releases\
