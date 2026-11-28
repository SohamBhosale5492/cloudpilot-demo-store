[CmdletBinding()]
param(
    [string]$RepoPath,
    [string[]]$Services,
    [switch]$SkipGitPull,
    [switch]$GenerateTraffic,
    [string]$ExpectedRemote = 'SohamBhosale5492/cloudpilot-demo-store'
)

$ErrorActionPreference = 'Stop'
if (-not $RepoPath) {
    $RepoPath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
}

function Wait-HttpReady {
    param(
        [string]$Name,
        [string]$Url,
        [int]$TimeoutSeconds = 45
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try {
            $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300) {
                return
            }
        } catch {
            # retry until deadline
        }
        Start-Sleep -Milliseconds 600
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name ($Url) did not become ready within $TimeoutSeconds seconds."
}

$resolvedRepo = (Resolve-Path -LiteralPath $RepoPath).Path
Push-Location -LiteralPath $resolvedRepo
try {
    $remoteUrl = (& git remote get-url origin 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $remoteUrl -or ($remoteUrl -notmatch [regex]::Escape($ExpectedRemote))) {
        throw "Unexpected git origin '$remoteUrl'. Expected remote matching '$ExpectedRemote'."
    }

    $branch = (& git rev-parse --abbrev-ref HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $branch -ne 'main') {
        throw "Expected repository on branch 'main', found '$branch'. Aborting without modifying branches or merging PRs."
    }

    $dirty = (& git status --porcelain)
    if ($dirty) {
        throw "Working tree has uncommitted changes. Commit or stash changes before deploying from main."
    }

    $beforeSha = (& git rev-parse HEAD).Trim()
    if (-not $SkipGitPull) {
        Write-Output "Fetching origin/main..."
        & git fetch origin main
        if ($LASTEXITCODE -ne 0) { throw "git fetch origin main failed." }

        & git pull --ff-only origin main
        if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only origin main failed (refusing auto-merge)." }
    }

    $afterSha = (& git rev-parse HEAD).Trim()
    $headSummary = (& git log -1 --oneline).Trim()
    Write-Output "Verified Demo Store repository ($ExpectedRemote) at $headSummary"

    $changedFiles = @()
    if ($beforeSha -ne $afterSha) {
        $changedFiles = @(& git diff --name-only $beforeSha $afterSha)
        Write-Output "Synced revision $beforeSha -> $afterSha ($($changedFiles.Count) changed file(s))"
    }

    $rebuildServices = New-Object System.Collections.Generic.List[string]
    $restartContainers = New-Object System.Collections.Generic.List[string]
    $reloadPrometheus = $false

    if ($Services -and $Services.Count -gt 0) {
        foreach ($svc in $Services) {
            if ($svc -in @('grafana', 'postgres', 'loki', 'jaeger', 'prometheus')) {
                throw "Stateful service '$svc' cannot be recreated via routine Deploy-DemoStore.ps1 to preserve databases and monitoring history."
            }
            if (-not $rebuildServices.Contains($svc)) { [void]$rebuildServices.Add($svc) }
        }
    } elseif ($changedFiles.Count -gt 0) {
        foreach ($file in $changedFiles) {
            if ($file -like 'api-gateway/*') {
                if (-not $rebuildServices.Contains('api-gateway')) { [void]$rebuildServices.Add('api-gateway') }
            } elseif ($file -like 'product-service/*') {
                if (-not $rebuildServices.Contains('product-service')) { [void]$rebuildServices.Add('product-service') }
            } elseif ($file -like 'order-service/*') {
                if (-not $rebuildServices.Contains('order-service')) { [void]$rebuildServices.Add('order-service') }
            } elseif ($file -eq 'config/observability/alert-rules.yaml' -or $file -eq 'prometheus/prometheus.yml') {
                $reloadPrometheus = $true
            } elseif ($file -like 'config/observability/*') {
                foreach ($c in @('demo-store-api-gateway', 'demo-store-product-service', 'demo-store-order-service')) {
                    if (-not $restartContainers.Contains($c)) { [void]$restartContainers.Add($c) }
                }
            }
        }
    }

    # Ensure core services are running without recreating stateful containers
    foreach ($containerName in @('demo-store-postgres', 'demo-store-loki', 'demo-store-jaeger', 'demo-store-otel-collector', 'demo-store-prometheus', 'demo-store-grafana', 'demo-store-product-service', 'demo-store-order-service', 'demo-store-api-gateway')) {
        $running = (& docker inspect -f '{{.State.Running}}' $containerName 2>$null)
        if ($LASTEXITCODE -eq 0 -and $running -ne 'true') {
            Write-Output "Starting stopped container $containerName..."
            & docker start $containerName | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "Failed to start container '$containerName'." }
        }
    }

    if ($rebuildServices.Count -gt 0) {
        $previousGrafanaPassword = $env:GRAFANA_ADMIN_PASSWORD
        $injectedPlaceholder = $false
        if (-not $previousGrafanaPassword) {
            # Scope-only placeholder to satisfy Compose YAML interpolation without altering Grafana.
            $env:GRAFANA_ADMIN_PASSWORD = 'compose-parse-unused-for-non-grafana'
            $injectedPlaceholder = $true
        }
        try {
            Write-Output "Rebuilding affected service(s): $($rebuildServices -join ', ')"
            & docker compose up -d --no-deps --build @($rebuildServices.ToArray())
            if ($LASTEXITCODE -ne 0) { throw "docker compose up -d --no-deps --build failed." }
        } finally {
            if ($injectedPlaceholder) {
                Remove-Item Env:GRAFANA_ADMIN_PASSWORD -ErrorAction SilentlyContinue
            }
        }
    } elseif ($restartContainers.Count -gt 0) {
        Write-Output "Reloading observability config by restarting: $($restartContainers -join ', ')"
        & docker restart @($restartContainers.ToArray()) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "docker restart failed." }
    } elseif (-not $reloadPrometheus) {
        # No git diff detected or explicit no-op sync: gracefully restart app services to reload mounted config
        Write-Output "Refreshing application containers without touching stateful volumes..."
        & docker restart demo-store-product-service demo-store-order-service demo-store-api-gateway | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "docker restart of application services failed." }
    }

    if ($reloadPrometheus -or $changedFiles.Count -eq 0) {
        try {
            Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:9090/-/reload' -TimeoutSec 5 | Out-Null
            Write-Output "Prometheus rules/config reloaded via /-/reload without restarting TSDB."
        } catch {
            Write-Warning "Prometheus /-/reload failed: $($_.Exception.Message)"
        }
    }

    $checks = [ordered]@{
        'Product Service health'    = 'http://127.0.0.1:4001/health'
        'Product Service readiness' = 'http://127.0.0.1:4001/ready'
        'Order Service health'      = 'http://127.0.0.1:4002/health'
        'Order Service readiness'   = 'http://127.0.0.1:4002/ready'
        'API Gateway health'        = 'http://127.0.0.1:4000/health'
        'API Gateway readiness'     = 'http://127.0.0.1:4000/ready'
        'Prometheus'                = 'http://127.0.0.1:9090/-/ready'
        'Loki'                      = 'http://127.0.0.1:3100/ready'
        'Jaeger'                    = 'http://127.0.0.1:16686/api/services'
        'OTel Collector'            = 'http://127.0.0.1:13133/'
    }
    foreach ($entry in $checks.GetEnumerator()) {
        Wait-HttpReady -Name $entry.Key -Url $entry.Value -TimeoutSeconds 45
    }
    Write-Output "All Demo Store application and telemetry readiness checks passed."

    if ($GenerateTraffic) {
        Write-Output "Generating bounded real demo traffic..."
        & node (Join-Path $resolvedRepo 'scripts\generate-demo-traffic.js')
        if ($LASTEXITCODE -ne 0) { throw "Traffic generation failed." }
    }
} finally {
    Pop-Location
}
