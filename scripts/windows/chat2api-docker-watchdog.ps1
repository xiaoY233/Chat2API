[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$ContainerName,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string[]]$HealthUrl,

  [ValidateRange(1, 300)]
  [int]$PollSeconds = 5,

  [ValidateRange(10, 900)]
  [int]$DockerStartTimeoutSeconds = 180,

  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'Chat2API\docker-watchdog.log'),

  [string]$MutexName = 'Local\Chat2API.DockerWatchdog',

  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Expand-ListParameter {
  param([Parameter(Mandatory = $true)][string[]]$Value)

  return @(
    $Value |
      ForEach-Object { $_ -split '[;,]' } |
      ForEach-Object { $_.Trim() } |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  )
}

$ContainerName = Expand-ListParameter -Value $ContainerName
$HealthUrl = Expand-ListParameter -Value $HealthUrl
if ($ContainerName.Count -eq 0 -or $HealthUrl.Count -eq 0) {
  throw 'At least one container name and one health URL are required.'
}

function Write-WatchdogLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  $line = '{0:o} {1}' -f [DateTimeOffset]::Now, $Message
  [Console]::WriteLine($line)

  if ([string]::IsNullOrWhiteSpace($LogPath)) {
    return
  }

  $logDirectory = Split-Path -Parent $LogPath
  if ($logDirectory -and -not (Test-Path -LiteralPath $logDirectory)) {
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Get-DockerCommand {
  $command = Get-Command 'docker.exe' -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  return $command.Source
}

function Test-DockerEngine {
  $docker = Get-DockerCommand
  if ($null -eq $docker) {
    return $false
  }

  try {
    & $docker info --format '{{.ServerVersion}}' *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    # Windows PowerShell can promote a native process' stderr to a terminating
    # error when ErrorActionPreference is Stop. An unavailable engine is an
    # expected health state here, not a watchdog failure.
    return $false
  }
}

function Get-DockerDesktopExecutable {
  $command = Get-Command 'Docker Desktop.exe' -ErrorAction SilentlyContinue
  if ($null -ne $command -and (Test-Path -LiteralPath $command.Source)) {
    return $command.Source
  }

  $registryPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Docker Desktop.exe',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Docker Desktop.exe'
  )
  foreach ($registryPath in $registryPaths) {
    $item = Get-ItemProperty -LiteralPath $registryPath -ErrorAction SilentlyContinue
    if ($null -ne $item) {
      $candidate = $item.'(default)'
      if ($candidate -and (Test-Path -LiteralPath $candidate)) {
        return $candidate
      }
    }
  }

  $commonPath = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path -LiteralPath $commonPath) {
    return $commonPath
  }

  return $null
}

function Start-DockerEngine {
  $executable = Get-DockerDesktopExecutable
  if ($null -eq $executable) {
    Write-WatchdogLog 'Docker Desktop executable was not found.'
    return $false
  }

  Write-WatchdogLog 'Docker engine is unavailable; starting Docker Desktop.'
  Start-Process -FilePath $executable -WindowStyle Hidden | Out-Null

  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  while ($stopwatch.Elapsed.TotalSeconds -lt $DockerStartTimeoutSeconds) {
    if (Test-DockerEngine) {
      Write-WatchdogLog ('Docker engine recovered after {0:n1}s.' -f $stopwatch.Elapsed.TotalSeconds)
      return $true
    }
    Start-Sleep -Seconds 2
  }

  Write-WatchdogLog ('Docker engine did not recover within {0}s.' -f $DockerStartTimeoutSeconds)
  return $false
}

function Test-AllHealthEndpoints {
  foreach ($url in $HealthUrl) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $url -Method Get -TimeoutSec 3
      if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
        return $false
      }
    } catch {
      return $false
    }
  }
  return $true
}

function Ensure-ContainerRunning {
  param([Parameter(Mandatory = $true)][string]$Name)

  $docker = Get-DockerCommand
  if ($null -eq $docker) {
    return $false
  }

  $state = & $docker inspect --format '{{.State.Running}}' -- $Name 2>$null
  if ($LASTEXITCODE -ne 0) {
    Write-WatchdogLog ('Container not found: {0}' -f $Name)
    return $false
  }

  if (($state | Select-Object -First 1).Trim() -eq 'true') {
    return $true
  }

  Write-WatchdogLog ('Starting stopped container: {0}' -f $Name)
  & $docker start -- $Name *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-WatchdogLog ('Failed to start container: {0}' -f $Name)
    return $false
  }
  return $true
}

function Invoke-WatchdogCheck {
  if (Test-AllHealthEndpoints) {
    return
  }

  Write-WatchdogLog 'One or more service health checks failed.'
  if (-not (Test-DockerEngine) -and -not (Start-DockerEngine)) {
    return
  }

  foreach ($name in $ContainerName) {
    Ensure-ContainerRunning -Name $name | Out-Null
  }
}

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
  Write-WatchdogLog ('Another watchdog already owns mutex {0}; exiting.' -f $MutexName)
  $mutex.Dispose()
  exit 0
}

try {
  Write-WatchdogLog ('Watchdog started for {0} container(s) and {1} health endpoint(s).' -f $ContainerName.Count, $HealthUrl.Count)
  do {
    try {
      Invoke-WatchdogCheck
    } catch {
      Write-WatchdogLog ('Watchdog check failed: {0}' -f $_.Exception.Message)
    }

    if (-not $Once) {
      Start-Sleep -Seconds $PollSeconds
    }
  } while (-not $Once)
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
