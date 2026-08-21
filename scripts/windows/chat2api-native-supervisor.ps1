[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$ConfigPath,

  [ValidateRange(1, 300)]
  [int]$PollSeconds = 5,

  [string]$LogPath = (Join-Path $env:LOCALAPPDATA 'Chat2API\native\supervisor.log'),

  [string]$MutexName = 'Local\Chat2API.NativeSupervisor',

  [switch]$Once
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:UnhealthySince = @{}
$script:DependencyUnavailable = @{}

function Write-SupervisorLog {
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

function Resolve-RequiredDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Description
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Description was not found: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Get-PlainTextValue {
  param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

  $credential = [PSCredential]::new('environment', $SecureValue)
  return $credential.GetNetworkCredential().Password
}

function Test-ServiceHealth {
  param([Parameter(Mandatory = $true)]$Service)

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Service.HealthUrl -Method Get -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 300
  } catch {
    return $false
  }
}

function Get-OptionalServiceProperty {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][string]$Name,
    $Default = $null
  )

  $property = $Service.PSObject.Properties[$Name]
  if ($null -eq $property -or $null -eq $property.Value) {
    return $Default
  }
  return $property.Value
}

function Get-ServiceEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][string]$Name
  )

  foreach ($entry in @(Get-OptionalServiceProperty -Service $Service -Name 'Environment' -Default @())) {
    if ([string]$entry.Name -ne $Name) {
      continue
    }
    try {
      return Get-PlainTextValue -SecureValue $entry.Value
    } catch {
      Write-SupervisorLog ("Could not read environment value {0} for {1}: {2}" -f $Name, $Service.Name, $_.Exception.Message)
      return $null
    }
  }
  return $null
}

function Get-InferredDependencyHealthUrls {
  param([Parameter(Mandatory = $true)]$Service)

  # A Chat2API process also carries CHAT2API_BASE_URL for optional upstream
  # integrations. Its own listener must not be gated on that value; only a
  # downstream bridge such as LiteLLM (which has no CHAT2API_PORT) needs this
  # backward-compatible inference for schema-1 configs.
  if (-not [string]::IsNullOrWhiteSpace((Get-ServiceEnvironmentValue -Service $Service -Name 'CHAT2API_PORT'))) {
    return @()
  }

  $configuredHealthUrl = Get-ServiceEnvironmentValue -Service $Service -Name 'CHAT2API_HEALTH_URL'
  if (-not [string]::IsNullOrWhiteSpace($configuredHealthUrl)) {
    return @($configuredHealthUrl.TrimEnd('/'))
  }

  # Older native configs did not persist dependency metadata. Infer the
  # Chat2API health endpoint from the generic upstream URL so those configs
  # still stop accepting requests while the target proxy is offline.
  $baseHealthUrl = Get-Chat2ApiBaseHealthUrl -Service $Service
  if ($null -eq $baseHealthUrl) {
    return @()
  }
  return @($baseHealthUrl)
}

function Get-Chat2ApiBaseHealthUrl {
  param([Parameter(Mandatory = $true)]$Service)

  if (-not [string]::IsNullOrWhiteSpace((Get-ServiceEnvironmentValue -Service $Service -Name 'CHAT2API_PORT'))) {
    return $null
  }

  # Derive the target's health endpoint separately from the explicit
  # CHAT2API_HEALTH_URL metadata so a stale base URL cannot pass unnoticed.
  $baseUrl = Get-ServiceEnvironmentValue -Service $Service -Name 'CHAT2API_BASE_URL'
  if ([string]::IsNullOrWhiteSpace($baseUrl)) {
    return $null
  }
  try {
    $uri = [Uri]::new($baseUrl)
    if (-not $uri.IsAbsoluteUri -or [string]::IsNullOrWhiteSpace($uri.Host)) {
      return $null
    }
    $builder = [UriBuilder]::new($uri)
    $builder.Path = '/health'
    return $builder.Uri.AbsoluteUri.TrimEnd('/')
  } catch {
    Write-SupervisorLog ("Ignoring invalid CHAT2API_BASE_URL for {0}: {1}" -f $Service.Name, $_.Exception.Message)
    return $null
  }
}

function Test-ServiceDependencies {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][hashtable]$ServiceMap
  )

  foreach ($dependencyName in @(Get-OptionalServiceProperty -Service $Service -Name 'DependsOn' -Default @())) {
    $dependency = $ServiceMap[[string]$dependencyName]
    if ($null -eq $dependency) {
      throw ("Service {0} declares unknown dependency {1}." -f $Service.Name, $dependencyName)
    }
    if (-not (Test-ServiceHealth -Service $dependency)) {
      return $false
    }
  }

  $declaredDependencies = @(Get-OptionalServiceProperty -Service $Service -Name 'DependsOn' -Default @())
  $baseHealthUrl = Get-Chat2ApiBaseHealthUrl -Service $Service
  if ($declaredDependencies.Count -gt 0 -and $null -ne $baseHealthUrl) {
    $matchesDependency = $false
    foreach ($dependencyName in $declaredDependencies) {
      $dependency = $ServiceMap[[string]$dependencyName]
      if ($null -ne $dependency -and ([string]$dependency.HealthUrl).TrimEnd('/').Equals($baseHealthUrl, [StringComparison]::OrdinalIgnoreCase)) {
        $matchesDependency = $true
        break
      }
    }
    if (-not $matchesDependency) {
      Write-SupervisorLog ("{0} CHAT2API_BASE_URL resolves to {1}, which does not match its declared dependency health URL." -f $Service.Name, $baseHealthUrl)
      return $false
    }
  }

  $dependencyUrls = @(Get-OptionalServiceProperty -Service $Service -Name 'DependencyHealthUrls' -Default @())
  if ($dependencyUrls.Count -eq 0) {
    $dependencyUrls = @(Get-InferredDependencyHealthUrls -Service $Service)
  }
  foreach ($dependencyUrl in $dependencyUrls) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri ([string]$dependencyUrl) -Method Get -TimeoutSec 3
      if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 300) {
        return $false
      }
    } catch {
      return $false
    }
  }

  return $true
}

function Validate-ServiceGraph {
  param([Parameter(Mandatory = $true)]$Services)

  # Service names are identifiers, not user-facing labels. Keep lookups
  # explicitly case-insensitive so a config serialized on another platform
  # cannot make `DependsOn` behave differently from duplicate detection.
  $serviceMap = [System.Collections.Hashtable]::new([System.StringComparer]::OrdinalIgnoreCase)
  $serviceIndexes = [System.Collections.Hashtable]::new([System.StringComparer]::OrdinalIgnoreCase)
  $index = 0
  foreach ($service in @($Services)) {
    $name = [string]$service.Name
    if ([string]::IsNullOrWhiteSpace($name)) {
      throw 'Native supervisor service names cannot be empty.'
    }
    if ($serviceMap.ContainsKey($name)) {
      throw "Native supervisor contains duplicate service name: $name"
    }
    $serviceMap[$name] = $service
    $serviceIndexes[$name] = $index
    $index++
  }

  foreach ($service in @($Services)) {
    $name = [string]$service.Name
    foreach ($dependencyName in @(Get-OptionalServiceProperty -Service $service -Name 'DependsOn' -Default @())) {
      $dependency = [string]$dependencyName
      if (-not $serviceMap.ContainsKey($dependency)) {
        throw ("Service {0} declares unknown dependency {1}." -f $name, $dependency)
      }
      if ($dependency.Equals($name, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Service $name cannot depend on itself."
      }
      if ($serviceIndexes[$dependency] -ge $serviceIndexes[$name]) {
        throw ("Service {0} must appear after its dependency {1}." -f $name, $dependency)
      }
    }
  }

  return $serviceMap
}

function Get-TrackedProcess {
  param([Parameter(Mandatory = $true)]$Service)

  if (-not (Test-Path -LiteralPath $Service.PidPath -PathType Leaf)) {
    return $null
  }

  $rawProcessId = (Get-Content -LiteralPath $Service.PidPath -Raw).Trim()
  $processId = 0
  if (-not [int]::TryParse($rawProcessId, [ref]$processId) -or $processId -le 0) {
    return $null
  }

  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $null
  }

  try {
    $expectedPath = [IO.Path]::GetFullPath([string]$Service.Executable)
    $actualPath = [IO.Path]::GetFullPath($process.Path)
    if (-not $actualPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase)) {
      Write-SupervisorLog ("Ignoring stale PID file for {0}: PID {1} belongs to another executable." -f $Service.Name, $processId)
      return $null
    }
  } catch {
    Write-SupervisorLog ("Could not validate PID {0} for {1}: {2}" -f $processId, $Service.Name, $_.Exception.Message)
    return $null
  }

  return $process
}

function Stop-ManagedService {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [string]$Reason = 'a required dependency is unavailable'
  )

  $process = Get-TrackedProcess -Service $Service
  if ($null -eq $process) {
    return $false
  }

  Write-SupervisorLog ("Stopping {0} with PID {1} because {2}." -f $Service.Name, $process.Id, $Reason)
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Service.PidPath -PathType Leaf) {
    Remove-Item -LiteralPath $Service.PidPath -Force -ErrorAction SilentlyContinue
  }
  return $true
}

function Set-ProcessEnvironment {
  param([Parameter(Mandatory = $true)]$EnvironmentEntries)

  $original = @{}
  foreach ($entry in @($EnvironmentEntries)) {
    $name = [string]$entry.Name
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Invalid environment variable name in native service config: $name"
    }

    $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    $plainText = Get-PlainTextValue -SecureValue $entry.Value
    try {
      [Environment]::SetEnvironmentVariable($name, $plainText, 'Process')
    } finally {
      $plainText = $null
    }
  }
  return $original
}

function Restore-ProcessEnvironment {
  param([Parameter(Mandatory = $true)][hashtable]$Original)

  foreach ($entry in $Original.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
  }
}

function Start-ManagedService {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][hashtable]$ServiceMap
  )

  if (-not (Test-ServiceDependencies -Service $Service -ServiceMap $ServiceMap)) {
    Write-SupervisorLog ("Dependencies for {0} are not healthy; delaying startup." -f $Service.Name)
    return $false
  }

  $executable = Resolve-RequiredFile -Path $Service.Executable -Description ("Executable for {0}" -f $Service.Name)
  $workingDirectory = Resolve-RequiredDirectory -Path $Service.WorkingDirectory -Description ("Working directory for {0}" -f $Service.Name)

  foreach ($outputPath in @($Service.StdOutPath, $Service.StdErrPath, $Service.PidPath)) {
    $parent = Split-Path -Parent $outputPath
    if ($parent -and -not (Test-Path -LiteralPath $parent)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
  }

  $original = Set-ProcessEnvironment -EnvironmentEntries $Service.Environment
  try {
    $process = Start-Process `
      -FilePath $executable `
      -ArgumentList ([string]$Service.CommandLineArguments) `
      -WorkingDirectory $workingDirectory `
      -RedirectStandardOutput $Service.StdOutPath `
      -RedirectStandardError $Service.StdErrPath `
      -WindowStyle Hidden `
      -PassThru
  } finally {
    Restore-ProcessEnvironment -Original $original
  }

  Set-Content -LiteralPath $Service.PidPath -Value $process.Id -Encoding ASCII
  Write-SupervisorLog ("Started {0} with PID {1}." -f $Service.Name, $process.Id)

  $deadline = [DateTime]::UtcNow.AddSeconds([int]$Service.StartTimeoutSeconds)
  do {
    $process.Refresh()
    if ($process.HasExited) {
      Write-SupervisorLog ("{0} exited during startup with code {1}." -f $Service.Name, $process.ExitCode)
      return $false
    }
    if (Test-ServiceHealth -Service $Service) {
      Write-SupervisorLog ("{0} became healthy at {1}." -f $Service.Name, $Service.HealthUrl)
      return $true
    }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  Write-SupervisorLog ("{0} did not become healthy within {1}s." -f $Service.Name, $Service.StartTimeoutSeconds)
  return $false
}

function Ensure-ManagedService {
  param(
    [Parameter(Mandatory = $true)]$Service,
    [Parameter(Mandatory = $true)][hashtable]$ServiceMap
  )

  $name = [string]$Service.Name
  $dependenciesHealthy = Test-ServiceDependencies -Service $Service -ServiceMap $ServiceMap
  if (-not $dependenciesHealthy) {
    Stop-ManagedService -Service $Service -Reason 'a required dependency is unavailable' | Out-Null
    if (-not $script:DependencyUnavailable.ContainsKey($name)) {
      Write-SupervisorLog ("Dependency health for {0} is failing; keeping the process gated." -f $name)
      $script:DependencyUnavailable[$name] = $true
    }
    return $false
  }
  if ($script:DependencyUnavailable.ContainsKey($name)) {
    Write-SupervisorLog ("Dependency health for {0} recovered." -f $name)
    $script:DependencyUnavailable.Remove($name)
  }

  if (Test-ServiceHealth -Service $Service) {
    $script:UnhealthySince.Remove($name)
    return $true
  }

  $process = Get-TrackedProcess -Service $Service
  if ($null -eq $process) {
    $script:UnhealthySince.Remove($name)
    return Start-ManagedService -Service $Service -ServiceMap $ServiceMap
  }

  if (-not $script:UnhealthySince.ContainsKey($name)) {
    $script:UnhealthySince[$name] = [DateTime]::UtcNow
    Write-SupervisorLog ("{0} is running with PID {1}, but its health check is failing." -f $name, $process.Id)
    return $false
  }

  $unhealthySeconds = ([DateTime]::UtcNow - $script:UnhealthySince[$name]).TotalSeconds
  if ($unhealthySeconds -lt [int]$Service.RestartAfterSeconds) {
    return $false
  }

  Write-SupervisorLog ("Restarting unhealthy service {0} after {1:n1}s." -f $name, $unhealthySeconds)
  Stop-ManagedService -Service $Service -Reason 'its health check remained unhealthy' | Out-Null
  Start-Sleep -Seconds 1
  $script:UnhealthySince.Remove($name)
  return Start-ManagedService -Service $Service -ServiceMap $ServiceMap
}

function Invoke-SupervisorCheck {
  param([Parameter(Mandatory = $true)]$Services)

  $serviceMap = Validate-ServiceGraph -Services $Services
  foreach ($service in @($Services)) {
    # Evaluate every service on every pass. A downstream process that is
    # already running must be stopped when its dependency fails; skipping it
    # here would leave a stale LiteLLM listener accepting doomed requests.
    Ensure-ManagedService -Service $service -ServiceMap $serviceMap | Out-Null
  }
}

$resolvedConfigPath = Resolve-RequiredFile -Path $ConfigPath -Description 'Native supervisor config'
$config = Import-Clixml -LiteralPath $resolvedConfigPath
if ([int]$config.SchemaVersion -notin @(1, 2)) {
  throw "Unsupported native supervisor config schema: $($config.SchemaVersion)"
}
$services = @($config.Services)
if ($services.Count -eq 0) {
  throw 'Native supervisor config does not contain any services.'
}

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, $MutexName, [ref]$createdNew)
if (-not $createdNew) {
  Write-SupervisorLog ("Another native supervisor owns mutex {0}; exiting." -f $MutexName)
  $mutex.Dispose()
  exit 0
}

try {
  Write-SupervisorLog ("Native supervisor started for {0} service(s), schema {1}." -f $services.Count, $config.SchemaVersion)
  do {
    try {
      Invoke-SupervisorCheck -Services $services
    } catch {
      Write-SupervisorLog ("Supervisor check failed: {0}" -f $_.Exception.Message)
    }

    if (-not $Once) {
      Start-Sleep -Seconds $PollSeconds
    }
  } while (-not $Once)
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
