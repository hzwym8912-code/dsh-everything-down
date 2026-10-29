# 只重启独立的 panel.js 进程。
# 不要按端口杀进程：7788 可能由 DeepSeek Harness 宿主进程持有（插件内启动）。
$ErrorActionPreference = 'SilentlyContinue'
$port = if ($args[0]) { [int]$args[0] } else { 7788 }

$killed = @()
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object {
  $cl = $_.CommandLine
  if ($cl -and $cl -like '*panel.js*' -and $cl -like '*everything-down*') {
    $killed += $_.ProcessId
    Stop-Process -Id $_.ProcessId -Force
  }
}
if ($killed.Count) { Write-Output ("stopped: " + ($killed -join ',')) } else { Write-Output "no standalone panel process" }
Start-Sleep -Seconds 2

$script = Join-Path $PSScriptRoot 'panel.js'
Start-Process -FilePath 'node' -ArgumentList @($script, "$port") -RedirectStandardOutput (Join-Path $PSScriptRoot '..\panel.log') -RedirectStandardError (Join-Path $PSScriptRoot '..\panel.err.log') -WindowStyle Hidden
Start-Sleep -Seconds 3

try {
  $r = Invoke-WebRequest -Uri ("http://127.0.0.1:" + $port + "/api/state") -UseBasicParsing -TimeoutSec 8
  Write-Output ("panel ready: " + $r.StatusCode + " http://127.0.0.1:" + $port)
} catch {
  Write-Output ("panel not ready: " + $_)
}
