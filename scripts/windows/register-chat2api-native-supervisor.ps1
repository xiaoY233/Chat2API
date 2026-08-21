[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ConfigPath,

  [string]$SupervisorPath = (Join-Path $PSScriptRoot 'chat2api-native-supervisor.ps1'),

  [ValidateNotNullOrEmpty()]
  [string]$TaskName = 'Chat2API Native Supervisor',

  [ValidateRange(1, 300)]
  [int]$PollSeconds = 5,

  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'Chat2API\native\supervisor.log'),

  [switch]$Start,

  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RequiredFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description was not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function ConvertTo-NativeArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  return '"{0}"' -f ($Value -replace '([\\]*)"', '$1$1\"' -replace '(\\+)$', '$1$1')
}

$resolvedConfigPath = Resolve-RequiredFile -Path $ConfigPath -Description 'Native supervisor config'
$resolvedSupervisorPath = Resolve-RequiredFile -Path $SupervisorPath -Description 'Native supervisor script'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask -and -not $Force) {
  throw "Scheduled task already exists: $TaskName. Pass -Force to replace it."
}

$actionArguments = @(
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  $resolvedSupervisorPath,
  '-ConfigPath',
  $resolvedConfigPath,
  '-PollSeconds',
  [string]$PollSeconds,
  '-LogPath',
  [IO.Path]::GetFullPath($LogPath),
  '-MutexName',
  'Local\Chat2API.NativeSupervisor'
) | ForEach-Object { ConvertTo-NativeArgument -Value $_ }

$action = New-ScheduledTaskAction -Execute $powershell -Argument ([string]::Join(' ', $actionArguments))
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name)
$principal = New-ScheduledTaskPrincipal `
  -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
if ($Start) {
  Start-ScheduledTask -TaskName $TaskName
}

$taskInfo = Get-ScheduledTask -TaskName $TaskName
[pscustomobject]@{
  TaskName = $TaskName
  State = $taskInfo.State
  ConfigPath = $resolvedConfigPath
  SupervisorPath = $resolvedSupervisorPath
} | Format-List
