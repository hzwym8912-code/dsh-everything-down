# Everything down - install into a DSH profile without touching pnpm.
# Why: 'pnpm add' rewrites the lockfile and parks marketplace-installed
# plugins (not listed in dependencies) under node_modules/.ignored.
# This script only edits package.json and creates one junction.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#        optional: -Profile <profile dir> -Source <plugin source dir>

param(
  [string]$Profile,
  [string]$Source
)

$ErrorActionPreference = 'Stop'

if (-not $Profile) { $Profile = Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }
if (-not $Source) { $Source = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }

Write-Output "profile : $Profile"
Write-Output "source  : $Source"

$pkgPath = Join-Path $Profile 'package.json'
if (-not (Test-Path (Join-Path $Source 'package.json'))) { throw "plugin source is not a package: $Source" }
if (-not (Test-Path $pkgPath)) { throw "profile package.json not found: $pkgPath" }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "$pkgPath.bak-$stamp"
Copy-Item $pkgPath $backup
Write-Output "backup  : $backup"

$json = [IO.File]::ReadAllText($pkgPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if (-not $json.dsh -or -not $json.dsh.profile) { throw "profile package.json has no dsh.profile block" }

$linkPath = 'link:' + ($Source -replace '\\', '/')
if (-not $json.dependencies) {
  $json | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject)
}
$json.dependencies | Add-Member -NotePropertyName 'dsh-everything-down' -NotePropertyValue $linkPath -Force

$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-everything-down') { $bundles += 'dsh-everything-down' }
$json.dsh.profile.bundles = $bundles

$out = $json | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText($pkgPath, $out, (New-Object Text.UTF8Encoding($false)))

$nm = Join-Path $Profile 'node_modules'
New-Item -ItemType Directory -Path $nm -Force | Out-Null
$target = Join-Path $nm 'dsh-everything-down'
if (Test-Path $target) { cmd /c rmdir "$target" | Out-Null }
cmd /c mklink /J "$target" "$Source" | Out-Null
Write-Output "linked  : $target -> $Source"

Write-Output ''
Write-Output 'DONE. Restart the DSH client, then open: Settings -> Everything down.'
