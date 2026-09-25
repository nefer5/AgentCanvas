param(
    [ValidateSet('Preflight','Install','Uninstall')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallRoot,
    [string]$Version = '0.0.0',
    [string]$UserHome = [Environment]::GetFolderPath('UserProfile'),
    [switch]$WithSkills,
    [switch]$SkipPathUpdate
)
$ErrorActionPreference = 'Stop'
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$markerName = '.agent-canvas-install.json'

function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Stop-OwnedServer {
    $serverPaths = @((Join-Path $InstallRoot 'app\scripts\server.mjs'))
    $legacyRoot = Join-Path $InstallRoot 'versions'
    if (Test-Path $legacyRoot) {
        $serverPaths += @(Get-ChildItem -LiteralPath $legacyRoot -Directory | ForEach-Object {Join-Path $_.FullName 'scripts\server.mjs'})
    }
    foreach ($record in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
        foreach ($serverPath in $serverPaths) {
            $pattern = '(?i)(?:^|\s)"?' + [regex]::Escape($serverPath) + '"?(?:\s|$)'
            if ($record.CommandLine -and [regex]::IsMatch($record.CommandLine, $pattern)) {
                Stop-Process -Id $record.ProcessId -ErrorAction Stop
                Wait-Process -Id $record.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
                if (Get-Process -Id $record.ProcessId -ErrorAction SilentlyContinue) { throw 'Installed server did not stop.' }
            }
        }
    }
}

if ($Action -eq 'Preflight') {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Node.js 20+ is required on PATH. Install Node, then restart Setup. Node is not bundled.' }
    $nodeVersion = (& $node.Source --version).Trim().TrimStart('v')
    if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'20.0.0') { throw 'Node.js 20+ is required.' }
    $installedPackage = Join-Path $InstallRoot 'app\package.json'
    if (Test-Path $installedPackage) {
        $installedVersion = (Get-Content $installedPackage -Raw | ConvertFrom-Json).version
        if ([version]$installedVersion -gt [version]$Version) { throw "Downgrade from $installedVersion to $Version is not supported." }
    }
    Stop-OwnedServer
    exit 0
}

if ($Action -eq 'Uninstall') { Stop-OwnedServer }

if (-not $SkipPathUpdate) {
    $oldPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($oldPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $alreadyPresent = @($parts | Where-Object { $_.TrimEnd('\') -ieq $InstallRoot }).Count -gt 0
    $pathMarker = Join-Path $InstallRoot '.path-added'
    if ($Action -eq 'Install' -and -not $alreadyPresent) {
        [Environment]::SetEnvironmentVariable('Path', ((@($parts) + $InstallRoot) -join ';'), 'User')
        [IO.File]::WriteAllText($pathMarker, 'AgentCanvas')
    } elseif ($Action -eq 'Uninstall' -and (Test-Path $pathMarker)) {
        [Environment]::SetEnvironmentVariable('Path', (($parts | Where-Object {$_.TrimEnd('\') -ine $InstallRoot}) -join ';'), 'User')
    }
}

$skillRoots = @('.agents\skills', '.codex\skills', '.claude\skills', '.gemini\skills', '.config\opencode\skills')
foreach ($relativeRoot in $skillRoots) {
    $root = Join-Path $UserHome $relativeRoot
    $target = Join-Path $root 'agent-canvas'
    $marker = Join-Path $target $markerName
    $skillFile = Join-Path $target 'SKILL.md'
    $owned = $false
    if (Test-Path $marker) {
        $metadata = Get-Content $marker -Raw | ConvertFrom-Json
        $owned = $metadata.installer -eq 'AgentCanvas' -and $metadata.installRoot -eq $InstallRoot
        if ($owned -and (Test-Path $skillFile)) {
            $owned = $metadata.sha256 -eq (Get-Sha256 $skillFile)
        }
    }
    if ($Action -eq 'Install' -and $WithSkills) {
        if ((Test-Path $target) -and -not $owned) {
            Write-Warning "Existing or modified skill preserved: $target"
            continue
        }
        if ($relativeRoot -ne '.agents\skills' -and -not (Test-Path $root)) { continue }
        New-Item -ItemType Directory -Path $target -Force | Out-Null
        Copy-Item (Join-Path $InstallRoot 'skills\agent-canvas\SKILL.md') $skillFile -Force
        @{installer='AgentCanvas'; installRoot=$InstallRoot; version=$Version; sha256=(Get-Sha256 $skillFile)} |
            ConvertTo-Json | Set-Content $marker -Encoding UTF8
    } elseif ($Action -eq 'Uninstall' -and $owned) {
        # Preserve any extra user files; recycle only the two files we own.
        Add-Type -AssemblyName Microsoft.VisualBasic
        foreach ($file in @($skillFile, $marker)) {
            if (Test-Path $file) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($file, 'OnlyErrorDialogs', 'SendToRecycleBin') }
        }
    }
}
