[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$DestinationPath
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

$source = Resolve-RequiredDirectory -Path $SourcePath -Description 'Built Chat2API source directory'
$requiredFiles = @(
  'package.json',
  'package-lock.json',
  'sha3_wasm_bg.7b9ca65ddd.wasm',
  'out-server\server\index.js'
)
foreach ($relativePath in $requiredFiles) {
  Resolve-RequiredFile -Path (Join-Path $source $relativePath) -Description $relativePath | Out-Null
}
Resolve-RequiredDirectory -Path (Join-Path $source 'out-server') -Description 'Chat2API server bundle' | Out-Null
Resolve-RequiredDirectory -Path (Join-Path $source 'out-admin') -Description 'Chat2API admin bundle' | Out-Null

$destination = [IO.Path]::GetFullPath($DestinationPath)
if (Test-Path -LiteralPath $destination) {
  throw "Native runtime destination already exists: $destination"
}
New-Item -ItemType Directory -Path $destination | Out-Null

foreach ($fileName in @('package.json', 'package-lock.json', 'sha3_wasm_bg.7b9ca65ddd.wasm')) {
  Copy-Item -LiteralPath (Join-Path $source $fileName) -Destination (Join-Path $destination $fileName)
}
Copy-Item -LiteralPath (Join-Path $source 'out-server') -Destination $destination -Recurse
Copy-Item -LiteralPath (Join-Path $source 'out-admin') -Destination $destination -Recurse

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
& $npm --prefix $destination ci --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) {
  throw "npm ci failed for native runtime: $destination"
}

$entryPoint = Resolve-RequiredFile -Path (Join-Path $destination 'out-server\server\index.js') -Description 'Installed Chat2API server entry point'
[pscustomobject]@{
  RuntimePath = $destination
  EntryPoint = $entryPoint
  NodeModules = (Join-Path $destination 'node_modules')
} | Format-List
