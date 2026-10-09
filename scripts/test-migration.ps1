# Rename migration self-test (Mailroom -> Letterdock). Runs on the GitHub Windows runner only.
# 1) install the REAL published Mailroom 0.2.9; 2) give it fake user data and a start-at-sign-in entry;
# 3) install this build over it the way electron-updater does (silent, --updated);
# 4) let Letterdock start; it must move the data folder and remove the old app;
# 5) assert the data arrived intact and no trace of the old install is left.
param(
  [string]$ReleaseDir = 'release',
  # The renamed repository keeps the old releases, so the current repo is the right default.
  [string]$OldRepo = $(if ($env:GITHUB_REPOSITORY) { $env:GITHUB_REPOSITORY } else { 'voydapps/letterdock' }),
  [string]$OldTag = 'v0.2.9'
)
$ErrorActionPreference = 'Stop'

$setup = Get-ChildItem -Path $ReleaseDir -Filter 'Letterdock-Setup-*.exe' | Select-Object -First 1
if (-not $setup) { throw "No Letterdock-Setup-*.exe in $ReleaseDir" }
$newInstall = Join-Path $env:LOCALAPPDATA 'Programs\letterdock'
$newExe = Join-Path $newInstall 'Letterdock.exe'
$oldInstall = Join-Path $env:LOCALAPPDATA 'Programs\mailroom'
$oldExe = Join-Path $oldInstall 'Mailroom.exe'
$oldData = Join-Path $env:APPDATA 'Mailroom'
$newData = Join-Path $env:APPDATA 'Letterdock'
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$oldUpdaterCache = Join-Path $env:LOCALAPPDATA 'mailroom-updater'
$work = Join-Path $(if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }) 'migration-test'

function Stop-All {
  foreach ($n in @('Letterdock', 'Mailroom')) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}
function Find-Entry([string]$prefix) {
  Get-ChildItem $uninstallRoot | ForEach-Object { Get-ItemProperty $_.PSPath } |
    Where-Object { $_.DisplayName -like "$prefix*" } | Select-Object -First 1
}
function Wait-Until([scriptblock]$cond, [int]$seconds, [string]$what) {
  $end = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $end) {
    if (& $cond) { return }
    Start-Sleep -Seconds 2
  }
  throw "Timed out after $seconds s waiting for: $what"
}
function Assert($ok, [string]$msg) { if (-not $ok) { throw "ASSERT FAILED: $msg" } }

Write-Host '== Step 1: start clean (remove any Letterdock install and data from an earlier test)'
Stop-All
$un = Join-Path $newInstall 'Uninstall Letterdock.exe'
if (Test-Path $un) {
  Start-Process -FilePath $un -ArgumentList '/S' -Wait | Out-Null
  Wait-Until { -not (Test-Path $newInstall) } 60 'the Letterdock install folder to disappear'
}
Remove-Item -Recurse -Force $newData -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $oldData -ErrorAction SilentlyContinue

Write-Host "== Step 2: download and install the published old app ($OldTag from $OldRepo)"
New-Item -ItemType Directory -Force -Path $work | Out-Null
gh release download $OldTag --repo $OldRepo --pattern 'Mailroom-Setup-*.exe' --dir $work --clobber
if ($LASTEXITCODE -ne 0) { throw 'Could not download the old installer' }
$oldSetup = Get-ChildItem -Path $work -Filter 'Mailroom-Setup-*.exe' | Select-Object -First 1
if (-not $oldSetup) { throw 'Old installer not found after download' }
$p = Start-Process -FilePath $oldSetup.FullName -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "Old installer exited with $($p.ExitCode)" }
Stop-All
if (-not (Test-Path $oldExe)) { throw "Old app missing after install: $oldExe" }
if (-not (Find-Entry 'Mailroom')) { throw 'Old uninstall registry entry missing after install' }

Write-Host '== Step 3: create fake user data, an old start-at-sign-in entry and an old update cache'
Remove-Item -Recurse -Force $oldData -ErrorAction SilentlyContinue   # the old app may have made real files
New-Item -ItemType Directory -Force -Path (Join-Path $oldData 'image-cache'), (Join-Path $oldData 'logs') | Out-Null
Set-Content -Path (Join-Path $oldData 'settings.json') -Encoding ascii -Value '{"app":{"launchAtLogin":true}}'
Set-Content -Path (Join-Path $oldData 'Local State') -Encoding ascii -Value '{"ci_marker":"local-state-keep-me"}'
[IO.File]::WriteAllBytes((Join-Path $oldData 'secrets.bin'), [byte[]](1..64))
Set-Content -Path (Join-Path $oldData 'ci-marker.txt') -Encoding ascii -Value 'keep-me-1234'
Set-Content -Path (Join-Path $oldData 'image-cache\x.bin') -Encoding ascii -Value 'img'
$db = Join-Path $oldData 'mail.db'
$mk = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table ci_marker(v text)'); c.execute(""insert into ci_marker values ('db-keep-me')""); c.commit(); c.close()"
python -c $mk $db
if ($LASTEXITCODE -ne 0) { throw 'Could not create the fake mail.db' }
New-ItemProperty -Path $runKey -Name 'app.mailroom' -Value ('"' + $oldExe + '" --hidden') -PropertyType String -Force | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $oldUpdaterCache 'pending') | Out-Null
Set-Content -Path (Join-Path $oldUpdaterCache 'pending\x.txt') -Value 'stale'

Write-Host '== Step 4: install this build the way the updater does (silent, --updated, --force-run)'
$p = Start-Process -FilePath $setup.FullName -ArgumentList '/S', '--updated', '--force-run' -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "New installer exited with $($p.ExitCode)" }
if (-not (Test-Path $newExe)) { throw 'Letterdock.exe missing after install' }
Start-Sleep -Seconds 5
# The installer starts the app (force-run). Start it ourselves if that did not happen.
if (-not (Get-Process -Name 'Letterdock' -ErrorAction SilentlyContinue)) { Start-Process -FilePath $newExe }

Write-Host '== Step 5: wait for the migration and for the removal of the old app'
Wait-Until { Test-Path (Join-Path $newData 'migrated-from-mailroom.json') } 90 'the migration marker'
Wait-Until { -not (Test-Path $oldInstall) } 150 'the old install folder to be removed'
Wait-Until { Test-Path (Join-Path $newData 'legacy-install-removed.json') } 60 'the cleanup marker'
Stop-All

Write-Host '== Step 6: assertions'
Assert (-not (Test-Path $oldData)) 'old data folder still exists'
foreach ($f in @('settings.json', 'Local State', 'ci-marker.txt', 'mail.db', 'image-cache\x.bin')) {
  Assert (Test-Path (Join-Path $newData $f)) "missing in new data folder: $f"
}
Assert ((Get-Content (Join-Path $newData 'ci-marker.txt') -Raw).Trim() -eq 'keep-me-1234') 'ci-marker.txt content changed'
Assert ((Get-Content (Join-Path $newData 'Local State') -Raw) -match 'local-state-keep-me') 'Local State content changed'
# The app moves an unreadable secrets.bin to secrets.bin.corrupt (it is fake here), so accept both.
Assert ((Test-Path (Join-Path $newData 'secrets.bin')) -or (Test-Path (Join-Path $newData 'secrets.bin.corrupt'))) 'secrets.bin lost'
$sel = "import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute('select v from ci_marker').fetchone()[0])"
$v = python -c $sel (Join-Path $newData 'mail.db')
Assert ($v -eq 'db-keep-me') "mail.db content lost (got '$v')"
$m = Get-Content (Join-Path $newData 'migrated-from-mailroom.json') -Raw | ConvertFrom-Json
Assert ($m.method -eq 'renamed') "unexpected migration method: $($m.method)"

Assert (-not (Test-Path $oldInstall)) 'old install folder still exists'
Assert (-not (Find-Entry 'Mailroom')) 'old uninstall registry entry still exists'
Assert ($null -eq (Get-ItemProperty -Path $runKey -Name 'app.mailroom' -ErrorAction SilentlyContinue)) 'old Run entry still exists'
Assert (-not (Test-Path 'HKCU:\Software\Classes\Mailroom.Url.mailto')) 'old mailto registration still exists'
Assert (-not (Test-Path 'HKCU:\Software\Mailroom')) 'old Software\Mailroom key still exists'
Assert (-not (Test-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Mailroom.lnk'))) 'old Start menu shortcut still exists'
Assert (-not (Test-Path $oldUpdaterCache)) 'old updater cache still exists'

Assert (Test-Path $newExe) 'Letterdock.exe missing at the end'
# "Start at sign-in" was on in the old settings: the new app must have registered itself again.
$runValues = (Get-ItemProperty -Path $runKey).PSObject.Properties | Where-Object { "$($_.Value)" -like '*ProgramsletterdockLetterdock.exe*' }
Assert ($null -ne $runValues) 'start-at-sign-in was not re-applied for Letterdock'
Assert (Test-Path (Join-Path $env:APPDATA 'MicrosoftWindowsStart MenuProgramsLetterdock.lnk')) 'Letterdock Start menu shortcut missing'
$entry = Find-Entry 'Letterdock'
Assert ($null -ne $entry) 'new uninstall registry entry missing'
Assert ($entry.UninstallString -like '*Uninstall Letterdock.exe*') "unexpected UninstallString: $($entry.UninstallString)"
Assert (Test-Path 'HKCU:\Software\Classes\Letterdock.Url.mailto') 'new mailto registration missing'
Write-Host 'Migration self-test passed.'
