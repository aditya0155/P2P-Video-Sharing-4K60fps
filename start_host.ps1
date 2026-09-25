$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath
$serverPath = Join-Path $scriptDir 'server.js'
$configPath = Join-Path $scriptDir 'mediamtx.yml'
$mediamtxPath = Join-Path $scriptDir 'mediamtx_win\mediamtx.exe'
$cloudflaredPath = Join-Path $scriptDir 'cloudflared_win\cloudflared.exe'
$tunnelConfigPath = Join-Path $scriptDir 'cloudflared_config.yml'
$secretsPath = Join-Path $scriptDir 'secrets.local.env'
$mediamtxProcess = $null
$cloudflaredProcess = $null
$webPort = 3000
if ($env:PORT) {
    if (-not [int]::TryParse($env:PORT, [ref]$webPort) -or $webPort -lt 1 -or $webPort -gt 65535) {
        throw "PORT must be a valid TCP port; received $env:PORT"
    }
}

function Test-LocalTcpPort([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(300)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

try {
    Set-Location $scriptDir

    $node = Get-Command node.exe -ErrorAction Stop
    foreach ($requiredPath in @($serverPath, $configPath, $mediamtxPath)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required host file is missing: $requiredPath"
        }
    }

    if ((Test-Path -LiteralPath $tunnelConfigPath -PathType Leaf) -and -not (Test-Path -LiteralPath $cloudflaredPath -PathType Leaf)) {
        throw "Cloudflare tunnel config exists but cloudflared.exe is missing: $cloudflaredPath"
    }

    # Optional Cloudflare TURN credentials (written by setup_cloudflared.ps1).
    # The file keeps the API token on this laptop; browsers only ever receive
    # short-lived, server-minted ICE credentials from /stream-api/turn.
    if (Test-Path -LiteralPath $secretsPath -PathType Leaf) {
        foreach ($secretsLine in Get-Content -LiteralPath $secretsPath) {
            if ($secretsLine -match '^\s*(CF_[A-Z0-9_]+)\s*=\s*(.*)$') {
                Set-Item -Path ("Env:{0}" -f $Matches[1]) -Value $Matches[2].Trim()
            }
        }
        Write-Host 'Loaded Cloudflare TURN credentials from secrets.local.env.' -ForegroundColor Cyan
    }

    if (Test-LocalTcpPort $webPort) {
        throw "Port $webPort is already in use. Stop the other site server or set PORT to a free port before starting."
    }

    Write-Host 'Validating MediaMTX configuration...' -ForegroundColor Cyan
    & $mediamtxPath --validate-conf $configPath
    if ($LASTEXITCODE -ne 0) { throw 'MediaMTX configuration validation failed.' }

    if (Test-LocalTcpPort 8889) {
        $listener = Get-NetTCPConnection -LocalPort 8889 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        $existing = if ($listener) { Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" } else { $null }
        $expectedExe = (Resolve-Path -LiteralPath $mediamtxPath).Path
        if (-not $existing -or $existing.Name -ne 'mediamtx.exe' -or $existing.ExecutablePath -ne $expectedExe) {
            throw 'Port 8889 is in use by a different process. Close it before starting this host.'
        }

        if (-not (Test-LocalTcpPort 8888)) {
            throw 'The existing MediaMTX instance does not expose the expected local API on port 8888.'
        }
        try {
            $paths = Invoke-RestMethod -Uri 'http://127.0.0.1:8888/v3/paths/list' -TimeoutSec 3
        } catch {
            throw 'The existing MediaMTX API did not respond on port 8888.'
        }
        if (@($paths.items.name) -notcontains 'live') {
            throw "The existing MediaMTX instance does not have the expected 'live' path."
        }
        Write-Host "Reusing the running MediaMTX instance (PID $($existing.ProcessId))." -ForegroundColor Cyan
    } else {
        Write-Host 'Starting MediaMTX on this laptop...' -ForegroundColor Cyan
        $mediamtxProcess = Start-Process -FilePath $mediamtxPath -ArgumentList "`"$configPath`"" -PassThru -NoNewWindow

        $deadline = (Get-Date).AddSeconds(20)
        while (-not (Test-LocalTcpPort 8889) -and (Get-Date) -lt $deadline) {
            $mediamtxProcess.Refresh()
            if ($mediamtxProcess.HasExited) {
                throw "MediaMTX exited during startup with code $($mediamtxProcess.ExitCode)."
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not (Test-LocalTcpPort 8889)) {
            throw 'MediaMTX did not open its WebRTC signaling port 8889 within 20 seconds.'
        }
    }

    if (Test-Path -LiteralPath $tunnelConfigPath -PathType Leaf) {
        Write-Host 'Starting the Cloudflare tunnel for https://stream.rydius.in ...' -ForegroundColor Cyan
        $cloudflaredProcess = Start-Process -FilePath $cloudflaredPath `
            -ArgumentList @('tunnel', '--config', "`"$tunnelConfigPath`"", 'run', 'rydius-stream') `
            -WindowStyle Hidden -PassThru
        Start-Sleep -Seconds 3
        $cloudflaredProcess.Refresh()
        if ($cloudflaredProcess.HasExited) {
            Write-Warning "cloudflared exited with code $($cloudflaredProcess.ExitCode). Local and Tailscale access still work; remote links will not."
            $cloudflaredProcess = $null
        } else {
            Write-Host 'Tunnel is up: https://stream.rydius.in' -ForegroundColor Green
        }
    } else {
        Write-Host 'Cloudflare tunnel not configured (run setup_cloudflared.ps1 once). Local + Tailscale access still work.' -ForegroundColor DarkYellow
    }

    Write-Host 'Starting the local website and WebRTC signaling proxy...' -ForegroundColor Cyan
    Write-Host "Open http://127.0.0.1:$webPort/streaming/ on this laptop." -ForegroundColor Green
    & $node.Source $serverPath
    if ($LASTEXITCODE -ne 0) { throw "Node.js server exited with code $LASTEXITCODE." }
} catch {
    Write-Error $_
    exit 1
} finally {
    if ($cloudflaredProcess) {
        $cloudflaredProcess.Refresh()
        if (-not $cloudflaredProcess.HasExited) {
            Write-Host 'Stopping the Cloudflare tunnel started by this launcher...' -ForegroundColor Gray
            Stop-Process -Id $cloudflaredProcess.Id -Force -ErrorAction SilentlyContinue
        }
    }
    if ($mediamtxProcess) {
        $mediamtxProcess.Refresh()
        if (-not $mediamtxProcess.HasExited) {
            Write-Host 'Stopping the MediaMTX process started by this launcher...' -ForegroundColor Gray
            $mediamtxProcess.CloseMainWindow() | Out-Null
            if (-not $mediamtxProcess.WaitForExit(3000)) {
                Stop-Process -Id $mediamtxProcess.Id -Force -ErrorAction SilentlyContinue
            }
        }
    }
}
