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
# The WebRTC media (RTP) port from webrtcLocalUDPAddress in mediamtx.yml. Every
# viewer's video crosses it, it is UDP, and nothing else in the launcher's
# pre-flight touches it — so a conflict there used to surface only as a generic
# "MediaMTX exited during startup" while the site itself still loaded.
$webrtcUdpPort = 8189
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

# 8189 is the WebRTC MEDIA (RTP) port bound by webrtcLocalUDPAddress, and it is
# UDP: a TcpClient probe is structurally blind to a conflict on it, because a
# free (or occupied) TCP port says nothing about who owns a UDP port. Binding a
# real UdpClient is the only local test that answers that question. The
# constructor is inside the try on purpose: UdpClient binds in its constructor,
# so on a conflict the object is never created and there is nothing to close.
function Test-LocalUdpPort([int]$Port) {
    $udp = $null
    try {
        $udp = New-Object System.Net.Sockets.UdpClient($Port)
        return $true
    } catch {
        return $false
    } finally {
        if ($udp) { $udp.Close() }
    }
}

# Read every top-level "key: value" scalar out of mediamtx.yml. The launcher
# used to compare a hand-picked list against the running instance, which meant
# every key added later (readTimeout, webrtc*, log*, ...) was silently ignored:
# an operator edited the file, re-ran the launcher, was told the config matched
# and the old value stayed live. Deriving the list from the file is the only
# version of this check that cannot fall out of sync with the file again.
# Skipped keys are returned with the reason so a reader can tell "compared and
# equal" apart from "not compared at all".
function Get-MediamtxFileScalars([string]$Path) {
    $settings = [ordered]@{}
    $skipped = New-Object System.Collections.ArrayList
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        # Anchored at column 0, so comment lines and every indented/nested line
        # (the paths: block, the webrtcICEServers2: entries) are ignored.
        if ($rawLine -notmatch '^([A-Za-z][A-Za-z0-9]*):[ \t]*(.*)$') { continue }
        $key = $Matches[1]
        $value = $Matches[2]
        # YAML starts a trailing comment at a space followed by '#'; leaving it
        # in the value would invent a mismatch against a healthy instance.
        $value = ($value -split '[ \t]+#', 2)[0].Trim()
        # No value at all means the key introduces a block (paths:,
        # webrtcAdditionalHosts:, ...). The control API has no scalar to read
        # back for those, so they are reported rather than compared.
        if ($value -eq '') {
            $skipped.Add("$key (block/list value in mediamtx.yml)") | Out-Null
            continue
        }
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        # MediaMTX reads yes/no/true/false as one boolean; the API answers with
        # a JSON boolean, so the file side is folded onto the same spelling.
        if ($value -eq 'true') { $value = 'yes' } elseif ($value -eq 'false') { $value = 'no' }
        $settings[$key] = $value
    }
    return [pscustomobject]@{ Settings = $settings; Skipped = $skipped }
}

# Reduce a value from the control API to the spelling mediamtx.yml uses, or
# $null when it is not a scalar at all. The API answers lists/objects for keys
# such as logDestinations, webrtcAllowOrigins, webrtcIPsFromInterfacesList,
# webrtcAdditionalHosts and webrtcICEServers2; comparing those as strings
# ALWAYS mismatches and would refuse to start against a correctly running
# instance, which is the same silent-no-op bug wearing a louder mask.
function ConvertTo-MediamtxScalarText($Value) {
    if ($Value -is [bool]) {
        if ($Value) { return 'yes' } else { return 'no' }
    }
    if ($Value -is [string]) { return $Value }
    if ($Value -is [ValueType]) { return [string]$Value }
    return $null
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

        # Compare the RUNNING instance's effective config against the file on
        # disk. The validation above only proves the FILE parses — a process
        # that is already up never read it. Reusing a stale instance therefore
        # turned every tuning edit into a silent no-op while the launcher
        # cheerfully reported success. These are the reader-smoothness knobs, so
        # a no-op there is exactly the kind of bug this project cannot see.
        # The key list comes from mediamtx.yml itself rather than from a
        # hand-picked set: that set was only ever writeQueueSize,
        # udpReadBufferSize, udpMaxPayloadSize and logLevel, so readTimeout,
        # the webrtc* / rtmp* / log* / auth settings and every other tuning
        # knob were edited, re-checked and ignored.
        $compared = 0
        $configVerified = $false
        try {
            $live = Invoke-RestMethod -Uri 'http://127.0.0.1:8888/v3/config/global/get' -TimeoutSec 3
            $fileScalars = Get-MediamtxFileScalars $configPath
            $stale = @()
            foreach ($key in $fileScalars.Settings.Keys) {
                $liveProperty = $live.PSObject.Properties[$key]
                if ($null -eq $liveProperty) {
                    $fileScalars.Skipped.Add("$key (absent from the running config)") | Out-Null
                    continue
                }
                $liveValue = ConvertTo-MediamtxScalarText $liveProperty.Value
                if ($null -eq $liveValue) {
                    $fileScalars.Skipped.Add("$key (running config reports a list or object)") | Out-Null
                    continue
                }
                $compared++
                if ($fileScalars.Settings[$key] -ne $liveValue) {
                    $stale += "$key (file: $($fileScalars.Settings[$key]), running: $liveValue)"
                }
            }
            if ($fileScalars.Skipped.Count -gt 0) {
                Write-Host ("Config keys not compared: " + ($fileScalars.Skipped -join '; ')) -ForegroundColor DarkGray
            }
            $configVerified = $true
            if ($stale.Count -gt 0) {
                # A WARNING, not a throw. This used to throw, and the outer
                # catch exits before Node and cloudflared ever start — so a
                # stale MediaMTX config took the entire WEBSITE and tunnel down,
                # which is the opposite of what this check exists to protect.
                # The streaming stack is already running; refusing to bring the
                # site up next to it helps nobody.
                Write-Warning ("The running MediaMTX instance was started with a DIFFERENT configuration than mediamtx.yml on disk: " + ($stale -join '; ') + ". Your edited tuning is NOT in effect. Stop mediamtx.exe (Ctrl+C in its window) and re-run to apply it. The site and tunnel are being started anyway.")
            }
        } catch {
            Write-Host "Could not compare the running MediaMTX config (proceeding): $($_.Exception.Message)" -ForegroundColor Yellow
        }
        if ($configVerified -and $compared -gt 0) {
            Write-Host "Reusing the running MediaMTX instance (PID $($existing.ProcessId)); config matches mediamtx.yml ($compared scalar keys compared)." -ForegroundColor Cyan
        } else {
            # Never print "config matches" in the reassuring colour when the
            # comparison did not actually run — that was the one path that was
            # supposed to be loud and instead went quiet.
            Write-Host "Reusing the running MediaMTX instance (PID $($existing.ProcessId)); its config was NOT verified." -ForegroundColor Yellow
        }
    } else {
        # Probed only on the branch that is about to START MediaMTX: a reused
        # instance already holds 8189, and would be reported as the conflict.
        if (-not (Test-LocalUdpPort $webrtcUdpPort)) {
            $holder = Get-NetUDPEndpoint -LocalPort $webrtcUdpPort -ErrorAction SilentlyContinue | Select-Object -First 1
            $holderProcess = if ($holder) { Get-CimInstance Win32_Process -Filter "ProcessId=$($holder.OwningProcess)" -ErrorAction SilentlyContinue } else { $null }
            $holderText = if ($holderProcess) { " It is held by $($holderProcess.Name) (PID $($holderProcess.ProcessId))." } else { '' }
            throw "Port $webrtcUdpPort is already in use (UDP).$holderText That is the WebRTC media port: every viewer's video flows through it, so the page and signaling would start fine while remote viewers got no picture at all. Close that process (or stop whatever is holding UDP $webrtcUdpPort) and start the host again."
        }

        Write-Host 'Starting MediaMTX on this laptop...' -ForegroundColor Cyan
        $mediamtxProcess = Start-Process -FilePath $mediamtxPath -ArgumentList "`"$configPath`"" -PassThru -NoNewWindow

        # MediaMTX's per-reader write path (pion -> UDP socket) is CPU-sensitive,
        # and this box runs OBS capture, the codec bridge's ffmpeg, MediaMTX,
        # Node and cloudflared at once. If an encoder thread is preempted there,
        # packets stop leaving for a scheduling quantum and EVERY viewer hitches
        # at the same instant — the signature of a host-side stall. Failing to
        # set the class (no rights, process already gone) must not stop a launch.
        try {
            $mediamtxProcess.PriorityClass = [System.Diagnostics.ProcessPriorityClass]::AboveNormal
        } catch {
            Write-Host "MediaMTX is running at normal priority (could not raise it): $($_.Exception.Message)" -ForegroundColor Yellow
        }

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
            # server.js keys chat/reaction rate limits on the real client IP.
            # It only honours CF-Connecting-Ip when CF_TUNNEL_HOST is set,
            # because this server binds 127.0.0.1 and every path in (tunnel,
            # Tailscale serve, a local client) therefore looks like loopback --
            # only the tunnel actually rewrites the header, so only the tunnel
            # can safely be trusted for it. Without this flag every remote viewer
            # shares one bucket and a single chatty client locks the whole room
            # out of chat.
            $env:CF_TUNNEL_HOST = 'stream.rydius.in'
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
