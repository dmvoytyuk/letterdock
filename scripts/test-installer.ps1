# Installer self-test (runs on the GitHub Windows runner, never on a dev machine with Smart App Control).
# 1) silent install; 2) break the old uninstaller; 3) silent install again (as an update would);
# 4) assert it succeeded, the app files were replaced, and the uninstall entry still exists.
# The rename migration (Mailroom -> Letterdock) is tested by scripts/test-migration.ps1.
param([string]$ReleaseDir = 'release')
$ErrorActionPreference = 'Stop'

$setup = Get-ChildItem -Path $ReleaseDir -Filter 'Letterdock-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw "No Letterdock-Setup-*.exe in $ReleaseDir" }
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\letterdock'
$exe = Join-Path $installDir 'Letterdock.exe'
$uninstaller = Join-Path $installDir 'Uninstall Letterdock.exe'
$regKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'

function Stop-App {
  Get-Process -Name 'Letterdock' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
function Install-Silent {
  $p = Start-Process -FilePath $setup.FullName -ArgumentList '/S' -Wait -PassThru
  Stop-App   # the installer starts the app after install
  return $p.ExitCode
}
function Find-UninstallEntry {
  Get-ChildItem $regKey | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like 'Letterdock*' } | Select-Object -First 1
}

Write-Host '== Step 1: fresh silent install'
$code = Install-Silent
if ($code -ne 0) { throw "First install exited with $code" }
foreach ($f in @($exe, $uninstaller)) { if (-not (Test-Path $f)) { throw "Missing after first install: $f" } }

Write-Host '== Step 2: break the old uninstaller and mark the old exe'
# A real program that starts fine but exits with code 5: this is the path where the stock template
# shows an error and quits. (A file that cannot start at all is also handled, but is the easy case.)
$tmp = Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) 'fake-uninstaller'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Set-Content -Path (Join-Path $tmp 'f.cs') -Encoding ascii -Value 'class P { static int Main() { return 5; } }'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $csc /nologo "/out:$tmp\f.exe" "$tmp\f.cs"
if ($LASTEXITCODE -ne 0) { throw 'Could not build the fake uninstaller' }
Copy-Item -Path "$tmp\f.exe" -Destination $uninstaller -Force
$fakeLen = (Get-Item $uninstaller).Length
$marker = [byte[]](1, 2, 3, 4)
[IO.File]::WriteAllBytes($exe, $marker)   # a stale/damaged exe: must be replaced by the update
$staleLen = (Get-Item $exe).Length

Write-Host '== Step 3: silent install over the broken install'
$code = Install-Silent
if ($code -ne 0) { throw "Update install exited with $code (expected 0)" }

Write-Host '== Step 4: assertions'
if (-not (Test-Path $exe)) { throw 'Letterdock.exe missing after update' }
if ((Get-Item $exe).Length -le $staleLen) { throw 'Letterdock.exe was not replaced by the update' }
if ((Get-Item $uninstaller).Length -eq $fakeLen) { throw 'Uninstaller was not rewritten by the new installer' }
$entry = Find-UninstallEntry
if (-not $entry) { throw 'Uninstall registry entry missing' }
if ($entry.UninstallString -notlike '*Uninstall Letterdock.exe*') { throw "Unexpected UninstallString: $($entry.UninstallString)" }
if (-not (Test-Path 'HKCU:\Software\Classes\Letterdock.Url.mailto')) { throw 'mailto registration missing' }
Write-Host 'Installer self-test passed.'
