# Everything down - remove every trace from a DSH profile.
# Does NOT touch other plugins, does NOT run pnpm.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
#        add -PurgeData to also delete %USERPROFILE%\.everything-down
#        (settings, task history, transcripts)

param(
  [string]$Profile,
  [switch]$PurgeData
)

$ErrorActionPreference = 'Stop'

if (-not $Profile) { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
$pkgPath = Join-Path $Profile 'package.json'
if (-not (Test-Path $pkgPath)) { throw "profile package.json not found: $pkgPath" }

Write-Output "profile : $Profile"

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$pkgPath.bak-$stamp"
Copy-Item $pkgPath $backup
Write-Output "backup  : $backup"

$json = [IO.File]::ReadAllText($pkgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json

if ($json.dependencies -and $json.dependencies.PSObject.Properties['dsh-everything-down']) {
  $json.dependencies.PSObject.Properties.Remove('dsh-everything-down')
  Write-Output 'removed : dependencies.dsh-everything-down'
}

if ($json.dsh -and $json.dsh.profile -and $json.dsh.profile.bundles) {
  $bundles = @($json.dsh.profile.bundles) | Where-Object { $_ -ne 'dsh-everything-down' }
  $json.dsh.profile.bundles = @($bundles)
  Write-Output 'removed : dsh.profile.bundles entry'
}

$out = $json | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText($pkgPath, $out, (New-Object Text.UTF8Encoding($false)))

$target = Join-Path $Profile 'node_modules\dsh-everything-down'
if (Test-Path $target) {
  cmd /c rmdir "$target" | Out-Null
  Write-Output "unlinked: $target"
}

if ($PurgeData) {
  $data = Join-Path $env:USERPROFILE '.everything-down'
  if (Test-Path $data) {
    Remove-Item $data -Recurse -Force
    Write-Output "purged  : $data"
  }
}

Write-Output ''
Write-Output 'DONE. Restart the DSH client.'
