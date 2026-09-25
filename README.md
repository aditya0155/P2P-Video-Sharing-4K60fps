# Rydius Stream

Rydius Stream runs on a Windows laptop. OBS publishes to MediaMTX on the same machine, and the browser player receives the stream over WebRTC. Tailscale Serve provides a private HTTPS link to invited devices, so the host does not need router port forwarding or a separate web host.

## Requirements

- Windows 10 or 11, with Node.js 18.17 or newer.
- Tailscale on the host and each viewer device. Each viewer must be a member of the host's tailnet and connected while watching.
- OBS Studio on the host.
- The included Windows amd64 MediaMTX executable and its license are in `mediamtx_win/`.

## Start the host

1. Install and connect Tailscale on the laptop. Confirm it is online with `tailscale status`.
2. Double-click `start_host.bat` and keep its window open. The launcher validates the MediaMTX configuration, starts MediaMTX, then starts the web page and WebRTC proxy.
3. Check the existing Tailscale Serve setup in PowerShell. If it does not already proxy to `http://127.0.0.1:3000`, enable it once:

   ```powershell
   & "C:\Program Files\Tailscale\tailscale.exe" serve status
   & "C:\Program Files\Tailscale\tailscale.exe" serve --bg 3000
   & "C:\Program Files\Tailscale\tailscale.exe" serve status
   ```

   Run the middle command only when Serve is not already configured for port 3000. Copy the current HTTPS hostname shown by `serve status` and append `/streaming/`. Share that full URL with viewers. The hostname depends on the laptop's current Tailscale name; do not use a saved link if the device was renamed.
4. On the host, the local page is `http://127.0.0.1:3000/streaming/`.

Keep the laptop awake, online, and running the host window while streaming. Each viewer receives media from the laptop, so the hotspot's upload usage grows with the number of viewers.

## OBS setup

For a video-only RTMP stream, set **Settings → Stream → Service** to **Custom**:

- **Server:** `rtmp://127.0.0.1:1935/live`
- **Stream key:** leave empty

Set **Settings → Video → Common FPS Values** to `60` for 60 FPS. For 1080p, use a 1920×1080 output. In **Settings → Output → Streaming**, use H.264, CBR, and a 2-second keyframe interval. Start around 5000 Kbps and adjust to the laptop's sustained upload and the number of viewers.

To include audio in browser playback, publish with OBS **WHIP** instead of RTMP:

- **Service:** WHIP
- **Server:** `http://127.0.0.1:8889/live/whip`
- **Bearer token:** leave empty

WHIP sends Opus audio, which the browser WebRTC player can play. RTMP/SRT ingest uses AAC, which MediaMTX does not convert for WebRTC readers; those paths provide video without sound.

## Project files

- `index.html`, `style.css`, `app.js`: browser player and interface.
- `server.js`: local site server and same-origin proxy to MediaMTX.
- `mediamtx.yml`: laptop-specific ingest, WebRTC, and API configuration.
- `start_host.bat`, `start_host.ps1`: Windows host launcher.
- `run_tests.py`, `js_checks.js`: project checks.
- `mediamtx_win/`: the Windows MediaMTX binary and its upstream license.

Local credentials, generated tunnel configuration, certificates, logs, downloaded archives, and legacy VPS files are excluded from Git. The stream does not need Cloudflare credentials for Tailscale access.

## Run project checks

From the project directory, run:

```powershell
python run_tests.py
```

Node.js must be on `PATH`; the MediaMTX contract checks use the included Windows binary.
