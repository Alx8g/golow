param(
    [string]$BuildPath = (Join-Path $PSScriptRoot 'target\release\soundcloud-go-client.exe'),
    [switch]$Restart,
    [string]$ExpectedCurrentHash
)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\SoundCloudGoPlus'
$exePath = Join-Path $installDir 'soundcloud-go-client.exe'
function Start-InstalledClient {
    # WMI owns this desktop process, independent of an invoking terminal's job object.
    $launch = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine=('"'+$exePath+'"'); CurrentDirectory=$installDir
    }
    if ($launch.ReturnValue -ne 0) { throw ('App launch failed: '+$launch.ReturnValue) }
}
if (-not (Test-Path -LiteralPath $BuildPath)) { throw "Build missing: $BuildPath" }
$sourceHash = (Get-FileHash -LiteralPath $BuildPath -Algorithm SHA256).Hash
$version = (Get-Item -LiteralPath $BuildPath).VersionInfo.FileVersion
if (-not $version) { throw 'Build has no embedded version metadata.' }
if ($ExpectedCurrentHash -and (Test-Path -LiteralPath $exePath)) {
    if ((Get-FileHash -LiteralPath $exePath).Hash -ne $ExpectedCurrentHash) { throw 'Installed app changed since inspection. Installation stopped.' }
}
New-Item -ItemType Directory -Path $installDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$backupDir = Join-Path $installDir "rollback\$stamp"
New-Item -ItemType Directory -Path $backupDir | Out-Null
$staged = Join-Path $backupDir 'new-build.exe'
Copy-Item -LiteralPath $BuildPath -Destination $staged
if ((Get-FileHash -LiteralPath $staged).Hash -ne $sourceHash) { throw 'Staged build hash mismatch.' }
$running = @(Get-Process -Name 'soundcloud-go-client' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exePath })
$wasRunning = $running.Count -gt 0
foreach ($process in $running) {
    if (-not $process.CloseMainWindow()) { throw 'Could not request a graceful close. Close the app and retry.' }
    if (-not $process.WaitForExit(15000)) { throw 'App did not close within 15 seconds. It was not force-killed.' }
}
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SoundCloudGoPlus'
$previousVersion = if (Test-Path $reg) { (Get-ItemProperty $reg).DisplayVersion } else { $null }
$oldHash = if (Test-Path $exePath) { (Get-FileHash $exePath).Hash } else { $null }
[pscustomobject]@{version=$previousVersion;old_hash=$oldHash;new_hash=$sourceHash;installed_at=[DateTimeOffset]::Now.ToString('o')} |
    ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $backupDir 'manifest.json')
if (Test-Path -LiteralPath $exePath) { Move-Item -LiteralPath $exePath -Destination (Join-Path $backupDir 'soundcloud-go-client.exe') }
try {
    Move-Item -LiteralPath $staged -Destination $exePath
    if ((Get-FileHash -LiteralPath $exePath).Hash -ne $sourceHash) { throw 'Installed hash mismatch.' }
} catch {
    if (Test-Path (Join-Path $backupDir 'soundcloud-go-client.exe')) {
        if (Test-Path $exePath) { Move-Item -LiteralPath $exePath -Destination (Join-Path $backupDir 'failed-new-build.exe') }
        Copy-Item (Join-Path $backupDir 'soundcloud-go-client.exe') $exePath
        if ($wasRunning) { Start-InstalledClient }
    }
    throw
}
foreach ($name in @('icon.ico','uninstall.ps1')) {
    $source = if ($name -eq 'icon.ico') { Join-Path $PSScriptRoot 'assets\icon.ico' } else { Join-Path $PSScriptRoot $name }
    if (-not (Test-Path (Join-Path $installDir $name))) { Copy-Item -LiteralPath $source -Destination (Join-Path $installDir $name) }
}
$shell = New-Object -ComObject WScript.Shell
foreach ($shortcut in @((Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\SoundCloud Go+.lnk'),(Join-Path ([Environment]::GetFolderPath('Desktop')) 'SoundCloud Go+.lnk'))) {
    if (-not (Test-Path $shortcut)) {
        $s = $shell.CreateShortcut($shortcut); $s.TargetPath=$exePath; $s.WorkingDirectory=$installDir
        $s.IconLocation=Join-Path $installDir 'icon.ico'; $s.Description='SoundCloud Go+'; $s.Save()
    }
}
New-Item -Path $reg -Force | Out-Null
@{DisplayName='SoundCloud Go+';DisplayVersion=$version;Publisher='Lambiiz';InstallLocation=$installDir;DisplayIcon=(Join-Path $installDir 'icon.ico');UninstallString="powershell.exe -ExecutionPolicy Bypass -File `"$installDir\uninstall.ps1`""}.GetEnumerator() |
    ForEach-Object { Set-ItemProperty -Path $reg -Name $_.Key -Value $_.Value }
Set-ItemProperty -Path $reg -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $reg -Name NoRepair -Value 1 -Type DWord
if ($Restart -or $wasRunning) { Start-InstalledClient }
[pscustomobject]@{Installed=$exePath;Version=$version;Backup=$backupDir;SHA256=$sourceHash;Restarted=($Restart -or $wasRunning)} | ConvertTo-Json
