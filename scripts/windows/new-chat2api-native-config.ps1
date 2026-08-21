[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Chat2ApiSourcePath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Chat2ApiDataPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$LiteLlmVenvPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$LiteLlmConfigPath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Chat2ApiContainer,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$LiteLlmContainer,

  [ValidateRange(1, 65535)]
  [int]$Chat2ApiPort = 18080,

  [ValidateNotNullOrEmpty()]
  [string]$Chat2ApiHost = '127.0.0.1',

  [ValidateRange(1, 65535)]
  [int]$LiteLlmPort = 4000,

  [ValidateNotNullOrEmpty()]
  [string]$LiteLlmHost = '127.0.0.1',

  [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'Chat2API\native\supervisor-config.clixml'),

  [string]$LogDirectory = (Join-Path $env:LOCALAPPDATA 'Chat2API\native\logs'),

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

function Get-DockerExecutable {
  $command = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    throw 'docker.exe was not found. Docker is required only while importing the existing service environment.'
  }
  return $command.Source
}

function Get-ContainerEnvironment {
  param(
    [Parameter(Mandatory = $true)][string]$DockerExecutable,
    [Parameter(Mandatory = $true)][string]$ContainerName
  )

  try {
    $raw = & $DockerExecutable inspect $ContainerName 2>$null
  } catch {
    throw "Could not inspect Docker container ${ContainerName}: $($_.Exception.Message)"
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect Docker container: $ContainerName"
  }

  $items = @($raw | ConvertFrom-Json)
  if ($items.Count -ne 1) {
    throw "Expected one Docker container named ${ContainerName}, found $($items.Count)."
  }

  $environment = @{}
  foreach ($entry in @($items[0].Config.Env)) {
    $separator = $entry.IndexOf('=')
    if ($separator -le 0) {
      continue
    }
    $environment[$entry.Substring(0, $separator)] = $entry.Substring($separator + 1)
  }
  return $environment
}

function Select-Environment {
  param(
    [Parameter(Mandatory = $true)][hashtable]$Source,
    [Parameter(Mandatory = $true)][string]$NamePattern
  )

  $selected = @{}
  foreach ($entry in $Source.GetEnumerator()) {
    if ($entry.Key -match $NamePattern) {
      $selected[$entry.Key] = [string]$entry.Value
    }
  }
  return $selected
}

function Protect-Environment {
  param([Parameter(Mandatory = $true)][hashtable]$Environment)

  return @(
    $Environment.GetEnumerator() |
      Sort-Object Key |
      ForEach-Object {
        [pscustomobject]@{
          Name = $_.Key
          Value = ConvertTo-SecureString -String ([string]$_.Value) -AsPlainText -Force
        }
      }
  )
}

function ConvertTo-NativeArgument {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
    return $Value
  }

  $builder = [Text.StringBuilder]::new()
  [void]$builder.Append('"')
  $backslashes = 0
  foreach ($character in $Value.ToCharArray()) {
    if ($character -eq '\') {
      $backslashes++
      continue
    }

    if ($character -eq '"') {
      for ($index = 0; $index -lt (($backslashes * 2) + 1); $index++) {
        [void]$builder.Append('\')
      }
      [void]$builder.Append('"')
      $backslashes = 0
      continue
    }

    for ($index = 0; $index -lt $backslashes; $index++) {
      [void]$builder.Append('\')
    }
    $backslashes = 0
    [void]$builder.Append($character)
  }

  for ($index = 0; $index -lt ($backslashes * 2); $index++) {
    [void]$builder.Append('\')
  }
  [void]$builder.Append('"')
  return $builder.ToString()
}

function Join-NativeArguments {
  param([Parameter(Mandatory = $true)][string[]]$Value)

  return [string]::Join(' ', @($Value | ForEach-Object { ConvertTo-NativeArgument -Value $_ }))
}

function Set-OwnerOnlyAcl {
  param([Parameter(Mandatory = $true)][string]$Path)

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new(
    $identity,
    [Security.AccessControl.FileSystemRights]::FullControl,
    [Security.AccessControl.AccessControlType]::Allow
  )
  $acl.SetAccessRule($rule)
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function New-HttpUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Host,
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Path
  )

  $builder = [UriBuilder]::new('http', $Host, $Port)
  $builder.Path = $Path
  return $builder.Uri.AbsoluteUri.TrimEnd('/')
}

if ($Chat2ApiHost.Equals($LiteLlmHost, [StringComparison]::OrdinalIgnoreCase) -and $Chat2ApiPort -eq $LiteLlmPort) {
  throw 'Chat2API and LiteLLM must use different ports.'
}

$chatSource = Resolve-RequiredDirectory -Path $Chat2ApiSourcePath -Description 'Chat2API source directory'
$chatData = Resolve-RequiredDirectory -Path $Chat2ApiDataPath -Description 'Chat2API data directory'
$liteVenv = Resolve-RequiredDirectory -Path $LiteLlmVenvPath -Description 'LiteLLM virtual environment'
$liteConfig = Resolve-RequiredFile -Path $LiteLlmConfigPath -Description 'LiteLLM config'
$chatEntryPoint = Resolve-RequiredFile -Path (Join-Path $chatSource 'out-server\server\index.js') -Description 'Built Chat2API server entry point'
$nodeExecutable = (Get-Command node.exe -ErrorAction Stop).Source
$liteExecutable = Resolve-RequiredFile -Path (Join-Path $liteVenv 'Scripts\litellm.exe') -Description 'LiteLLM console entry point'
$dockerExecutable = Get-DockerExecutable

$chatEnvironment = Select-Environment `
  -Source (Get-ContainerEnvironment -DockerExecutable $dockerExecutable -ContainerName $Chat2ApiContainer) `
  -NamePattern '^(CHAT2API_|QWEN_AI_)'
$chatEnvironment['CHAT2API_HOST'] = $Chat2ApiHost
$chatEnvironment['CHAT2API_PORT'] = [string]$Chat2ApiPort
$chatEnvironment['CHAT2API_DATA_DIR'] = $chatData
$chatEnvironment['NODE_ENV'] = 'production'

$liteEnvironment = Select-Environment `
  -Source (Get-ContainerEnvironment -DockerExecutable $dockerExecutable -ContainerName $LiteLlmContainer) `
  -NamePattern '^(LITELLM_|CHAT2API_API_KEY$|REQUEST_TIMEOUT$)'
$chatBaseUrl = New-HttpUrl -Host $Chat2ApiHost -Port $Chat2ApiPort -Path '/'
$chatHealthUrl = New-HttpUrl -Host $Chat2ApiHost -Port $Chat2ApiPort -Path '/health'
$liteHealthUrl = New-HttpUrl -Host $LiteLlmHost -Port $LiteLlmPort -Path '/health/liveliness'
$liteEnvironment['CHAT2API_BASE_URL'] = "$chatBaseUrl/v1"
$liteEnvironment['CHAT2API_HEALTH_URL'] = $chatHealthUrl

$resolvedLogDirectory = [IO.Path]::GetFullPath($LogDirectory)
New-Item -ItemType Directory -Path $resolvedLogDirectory -Force | Out-Null

$services = @(
  [pscustomobject]@{
    Name = 'chat2api'
    Executable = $nodeExecutable
    CommandLineArguments = Join-NativeArguments -Value @($chatEntryPoint)
    WorkingDirectory = $chatSource
    HealthUrl = $chatHealthUrl
    DependsOn = @()
    DependencyHealthUrls = @()
    Environment = Protect-Environment -Environment $chatEnvironment
    StdOutPath = Join-Path $resolvedLogDirectory 'chat2api.out.log'
    StdErrPath = Join-Path $resolvedLogDirectory 'chat2api.err.log'
    PidPath = Join-Path $resolvedLogDirectory 'chat2api.pid'
    StartTimeoutSeconds = 60
    RestartAfterSeconds = 120
  },
  [pscustomobject]@{
    Name = 'litellm'
    Executable = $liteExecutable
    CommandLineArguments = Join-NativeArguments -Value @(
      '--config',
      $liteConfig,
      '--host',
      $LiteLlmHost,
      '--port',
      [string]$LiteLlmPort,
      '--num_workers',
      '1'
    )
    WorkingDirectory = (Split-Path -Parent $liteConfig)
    HealthUrl = $liteHealthUrl
    DependsOn = @('chat2api')
    # Keep an explicit URL prerequisite as well as the named dependency. This
    # lets the supervisor detect a stale/standalone LiteLLM config that was
    # generated before both processes were managed together.
    DependencyHealthUrls = @($chatHealthUrl)
    Environment = Protect-Environment -Environment $liteEnvironment
    StdOutPath = Join-Path $resolvedLogDirectory 'litellm.out.log'
    StdErrPath = Join-Path $resolvedLogDirectory 'litellm.err.log'
    PidPath = Join-Path $resolvedLogDirectory 'litellm.pid'
    StartTimeoutSeconds = 120
    RestartAfterSeconds = 180
  }
)

$config = [pscustomobject]@{
  SchemaVersion = 2
  GeneratedAt = [DateTimeOffset]::Now
  Services = $services
}

$resolvedConfigPath = [IO.Path]::GetFullPath($ConfigPath)
$configDirectory = Split-Path -Parent $resolvedConfigPath
if (-not (Test-Path -LiteralPath $configDirectory)) {
  New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null
}
if ((Test-Path -LiteralPath $resolvedConfigPath) -and -not $Force) {
  throw "Native supervisor config already exists: $resolvedConfigPath. Pass -Force to replace it."
}

$temporaryPath = "$resolvedConfigPath.$([Guid]::NewGuid().ToString('N')).tmp"
$config | Export-Clixml -LiteralPath $temporaryPath -Depth 8
Set-OwnerOnlyAcl -Path $temporaryPath
Move-Item -LiteralPath $temporaryPath -Destination $resolvedConfigPath -Force

[pscustomobject]@{
  ConfigPath = $resolvedConfigPath
  Chat2ApiHealth = $services[0].HealthUrl
  LiteLlmHealth = $services[1].HealthUrl
  EnvironmentValues = 'DPAPI-encrypted for the current Windows user'
} | Format-List
