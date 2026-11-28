[CmdletBinding()]
param(
    [string]$RepoPath
)

$ErrorActionPreference = 'Stop'
if (-not $RepoPath) {
    $RepoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

function Test-NamedVolumeMount {
    param([string]$Container, [string]$VolumeName, [string]$Destination)
    $mountsRaw = & docker inspect -f '{{json .Mounts}}' $Container 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $mountsRaw) { return $false }
    $mounts = $mountsRaw | ConvertFrom-Json
    foreach ($m in $mounts) {
        if ($m.Type -eq 'volume' -and $m.Name -eq $VolumeName -and $m.Destination -eq $Destination) {
            return $true
        }
    }
    return $false
}

$resolvedRepo = (Resolve-Path -LiteralPath $RepoPath).Path
$projectName = (Split-Path -Leaf $resolvedRepo).ToLowerInvariant()
$pgVol = "${projectName}_postgres_data"
$promVol = "${projectName}_prometheus_data"
$lokiVol = "${projectName}_loki_data"

$needPg = -not (Test-NamedVolumeMount -Container 'demo-store-postgres' -VolumeName $pgVol -Destination '/var/lib/postgresql/data')
$needProm = -not (Test-NamedVolumeMount -Container 'demo-store-prometheus' -VolumeName $promVol -Destination '/prometheus')
$needLoki = -not (Test-NamedVolumeMount -Container 'demo-store-loki' -VolumeName $lokiVol -Destination '/loki')

if (-not ($needPg -or $needProm -or $needLoki)) {
    Write-Output "PostgreSQL ($pgVol), Prometheus ($promVol), and Loki ($lokiVol) already use named persistent volumes."
    exit 0
}

$tempDir = Join-Path ([IO.Path]::GetTempPath()) ("demo-store-loki-migrate-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$recreate = New-Object System.Collections.Generic.List[string]

try {
    if ($needPg) {
        Write-Output "Migrating PostgreSQL data non-destructively to named volume $pgVol..."
        & docker volume create $pgVol | Out-Null
        & docker stop demo-store-postgres | Out-Null
        & docker run --rm --volumes-from demo-store-postgres -v "${pgVol}:/target" alpine sh -c "cp -a /var/lib/postgresql/data/. /target/"
        if ($LASTEXITCODE -ne 0) { throw "Failed copying PostgreSQL data to $pgVol." }
        [void]$recreate.Add('postgres')
    }

    if ($needProm) {
        Write-Output "Migrating Prometheus TSDB non-destructively to named volume $promVol..."
        & docker volume create $promVol | Out-Null
        & docker stop demo-store-prometheus | Out-Null
        & docker run --rm --volumes-from demo-store-prometheus -v "${promVol}:/target" alpine sh -c "cp -a /prometheus/. /target/"
        if ($LASTEXITCODE -ne 0) { throw "Failed copying Prometheus TSDB to $promVol." }
        [void]$recreate.Add('prometheus')
    }

    if ($needLoki) {
        Write-Output "Migrating Loki storage non-destructively to named volume $lokiVol..."
        & docker volume create $lokiVol | Out-Null
        & docker stop demo-store-loki | Out-Null
        $null = New-Item -ItemType Directory -Path $tempDir -Force
        & docker cp demo-store-loki:/loki/. $tempDir
        if ($LASTEXITCODE -ne 0) { throw "Failed exporting Loki storage from demo-store-loki." }
        & docker run --rm -v "${tempDir}:/src:ro" -v "${lokiVol}:/target" alpine sh -c "cp -a /src/. /target/ && chown -R 10001:10001 /target"
        if ($LASTEXITCODE -ne 0) { throw "Failed populating named volume $lokiVol." }
        [void]$recreate.Add('loki')
    }

    $previousGrafanaPassword = $env:GRAFANA_ADMIN_PASSWORD
    $injected = $false
    if (-not $previousGrafanaPassword) {
        $env:GRAFANA_ADMIN_PASSWORD = 'compose-parse-unused-for-non-grafana'
        $injected = $true
    }
    Push-Location -LiteralPath $resolvedRepo
    try {
        Write-Output "Switching recreated container(s) onto named persistent volumes: $($recreate -join ', ')"
        & docker compose up -d --no-deps --force-recreate @($recreate.ToArray())
        if ($LASTEXITCODE -ne 0) { throw "docker compose failed recreating migrated stateful service(s)." }
    } finally {
        Pop-Location
        if ($injected) { Remove-Item Env:GRAFANA_ADMIN_PASSWORD -ErrorAction SilentlyContinue }
    }
} finally {
    if (Test-Path -LiteralPath $tempDir) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Write-Output "Named volume migration complete. Historical data preserved."
