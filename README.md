# Rydius Stream

Rydius Stream is hosted on a Windows laptop. OBS publishes to MediaMTX locally, and the browser receives video over WebRTC. **Cloudflare Tunnel is the primary public access path**: it publishes the page and WebRTC signaling at `https://stream.rydius.in` without router port forwarding or a separate web host. WebRTC carries media directly when the viewer's network allows it; optional Cloudflare TURN credentials provide a relay fallback.

Tailscale Serve is an optional private fallback. Viewers using it must join the host's tailnet and keep Tailscale connected.

## Requirements

- Windows 10 or 11 and Node.js 18.17 or newer.
- OBS Studio on the host laptop.
- A Cloudflare account with `rydius.in` managed in Cloudflare DNS for the public link.
- Tailscale on the host and viewer devices only if using the private fallback.
- The Windows amd64 MediaMTX executable and upstream license are included in `mediamtx_win/`.

## One-time Cloudflare setup

Run `setup_cloudflared.ps1` from PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup_cloudflared.ps1
```

The script downloads `cloudflared.exe` into the ignored `cloudflared_win/` folder if needed, authorizes it for the Cloudflare zone, creates or reuses the `rydius-stream` tunnel, and routes `stream.rydius.in` to the local site. Cloudflare Tunnel makes an outbound connection, so the laptop can be behind a mobile hotspot or CGNAT.

The script also offers optional Cloudflare TURN setup. Skip it initially: free Cloudflare STUN is configured automatically and is enough for many viewer networks. TURN is metered and may require billing details; only configure it if viewers cannot connect directly. The API credentials are stored in the ignored local `secrets.local.env` file, and the server mints short-lived relay credentials for viewers.

Generated `cloudflared_config.yml`, `secrets.local.env`, and `cloudflared_win/` are machine-local and must not be committed. `cloudflared` does not auto-update on Windows; update its local executable manually when desired.

## Start the host

1. Double-click `start_host.bat` and keep its window open. It validates `mediamtx.yml`, starts MediaMTX, starts the Cloudflare Tunnel if setup is complete, and then starts the local website and WebRTC signaling proxy.
2. On the laptop, open `http://127.0.0.1:3000/streaming/` to check the page.
3. Share **`https://stream.rydius.in/`** with viewers. No Tailscale install is needed for this public link.

Keep the laptop awake, online, and running the host window while streaming. The page and signaling pass through Cloudflare Tunnel; WebRTC media typically travels directly between the laptop and each viewer. Hotspot upload usage grows with viewer count and bitrate.

## OBS setup

For a video-only RTMP stream, set **Settings → Stream → Service** to **Custom**:

- **Server:** `rtmp://127.0.0.1:1935/live`
- **Stream key:** leave empty

Set **Settings → Video → Common FPS Values** to `60` for 60 FPS. For 1080p, use a 1920×1080 output. In **Settings → Output → Streaming**, use H.264, CBR, and a 2-second keyframe interval. Start around 5000 Kbps, then adjust to the laptop's sustained upload and number of viewers.

To include audio in browser playback, publish with OBS **WHIP** instead of RTMP:

- **Service:** WHIP
- **Server:** `http://127.0.0.1:8889/live/whip`
- **Bearer token:** leave empty

WHIP sends Opus audio, which the browser WebRTC player can play. RTMP/SRT ingest uses AAC, which MediaMTX does not convert for WebRTC readers; those paths provide video without sound.

## Optional private Tailscale access

If the public hostname is unavailable, the host can expose the site to its tailnet. Check the current mapping first; run `serve --bg 3000` only if Serve is not already proxying to `127.0.0.1:3000`:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" serve status
& "C:\Program Files\Tailscale\tailscale.exe" serve --bg 3000
& "C:\Program Files\Tailscale\tailscale.exe" serve status
```

Share the current HTTPS hostname shown by `serve status` with `/streaming/` appended. Each viewer must be a member of the same tailnet and keep Tailscale connected.

## Project files and checks

- `index.html`, `style.css`, `app.js`: browser player and interface.
- `server.js`: local website, signaling/API proxy, and optional TURN credential minting.
- `mediamtx.yml`: local OBS ingest, WebRTC, and API configuration.
- `start_host.bat`, `start_host.ps1`: Windows host launcher.
- `setup_cloudflared.ps1`: one-time public tunnel setup.
- `run_tests.py`, `js_checks.js`: project checks.
- `mediamtx_win/`: Windows MediaMTX binary and its license.

Run project checks from PowerShell with `python run_tests.py` (Node.js must be on `PATH`). The MediaMTX contract checks use the included Windows binary.
