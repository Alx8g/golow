$ErrorActionPreference = "SilentlyContinue"
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Get-Process -Name "soundcloud-go-client" -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1
Remove-Item -LiteralPath (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\SoundCloud Go+.lnk") -Force
Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath("Desktop")) "SoundCloud Go+.lnk") -Force
Remove-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SoundCloudGoPlus" -Recurse -Force
# NOTE: %APPDATA%\soundcloud-go-client (login + window state) is intentionally kept.
Start-Process cmd.exe -ArgumentList "/c timeout /t 2 /nobreak >nul & rmdir /s /q `"$installDir`"" -WindowStyle Hidden
Write-Output "uninstalled (login data kept)"
