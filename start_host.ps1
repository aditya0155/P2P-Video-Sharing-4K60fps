$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $PSCommandPath

# --- Refuse to broadcast from a throwaway checkout -------------------------
# A linked git worktree (an editor/agent sandbox under .git\worktrees, or any
# path whose .git is a FILE rather than a directory) is a short-lived scratch
# copy, not the project. Serving from one is silent and badly misleading:
# server.js and mediamtx.yml both resolve everything from their own directory,
# so a viewer gets the sandbox's app.js while the operator edits the real one.
# The symptom is a fix that "did nothing", or a config change that never takes
# effect -- with nothing in the logs to say the code being served is not the
# code on disk in the project folder.
#
# This actually happened here: the live site on port 3000 was being served by
# a worktree whose copy of app.js had diverged from the main checkout's.
$gitMarker = Join-Path $scriptDir '.git'
if (Test-Path -LiteralPath $gitMarker) {
    $isLinkedWorktree = -not (Get-Item -LiteralPath $gitMarker -Force).PSIsContainer
    if ($isLinkedWorktree) {
        throw ("Refusing to start from a linked git worktree: $scriptDir`n" +
               "This is a throwaway agent/editor sandbox, so the site would serve " +
               "that copy instead of your project. Start the host from the real " +
               "project folder (the one whose .git is a directory).")
    }
}

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
# ...but derived from mediamtx.yml when that file can be read, so the pre-flight
# can never drift from the config it is protecting. It was hard-coded while
# every other value in this launcher is taken from the file, so editing
# `webrtcLocalUDPAddress` left the conflict check probing a port nothing binds:
# the guard it exists to raise went silently dead on exactly the edit it should
# have caught. The literal above stays as the fallback for a missing/unreadable
# file, which the required-file check further down then reports by name.
try {
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $udpLine = Select-String -LiteralPath $configPath -Pattern '^\s*webrtcLocalUDPAddress:\s*\S+\s*$' |
            Select-Object -First 1
        if ($udpLine -and $udpLine.Matches[0].Groups[1].Value -match ':(\d{1,5})\s*$') {
            $parsedPort = [int]$Matches[1]
            if ($parsedPort -ge 1 -and $parsedPort -le 65535) { $webrtcUdpPort = $parsedPort }
        }
    }
} catch {
    # Keep the fallback; a parse failure must not stop the launcher here.
}
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

    # The bundled ffmpeg is a WARNING, not a throw, because a plain RTMP H.264
    # broadcast plays fine without it — the bridge is only needed for the
    # complementary renditions and for AV1/WHIP sources. It is checked anyway
    # because ffmpeg_win/ is GITIGNORED: it exists in the main checkout and is
    # absent from every git worktree and fresh clone, so starting the host from a
    # worktree silently transcodes with whatever `ffmpeg` is first on PATH instead
    # of the 8.1 build this project depends on. That divergence looks like
    # "my change had no effect" or "the AV1 source stalls on the RTSP leg", and
    # nothing downstream mentions the encoder, so it is named here at startup.
    $bundledFfmpeg = Join-Path $scriptDir 'ffmpeg_win\ffmpeg-n8.1-latest-win64-gpl-shared-8.1\bin\ffmpeg.exe'
    if (-not (Test-Path -LiteralPath $bundledFfmpeg -PathType Leaf)) {
        if ($env:BRIDGE_FFMPEG) {
            Write-Host "Using BRIDGE_FFMPEG override: $env:BRIDGE_FFMPEG" -ForegroundColor Yellow
        } else {
            Write-Host 'WARNING: the bundled ffmpeg is missing, so renditions will fall back to' -ForegroundColor Yellow
            Write-Host "         whatever 'ffmpeg' is first on PATH: $bundledFfmpeg" -ForegroundColor Yellow
            Write-Host '         ffmpeg_win/ is gitignored, so it is present in the main checkout but' -ForegroundColor Yellow
            Write-Host '         NOT in a git worktree or a fresh clone. A different ffmpeg build changes' -ForegroundColor Yellow
            Write-Host '         encoder output, and 8.0 lacks the AV1 RTP depacketizer fix this project needs.' -ForegroundColor Yellow
            Write-Host '         Copy ffmpeg_win/ across, or set BRIDGE_FFMPEG, if renditions or an AV1 source misbehave.' -ForegroundColor Yellow
        }
    }

    # WHICH CHECKOUT IS ACTUALLY STARTING.
    #
    # This launcher resolves everything against its OWN directory ($scriptDir),
    # so a double-click here always starts this checkout — which is correct. The
    # trap is the opposite one: this repo has many git worktrees PLUS a main
    # checkout, every one of them carries its own copy of app.js/server.js, and
    # every port in mediamtx.yml is fixed (3000/8888/1935/8554/8889/8189). So if
    # the host is ALREADY running from a different checkout, this run fails to
    # bind and the page you are looking at is silently the other checkout's
    # code — with no symptom except "my edit did nothing".
    #
    # Printing the absolute path makes that visible in the first line, and the
    # guards below catch the machine-local assets that make a worktree a
    # strictly worse place to run from.
    $gitMarker = Join-Path $scriptDir '.git'
    $isWorktree = Test-Path -LiteralPath $gitMarker -PathType Leaf   # worktrees use a FILE, the main checkout a directory
    Write-Host ''
    Write-Host "  Starting host from: $scriptDir" -ForegroundColor White
    if ($isWorktree) {
        Write-Host '  NOTE: this is a git WORKTREE, not the main checkout.' -ForegroundColor Yellow
    }
    Write-Host ''

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
        # Name the holder. "Port 3000 is already in use" is true but useless: with
        # ~40 worktrees plus a main checkout all pinned to the same fixed ports,
        # the overwhelmingly common cause is another CHECKOUT of this same repo
        # already running, and the symptom the user reports is "my edit did
        # nothing" rather than "a port is busy". Resolving the owning process's
        # command line turns the generic message into the actual fix.
        $holder = $null
        try {
            $conn = Get-NetTCPConnection -State Listen -LocalPort $webPort -ErrorAction Stop |
                Select-Object -First 1
            if ($conn) {
                $holderPid = $conn.OwningProcess
                $holder = "pid $holderPid"
                # The command line identifies WHICH checkout holds the port, and it
                # is the entire point of the message. `OwningProcess` lives on the
                # connection, not on Win32_Process - reading it off the process is
                # why the first version printed an empty pid.
                try {
                    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $holderPid" -ErrorAction Stop
                    if ($proc.CommandLine) { $holder = "$($proc.Name) (pid $holderPid) -- $($proc.CommandLine)" }
                } catch { }
            }
        } catch { $holder = $null }
        if ($holder) {
            throw "Port $webPort is already held by: $holder`n`nThat is almost always another CHECKOUT of this repo already running (every port in mediamtx.yml is fixed). Stop it, or set PORT to a free port. The host you just launched would serve ITS OWN copy of app.js, not this one."
        }
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
# WHICH mediamtx.yml was the running instance actually started with?
        #
        # Comparing the running instance's VALUES against the file on disk cannot
        # detect a different checkout, and that is the common case on this
        # machine: this repo is checked out many times over (a main checkout plus
        # one worktree per task) and sibling worktrees usually sit on the SAME
        # commit, so their mediamtx.yml files are byte-identical and every
        # comparison above passes.
        #
        # What does NOT match is the file itself, and it matters because
        # `runOnAvailable: node "codec_bridge.js"` is a RELATIVE path resolved
        # against MediaMTX's working directory. The rendition bridge that is
        # actually transcoding is therefore decided entirely by the directory the
        # running instance was launched from, and no value comparison can see it.
        # Symptom: you edit codec_bridge.js, re-run the launcher, it reports the
        # config matches in the reassuring colour, and the change is a silent
        # no-op because the live transcoder is running a different copy of the
        # file.
        #
        # The process's own command line is the one locally available signal that
        # answers this, and the launcher already shells out to CIM for the
        # UDP-port holder, so this adds no new dependency.
        $liveConfigPath = $null
        try {
            $liveProc = Get-CimInstance Win32_Process -Filter "ProcessId=$($existing.ProcessId)" -ErrorAction Stop
            if ($liveProc -and $liveProc.CommandLine) {
                $configArg = [regex]::Matches($liveProc.CommandLine, '"([^"]+\.ya?ml)"')
                if ($configArg.Count -gt 0) { $liveConfigPath = $configArg[0].Groups[1].Value }
            }
        } catch { $liveConfigPath = $null }
        $foreignConfig = $false
        if ($liveConfigPath) {
            try {
                $liveFull = (Resolve-Path -LiteralPath $liveConfigPath -ErrorAction Stop).Path
                $oursFull = (Resolve-Path -LiteralPath $configPath -ErrorAction Stop).Path
                $foreignConfig = ($liveFull -ne $oursFull)
            } catch { $foreignConfig = $false }
        }
        if ($foreignConfig) {
            # A WARNING, not a throw, for the same reason the stale-scalar
            # warning is one: the streaming stack is already up, and refusing to
            # bring the site up beside it helps nobody. But it has to be loud and
            # name the other path, because this is the one case where the
            # launcher's own "config matches" line is actively misleading.
            Write-Warning ("The running MediaMTX was started from a DIFFERENT copy of this project: it is using '$liveConfigPath', not '$configPath'. Its runOnAvailable hook (node codec_bridge.js) is a RELATIVE path, so the codec bridge actually transcoding is the OTHER copy's. Edits to codec_bridge.js or mediamtx.yml in THIS folder have NO effect until that mediamtx.exe is stopped (Ctrl+C in its window) and this launcher starts its own. The site and tunnel are being started anyway.")
        }

        if ($configVerified -and $compared -gt 0 -and -not $foreignConfig) {
            # The scalar comparison above is blind to the whole `paths:` block
            # (its keys are indented and the reader is anchored at column 0), so
            # "config matches" has to state what it actually covers. The rendition
            # hooks live there, and they are precisely the settings a
            # codec-bridge edit depends on.
            Write-Host "Reusing the running MediaMTX instance (PID $($existing.ProcessId)); top-level config matches mediamtx.yml ($compared scalar keys compared). Path-level settings under 'paths:' -- including runOnAvailable/runOnUnavailable, which launch codec_bridge.js -- are NOT compared." -ForegroundColor Cyan
        } elseif ($foreignConfig) {
            Write-Host "Reusing the running MediaMTX instance (PID $($existing.ProcessId)); it belongs to a DIFFERENT copy of this project (see the warning above)." -ForegroundColor Yellow
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
