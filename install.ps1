$ErrorActionPreference = "Stop"
$installDir = Join-Path $env:LOCALAPPDATA "Programs\SoundCloudGoPlus"
$exeName = "soundcloud-go-client.exe"
$srcExe = Join-Path $PSScriptRoot "target\release\$exeName"
$srcIcon = Join-Path $PSScriptRoot "assets\icon.ico"

if (-not (Test-Path -LiteralPath $srcExe)) {
    throw "Build output not found: $srcExe (run cargo build --release first)"
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Get-Process -Name "soundcloud-go-client" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Copy-Item -LiteralPath $srcExe -Destination (Join-Path $installDir $exeName) -Force
Copy-Item -LiteralPath $srcIcon -Destination (Join-Path $installDir "icon.ico") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "uninstall.ps1") -Destination (Join-Path $installDir "uninstall.ps1") -Force

$shell = New-Object -ComObject WScript.Shell
$exePath = Join-Path $installDir $exeName
$iconPath = Join-Path $installDir "icon.ico"

$startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\SoundCloud Go+.lnk"
$sc = $shell.CreateShortcut($startMenu)
$sc.TargetPath = $exePath
$sc.WorkingDirectory = $installDir
$sc.IconLocation = $iconPath
$sc.Description = "SoundCloud Go+"
$sc.Save()

$desktop = Join-Path ([Environment]::GetFolderPath("Desktop")) "SoundCloud Go+.lnk"
$sc2 = $shell.CreateShortcut($desktop)
$sc2.TargetPath = $exePath
$sc2.WorkingDirectory = $installDir
$sc2.IconLocation = $iconPath
$sc2.Description = "SoundCloud Go+"
$sc2.Save()

$reg = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SoundCloudGoPlus"
New-Item -Path $reg -Force | Out-Null
Set-ItemProperty -Path $reg -Name "DisplayName" -Value "SoundCloud Go+"
Set-ItemProperty -Path $reg -Name "DisplayVersion" -Value "0.1.0"
Set-ItemProperty -Path $reg -Name "Publisher" -Value "Lambiiz"
Set-ItemProperty -Path $reg -Name "InstallLocation" -Value $installDir
Set-ItemProperty -Path $reg -Name "DisplayIcon" -Value $iconPath
Set-ItemProperty -Path $reg -Name "UninstallString" -Value "powershell.exe -ExecutionPolicy Bypass -File `"$installDir\uninstall.ps1`""
Set-ItemProperty -Path $reg -Name "NoModify" -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name "NoRepair" -Value 1 -Type DWord

Write-Output "installed to $installDir"
