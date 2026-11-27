[CmdletBinding()]
param(
    [switch]$AuthorizeMemoryDiscard,
    [string]$SnapshotDirectory
)

$ErrorActionPreference = 'Stop'
$demoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$workspaceRoot = Split-Path -Parent $demoRoot
if (-not $SnapshotDirectory) {
    $SnapshotDirectory = Join-Path $workspaceRoot 'backups'
}

$containerName = 'demo-store-jaeger'
$jaegerBaseUrl = 'http://127.0.0.1:16686'

$inspectRaw = & docker inspect --type container $containerName 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "Container '$containerName' could not be inspected. Ensure Docker Desktop is running."
}
$container = ($inspectRaw -join "`n" | ConvertFrom-Json)[0]
$envList = @($container.Config.Env)
$storageEnv = ($envList | Where-Object { $_ -like 'SPAN_STORAGE_TYPE=*' } | Select-Object -First 1)
$currentStorage = if ($storageEnv) { $storageEnv.Split('=', 2)[1] } else { 'memory' }

Write-Output "Current $containerName storage backend: $currentStorage"
if ($currentStorage -eq 'badger') {
    Write-Output "$containerName is already running with durable Badger storage. No transition needed."
    exit 0
}

# Export current in-memory traces to an archive file before any change
$null = New-Item -ItemType Directory -Path $SnapshotDirectory -Force
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$snapshotPath = Join-Path $SnapshotDirectory "jaeger-memory-snapshot-$timestamp.json"

$servicesResp = Invoke-RestMethod -Uri "$jaegerBaseUrl/api/services" -TimeoutSec 5
$services = @($servicesResp.data)
$tracesByService = [ordered]@{}
$totalTraces = 0
foreach ($svc in $services) {
    $encoded = [uri]::EscapeDataString($svc)
    $tResp = Invoke-RestMethod -Uri "$jaegerBaseUrl/api/traces?service=$encoded&limit=1000&lookback=48h" -TimeoutSec 10
    $list = @($tResp.data)
    $tracesByService[$svc] = $list
    $totalTraces += $list.Count
}

$archive = [ordered]@{
    capturedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    container     = $containerName
    sourceStorage = $currentStorage
    services      = $services
    totalTraces   = $totalTraces
    traces        = $tracesByService
}
$archive | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath $snapshotPath -Encoding UTF8
Write-Output "Archived $totalTraces in-memory trace(s) across $($services.Count) service(s) to: $snapshotPath"

if (-not $AuthorizeMemoryDiscard) {
    Write-Output ""
    Write-Output "ACTION REQUIRED (DRY-RUN / ARCHIVE ONLY):"
    Write-Output "Jaeger 1.55 Badger storage cannot directly import Jaeger UI JSON trace exports."
    Write-Output "Recreating '$containerName' to switch from 'memory' to durable 'badger' storage will clear live in-memory traces (already archived above)."
    Write-Output "To authorize and apply the storage transition, re-run with:"
    Write-Output "  powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -AuthorizeMemoryDiscard"
    exit 0
}

Push-Location -LiteralPath $demoRoot
try {
    Write-Output "Applying durable Badger storage transition to $containerName..."
    & docker compose up -d --no-deps --force-recreate jaeger-storage-init jaeger
    if ($LASTEXITCODE -ne 0) { throw "docker compose failed during Jaeger storage transition." }
} finally {
    Pop-Location
}

$deadline = [DateTime]::UtcNow.AddSeconds(45)
$healthy = $false
while ([DateTime]::UtcNow -lt $deadline) {
    try {
        $resp = Invoke-WebRequest -Uri "$jaegerBaseUrl/api/services" -UseBasicParsing -TimeoutSec 3
        if ($resp.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $healthy) {
    throw "Jaeger did not become healthy on $jaegerBaseUrl after transition."
}

$afterInspect = ((& docker inspect --type container $containerName 2>$null) -join "`n" | ConvertFrom-Json)[0]
$afterStorage = (@($afterInspect.Config.Env) | Where-Object { $_ -like 'SPAN_STORAGE_TYPE=*' } | Select-Object -First 1)
$hasBadgerMount = @($afterInspect.Mounts | Where-Object { $_.Destination -eq '/badger' }).Count -gt 0
Write-Output "Transition complete: $afterStorage, /badger mount active=$hasBadgerMount"
