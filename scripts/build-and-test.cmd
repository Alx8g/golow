@echo off
setlocal
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT (
  echo Visual Studio C++ Build Tools were not found.
  exit /b 1
)
call "%VSROOT%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b %errorlevel%
cargo fmt --all -- --check
if errorlevel 1 exit /b %errorlevel%
cargo test --locked
if errorlevel 1 exit /b %errorlevel%
cargo clippy --locked --all-targets -- -D warnings
if errorlevel 1 exit /b %errorlevel%
cargo build --locked --release
exit /b %errorlevel%
