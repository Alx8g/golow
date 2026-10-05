# Removes GoLow's install folder, shortcuts and uninstall entry. Sign-in data in %APPDATA% is kept.
$dir = $PSScriptRoot
Get-Process golow -ErrorAction SilentlyContinue | Where-Object Path -eq "$dir\golow.exe" | ForEach-Object { [void]$_.CloseMainWindow(); [void]$_.WaitForExit(15000) }
Remove-Item -Force -ErrorAction SilentlyContinue "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\GoLow.lnk", "$([Environment]::GetFolderPath('Desktop'))\GoLow.lnk"
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\GoLow'
# This script runs from the folder it deletes, so remove the folder after it exits.
Start-Process cmd.exe "/c timeout /t 2 /nobreak >nul & rmdir /s /q `"$dir`"" -WindowStyle Hidden
'Uninstalled GoLow. Sign-in data was kept.'
