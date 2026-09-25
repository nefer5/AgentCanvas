$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tools = Join-Path $root '.tools'
$compiler = Join-Path $tools 'inno\ISCC.exe'
if (Test-Path $compiler) { Write-Output $compiler; exit 0 }
New-Item -ItemType Directory -Path $tools -Force | Out-Null
$download = Join-Path $tools 'innosetup-6.7.3.exe'
Invoke-WebRequest 'https://github.com/jrsoftware/issrc/releases/download/is-6_7_3/innosetup-6.7.3.exe' -OutFile $download
$signature = Get-AuthenticodeSignature $download
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Pyrsys B.V.') { throw 'Invalid Inno Setup publisher signature' }
$destination = Join-Path $tools 'inno'
$proc = Start-Process -FilePath $download -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER','/PORTABLE=1','/NOICONS','/TASKS=',('/DIR="'+$destination+'"')) -WindowStyle Hidden -Wait -PassThru
if ($proc.ExitCode -ne 0 -or -not(Test-Path $compiler)) { throw 'Inno Setup portable installation failed' }
Write-Output $compiler
