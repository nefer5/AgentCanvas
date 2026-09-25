$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $projectRoot '.excalidraw-server.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Output 'Excalidraw Local has no recorded server process.'
    exit 0
}

$recordedPid = 0
$rawPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if (-not [int]::TryParse($rawPid, [ref]$recordedPid)) {
    Write-Output 'Excalidraw Local PID record is empty or invalid.'
    exit 0
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $recordedPid" -ErrorAction SilentlyContinue
if ($process) {
    $serverPath = Join-Path $PSScriptRoot 'server.mjs'
    $pattern = '(?i)(?:^|\s)"?' + [regex]::Escape($serverPath) + '"?(?:\s|$)'
    if ($process.Name -ne 'node.exe' -or -not [regex]::IsMatch([string]$process.CommandLine, $pattern)) {
        throw 'PID belongs to another program; refusing to stop it.'
    }
    Stop-Process -Id $recordedPid -Force
    Write-Output "Stopped Excalidraw Local server (PID $recordedPid)."
}
else {
    Write-Output "Recorded Excalidraw Local process $recordedPid is no longer running."
}

Set-Content -LiteralPath $pidFile -Value '' -Encoding ascii
