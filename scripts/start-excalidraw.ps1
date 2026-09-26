param(
    [switch]$NoBrowser,
    [switch]$Repair,
    [ValidateRange(1, 65535)]
    [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$serverScript = Join-Path $PSScriptRoot 'server.mjs'
$pidFileName = if ($Port -eq 4173) { '.excalidraw-server.pid' } else { ".excalidraw-server-$Port.pid" }
$pidFile = Join-Path $projectRoot $pidFileName
$url = "http://127.0.0.1:$Port"
$healthUrl = "$url/api/health"

function Test-ExcalidrawServer {
    try {
        $response = Invoke-RestMethod -Uri $healthUrl -Method Get -TimeoutSec 1
        if ($null -eq $response `
            -or $response.GetType() -ne [System.Management.Automation.PSCustomObject]) {
            return $false
        }
        return (($response.ok -is [bool]) -and $response.ok)
    }
    catch {
        return $false
    }
}

function Get-LoopbackListenerProcessId {
    $processIds = @(
        Get-NetTCPConnection `
            -LocalAddress '127.0.0.1' `
            -LocalPort $Port `
            -State Listen `
            -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique
    )
    if ($processIds.Count -gt 1) {
        throw "Multiple processes are listening on 127.0.0.1:$Port; refusing to stop any of them."
    }
    if ($processIds.Count -eq 1) {
        return [int]$processIds[0]
    }
    return 0
}

function Get-RecordedProcessId {
    if (-not (Test-Path -LiteralPath $pidFile)) {
        return 0
    }
    $rawProcessId = (Get-Content -LiteralPath $pidFile -Raw).Trim()
    if ($rawProcessId -eq '') {
        return 0
    }
    $recordedProcessId = 0
    if (-not [int]::TryParse($rawProcessId, [ref]$recordedProcessId) -or $recordedProcessId -le 0) {
        throw "Excalidraw Local PID record is invalid; refusing to stop any process."
    }
    return $recordedProcessId
}

function Get-ProcessRecord([int]$ProcessId) {
    return Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Test-IsCurrentProjectServer($ProcessRecord) {
    if ($null -eq $ProcessRecord `
        -or [string]::IsNullOrWhiteSpace($ProcessRecord.ExecutablePath) `
        -or [string]::IsNullOrWhiteSpace($ProcessRecord.CommandLine)) {
        return $false
    }
    if ([IO.Path]::GetFileName($ProcessRecord.ExecutablePath) -ne 'node.exe') {
        return $false
    }
    $executablePattern = [regex]::Escape($ProcessRecord.ExecutablePath)
    $serverPattern = [regex]::Escape($serverScript)
    $portPattern = [regex]::Escape([string]$Port)
    $expectedCommand = "(?i)^\s*`"?$executablePattern`"?\s+`"?$serverPattern`"?\s+--port\s+$portPattern\s*$"
    return [regex]::IsMatch($ProcessRecord.CommandLine, $expectedCommand)
}

function Stop-TrackedStaleServer {
    $listenerProcessId = Get-LoopbackListenerProcessId
    $recordedProcessId = Get-RecordedProcessId
    $recordedProcess = if ($recordedProcessId -gt 0) {
        Get-ProcessRecord $recordedProcessId
    } else {
        $null
    }

    if ($listenerProcessId -gt 0) {
        if ($recordedProcessId -ne $listenerProcessId) {
            throw "127.0.0.1:$Port is owned by an untracked process (PID $listenerProcessId); refusing to stop it."
        }
        if (-not (Test-IsCurrentProjectServer $recordedProcess)) {
            throw "127.0.0.1:$Port is owned by a foreign process (PID $listenerProcessId); refusing to stop it."
        }
    }
    elseif ($null -ne $recordedProcess) {
        if (-not (Test-IsCurrentProjectServer $recordedProcess)) {
            throw "The PID record identifies an unrelated live process (PID $recordedProcessId); refusing to stop it."
        }
    }
    else {
        return
    }

    Stop-Process -Id $recordedProcessId -Force -ErrorAction Stop
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if ($null -eq (Get-ProcessRecord $recordedProcessId)) {
            break
        }
        Start-Sleep -Milliseconds 100
    }
    if ($null -ne (Get-ProcessRecord $recordedProcessId)) {
        throw "Tracked Excalidraw Local server $recordedProcessId did not stop within 5 seconds."
    }
}

$launchMutex = [Threading.Mutex]::new($false, "Local\AgentCanvas-Launcher-$Port")
$ownsLaunchMutex = $false
try {
    try { $ownsLaunchMutex = $launchMutex.WaitOne(30000) }
    catch [Threading.AbandonedMutexException] { $ownsLaunchMutex = $true }
    if (-not $ownsLaunchMutex) { throw 'Another AgentCanvas launch is still running; retry shortly.' }

if ($Repair -or -not (Test-ExcalidrawServer)) {
    if ($Repair) { Stop-TrackedStaleServer }
    elseif ((Get-LoopbackListenerProcessId) -gt 0) {
        throw "Port $Port has an unresponsive or incompatible service. No process was stopped. Inspect active chats before using -Repair."
    }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $serverScriptArgument = if ($serverScript -match '\s') { "`"$serverScript`"" } else { $serverScript }
    $server = Start-Process `
        -FilePath $node `
        -ArgumentList @($serverScriptArgument, '--port', [string]$Port) `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -PassThru

    Set-Content -LiteralPath $pidFile -Value $server.Id -Encoding ascii

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) {
            throw "Excalidraw Local server exited before becoming healthy (exit code $($server.ExitCode))."
        }
        if (Test-ExcalidrawServer) {
            $ready = $true
            break
        }
    }

    if (-not $ready) {
        throw 'Excalidraw Local server did not start within 15 seconds.'
    }
}

if (-not $NoBrowser) {
    Start-Process $url
}

} finally {
    if ($ownsLaunchMutex) { $launchMutex.ReleaseMutex() }
    $launchMutex.Dispose()
}
