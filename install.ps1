# Installs GoLow for the current user, adds Start menu and desktop shortcuts and an uninstall entry.
param(
    [string]$Exe = $(if (Test-Path "$PSScriptRoot\golow.exe") { "$PSScriptRoot\golow.exe" } else { "$PSScriptRoot\target\release\golow.exe" }),
    [switch]$Restart
)
$ErrorActionPreference = 'Stop'
$dir = Join-Path $env:LOCALAPPDATA 'Programs\GoLow'
$target = Join-Path $dir 'golow.exe'
$version = (Get-Item -LiteralPath $Exe).VersionInfo.FileVersion
if (-not $version) { throw "$Exe has no embedded version. Build it with: cargo build --release" }
# Close a running copy the way its close button would. Never force-kill: that can damage the profile.
$running = @(Get-Process golow -ErrorAction SilentlyContinue | Where-Object Path -eq $target)
foreach ($p in $running) {
    [void]$p.CloseMainWindow()
    if (-not $p.WaitForExit(15000)) { throw 'GoLow did not close within 15 seconds. Close it and retry.' }
}
New-Item -ItemType Directory -Force $dir | Out-Null
# The previous build stays next to the new one, so a bad update can be rolled back by hand.
if (Test-Path $target) { Copy-Item -Force $target "$dir\golow.previous.exe" }
Copy-Item -Force $Exe $target
Copy-Item -Force "$PSScriptRoot\assets\icon.ico", "$PSScriptRoot\uninstall.ps1" $dir
$shell = New-Object -ComObject WScript.Shell
foreach ($link in "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\GoLow.lnk", "$([Environment]::GetFolderPath('Desktop'))\GoLow.lnk") {
    $s = $shell.CreateShortcut($link); $s.TargetPath = $target; $s.WorkingDirectory = $dir; $s.IconLocation = "$dir\icon.ico"; $s.Save()
}
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GoLow'
New-Item -Force $reg | Out-Null
@{ DisplayName = 'GoLow'; DisplayVersion = $version; Publisher = 'GoLow'; InstallLocation = $dir; DisplayIcon = "$dir\icon.ico"; NoModify = 1; NoRepair = 1
   UninstallString = "powershell.exe -ExecutionPolicy Bypass -File `"$dir\uninstall.ps1`"" }.GetEnumerator() | ForEach-Object { Set-ItemProperty $reg $_.Key $_.Value }
# Launch through WMI so the app outlives the terminal (and any job object) that ran this script.
if ($Restart -or $running) { Invoke-CimMethod Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$target`""; CurrentDirectory = $dir } | Out-Null }
"Installed GoLow $version to $dir"
