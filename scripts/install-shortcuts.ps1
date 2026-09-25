$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $PSScriptRoot 'start-excalidraw.ps1'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'

function New-ExcalidrawShortcut([string]$shortcutPath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $powershell
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`""
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = 'Launch the local Excalidraw whiteboard'
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,15"
    $shortcut.Save()
}

$desktopShortcut = Join-Path $desktop 'AgentCanvas.lnk'
$startMenuShortcut = Join-Path $startMenu 'AgentCanvas.lnk'

New-ExcalidrawShortcut $desktopShortcut
New-ExcalidrawShortcut $startMenuShortcut

Write-Output "Created: $desktopShortcut"
Write-Output "Created: $startMenuShortcut"
