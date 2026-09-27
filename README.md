# Rydius Stream: laptop host

This setup runs OBS and MediaMTX on the same Windows laptop. The page and WebRTC signaling are served locally and published at **https://stream.rydius.in** through a Cloudflare Tunnel, so viewers just open a link — no Tailscale install, no account. Video for viewers that cannot reach the laptop directly relays through Cloudflare TURN. OBS video enters through loopback, so it does not use the hotspot upload until viewers connect. Tailscale Serve remains as a verified fallback.

## One-time setup

1. Run `setup_cloudflared.ps1` once in this folder. It authorizes `cloudflared` for the `rydius.in` zone (one browser step), creates the named tunnel `rydius-stream`, writes `cloudflared_config.yml`, points `stream.rydius.in` at the tunnel, and offers an **optional** Cloudflare TURN key (Dashboard → Realtime → TURN → *Create TURN key*; docs: https://developers.cloudflare.com/realtime/turn/generate-credentials/). TURN is metered (free 1,000 GB/month) and the dashboard may require a payment method — **skip it if you have no card**: remote viewing still works through the free STUN punch-through path, and the key can be added later by rerunning the script. If you add one, it + the API token land in `secrets.local.env`, which stays on this laptop — browsers only ever receive short-lived credentials minted by `server.js`.
2. Tailscale fallback (optional): install Tailscale on this laptop and each viewer device and sign in to the same tailnet. The first `tailscale serve --bg 3000` run may print a consent link that the tailnet admin must approve; confirm the private HTTPS hostname with `tailscale serve status`, then give viewers that URL with `/streaming/` appended.

`cloudflared_config.yml` and `secrets.local.env` are machine-local — do not share them. Rerunning `setup_cloudflared.ps1` is safe; it reuses the existing tunnel and DNS record.

## Start a stream

1. Double-click `start_host.bat` and leave its window open. It validates the MediaMTX config, starts MediaMTX, starts the Cloudflare tunnel (when configured), then starts the website and WebRTC signaling proxy.
2. In OBS, open **Settings → Stream**, select **Custom...**, set the server to `rtmp://127.0.0.1:1935/live`, and leave **Stream Key** empty.
3. Start OBS streaming. On the laptop, check `http://127.0.0.1:3000/streaming/`; remote viewers open `https://stream.rydius.in`. A tailnet viewer can also use the Tailscale URL.
4. Stop the host by pressing Ctrl+C in the launcher window. The launcher then stops the MediaMTX process it started.

Start with CBR and a 1-second keyframe interval (2s doubles each keyframe burst and doubles how long packet-loss recovery waits for the next IDR — both read as viewer stutter). Choose a bitrate below the hotspot's sustained upload rate and leave roughly 25% headroom. A hotspot may vary over time, so 4K/60 quality and latency depend on the measured upload and the viewer's connection.

## Codecs: H.264 + AV1 on the GPU (automatic renditions)

Every broadcast is served in **both codecs at once**, so no viewer is ever blocked by codec support and AV1-capable viewers use the least bandwidth:

- OBS publishes **either** NVENC H.264 **or** NVENC AV1 (both are hardware encoders on the RTX 4070). **For a mixed audience, broadcast H.264 via WHIP** — see the known limitation below. Use NVENC AV1 only when every viewer's browser decodes AV1.
- `codec_bridge.js` runs as a MediaMTX `runOnAvailable` hook on `live`. It reads the source over loopback RTSP (TCP transport — UDP loopback bursts can reorder packets) and publishes the complementary rendition with NVENC:
  - AV1 source → `live-h264` (`h264_nvenc`, default 6000k) so legacy browsers keep playing;
  - H.264 source → `live-av1` (`av1_nvenc`, default 3000k) so AV1 browsers save ~50% bandwidth per viewer.
- **Known limitation — fixed by the bundled ffmpeg:** an OBS **WHIP AV1** source cannot be bridged by **ffmpeg 8.0** (the system PATH version here). Its AV1 RTP depacketizer filters packets until it recognizes a keyframe via the aggregation header's N bit, and fragmented keyframes whose OBU size field is kept (libwebrtc does this) never reassemble — the reader loops forever on "AV1 RTP packet before keyframe / Unexpected fragment continuation" (CPU and NVDEC decode hang identically; the stall is upstream of decode). Fixed upstream by ffmpeg commit `d12791ef`, shipped in **8.1+**. The project therefore bundles **ffmpeg 8.1.3** in `ffmpeg_win/` and the bridge prefers it automatically (an explicit `BRIDGE_FFMPEG` still wins; the system PATH is the fallback) — verified: the bundled build bridges WHIP AV1 sources to a healthy `live-h264` in ~2.4s. As a safety net, a rendition that carries no video within 20s gets its transcoder killed and retried, and after repeated failures the bridge gives up with a clear console message. AV1-capable viewers are always unaffected (they play the native path); the player tells legacy viewers explicitly when a broadcast is AV1-only.
- The rendition pipeline is tuned for the receiver: NVENC runs `tune=ull` (ultra low latency: no lookahead) with ~**0.5-second** forced-IDR keyframes (`BRIDGE_GOP_SECONDS`, default 0.5) — the interval is a wall-clock target derived from the source's probed fps, and `-maxrate`/`-bufsize` cap the rate so joining viewers and packet-loss recovery lock on fast, the FLV muxer writes packets as they arrive (`-max_interleave_delta 0`, so a slow first keyframe can no longer stall the publish into MediaMTX's publisher timeout), and video decodes on NVDEC (`h264_cuvid`/`av1_cuvid`) when available so the CPU stays free for OBS capture. **Measured, not assumed:** halving the keyframe interval from 1s to 0.5s costs *nothing* in total bandwidth (9136 KB vs 9139 KB over 12s of 1080p60 at 6 Mbps — within 0.15%; the rate controller pays for the extra IDRs out of P-frame quality) and raises the 100ms peak by only ~8%, while the worst-case freeze after a lost keyframe halves. That matters more than usual here because **there is no PLI path from MediaMTX back to the bridge's ffmpeg over the RTMP publish leg** — the only recovery from a lost IDR is the next IDR already in the stream, so the keyframe interval *is* the entire recovery budget. Note also that `-maxrate`/`-bufsize` are **guidance to NVENC, not hard ceilings**: measured 1.08x of target over 1s windows on well-fed content, but 2-11x on pathological high-entropy input, because with lookahead disabled the only real ceiling is max-QP. Do not describe the peaks as bounded. A decoder that crash-loops twice is recorded in a temp state file for 24h — later broadcasts start directly on CPU decode — and a healthy 30s+ GPU run clears the record.
- The player picks the path per browser on every status poll: AV1 sources go native to AV1 browsers whose Media Capabilities probe says AV1 decodes smoothly (software decoders wait for `live-h264` like a legacy browser) and through `live-h264` for the rest; H.264 sources ride `live-av1` only when `navigator.mediaCapabilities.decodingInfo(type:"webrtc")` says AV1 decodes **smoothly** on this device (capability lists include software decoders, which stutter at high resolution), otherwise it stays on the hardware-decodable H.264 path. While the fallback rendition is still spinning up (~2–4 s after OBS starts) the player shows *connecting* instead of a false offline, and if it never appears the viewer is told why.

Verified end to end on this machine (MediaMTX v1.21.1 + ffmpeg 8.0 + a real browser player): both bridge directions produce ~58 fps renditions read back over RTSP with zero timestamp errors, a 1920×1080 WHIP broadcast plays in the browser at 58–61 fps measured by the player HUD, the hook starts and stops with the source, `runOnUnavailable` kills any leftover ffmpeg (PID-file guard with a command-line match, so a recycled PID is never killed by mistake), and `/live/whep`, `/live-h264/whep` and `/live-av1/whep` all answer WHEP preflights. RTSP exists only for this bridge and is bound to `127.0.0.1:8554`; RTMP cannot serve AV1 out of MediaMTX, which is why the bridge reads via RTSP.

Tunables (optional environment variables, defaults match `mediamtx.yml`): `BRIDGE_H264_BITRATE` (6000k), `BRIDGE_AV1_BITRATE` (3000k), `BRIDGE_AUDIO_BITRATE` (160k), `BRIDGE_FFMPEG` (explicit override; defaults to the bundled `ffmpeg_win/` 8.1 build when present, else ffmpeg on PATH), `BRIDGE_GOP` (keyframes in frames — skips the frame-rate probe), `BRIDGE_FFPROBE` (ffprobe binary for the probe; defaults to the one next to the bundled ffmpeg).

When you raise the OBS bitrate, raise `BRIDGE_H264_BITRATE`/`BRIDGE_AV1_BITRATE` along with it: the renditions are fixed-rate, so AV1-capable viewers on an H.264 source keep receiving the `live-av1` rendition (default 3000k) no matter how high the source bitrate goes — otherwise the extra source quality never reaches them. **This default is worth raising.** Measured against a 12 Mbps H.264 1080p60 source: the AV1 rendition at 3000k scores SSIM 0.955 / PSNR 32.8 dB, at 5000k 0.965 / 34.1 dB, and at 6600k (55% of source) 0.971 — while AV1 at 3000k still beats H.264 at 3000k by +3.9 dB *and* is 7% smaller, so AV1 buys roughly 45% efficiency here. That means modern AV1 viewers are receiving roughly **half** the effective quality of legacy H.264 viewers, which is backwards: they have the newer hardware. A live OBS profile running 1080p30 at 25 Mbps into a 3000k AV1 rendition is an 8.3x downshift; AV1 does not buy 8x. Latency is not a constraint for this project, so there is no reason to keep the rendition starved.

**Audio:** RTMP and SRT carry AAC, which MediaMTX cannot convert for WebRTC readers — but the bridge now rescues it. Whenever the source audio is not Opus, `codec_bridge.js` emits a **second output** from the same ffmpeg process (H264 sources: a `-c:v copy` rendition at zero extra GPU cost; AV1 sources: an NVENC AV1 encode) with the audio re-encoded to Opus, and the player routes **every** viewer of such a broadcast to that full-quality, full-sound rendition instead of the muted native path (`live`). WHIP remains the best ingest (Opus natively, so the native path already carries sound and AV1 browsers keep the bandwidth-saving `live-av1` rendition), but an RTMP broadcast is no longer silent: viewers get video **and** audio with no OBS settings change. The bridge also re-reads the source track list after every ffmpeg restart, so an OBS auto-reconnect with a *different* encoder (H.264 ↔ AV1) re-plans the renditions instead of crash-looping on the stale plan.

## Connection notes

Two Cloudflare pieces do different jobs, and neither requires a credit card for the primary path:

- **Cloudflare STUN (free, no account, no card)** — both MediaMTX and the player receive `stun.cloudflare.com:3478` from the config and `/stream-api/turn`, so each side learns its public address and hole-punches a direct UDP path. Verified from this hotspot with a real binding request (a public mapped address came back). This is how remote viewers connect without any paid Cloudflare product.
- **Cloudflare Tunnel** (free) carries the HTTPS page and WebRTC/WHEP signaling from `stream.rydius.in` to `server.js`. It dials outward only, so it works behind the hotspot's CGNAT without port forwarding — but it does not carry video UDP.
- **Cloudflare TURN** (optional — metered, may require a payment method even for the free 1,000 GB/month) is the relay fallback for a viewer whose network refuses hole punching. `server.js` mints short-lived credentials at `/stream-api/turn` (the API token stays server-side) and appends them only when configured; Google STUN and browser-blocked port-53 URLs are stripped everywhere. If TURN is unavailable, a viewer behind a strict NAT may not connect — that is what the Tailscale fallback is for.

MediaMTX configures Cloudflare STUN only — Google STUN was historically unreliable from this network and stays out. Hole punching is the primary remote path; TURN relay (when configured) is the fallback, and Tailscale covers the rare viewer behind a strict NAT.

With the Tailscale fallback, WebRTC media travels over the tailnet; `tailscale ping <laptop-name>` from a viewer device shows whether the path is direct or relayed. **ICE-TCP is deliberately off** (`webrtcLocalTCPAddress: ""`, MediaMTX's own default, and its shipped reference says why: *"TCP is less efficient than UDP and introduces a progressive delay when network is congested"*). This project's media is DTLS-SRTP, so a negotiated TCP candidate inherits head-of-line blocking — one lost segment stalls all subsequent video until RTO expiry, turning a ~20 ms UDP jitter blip on a lossy hotspot into a 200–600 ms hard freeze. Muxing it on the same port as UDP also lets a viewer whose network throttles UDP win nomination onto that worse path with nothing in the UI to say so. Tailscale carries the tailnet over UDP itself (with DERP as *its* fallback), so a tailnet that can reach the laptop can almost always reach 8189 over UDP. If a viewer genuinely cannot do UDP, give them TURN (`secrets.local.env` → `/stream-api/turn`) instead — TURN/UDP is not head-of-line blocked. If ICE-TCP is ever re-enabled, put it on a **separate** port, never multiplexed onto 8189.

SRT and WHIP ingest entries in the page are optional alternatives for OBS running on this laptop. The standard setup is RTMP to loopback. The MediaMTX config and binary are kept in the project so the host can start without a VPS.

## Local checks

Run `python run_tests.py` from this folder (Node.js must be on PATH). The suite covers:

- **Page integrity** — unique element IDs, every `querySelector` target in `app.js` exists in `index.html`, every `/streaming/...` asset is in the `server.js` allowlist and shares one cache version.
- **Cross-file consistency** — RTMP, SRT, WHIP, RTSP and control-API ports must agree between `mediamtx.yml`, `index.html`, `server.js` and `start_host.ps1`.
- **Codec bridge** — `codec_bridge.js` must be present and parseable, its default ports must match `mediamtx.yml` (RTSP/RTMP/API), the config must bind RTSP to loopback and declare both rendition paths with the `runOnAvailable`/`runOnUnavailable` hooks, and the bridge direction matrix must map AV1→`live-h264` / H.264→`live-av1` with GPU encoders, Opus-preserving audio and B-frames off.
- **The `/stream-api` proxy** — request forwarding (path, query, body, Host), `Location` rewriting for same-origin redirects only, CORS exposure of `Location`, `/stream-api/v3/**` routed to the control API port, 404 pass-through, `no-store` on proxied answers, and 502 with a clear message when MediaMTX is down.
- **TURN credential proxy** — `/stream-api/turn` always serves the free Cloudflare STUN entry even without Cloudflare configuration, mints through a stubbed Cloudflare API using the server-side `Authorization` header when configured, strips Google STUN and browser-blocked port-53 URLs, caches one mint for the whole room, backs off after failures, and never exposes the token to a browser.
- **Static server hardening** — HEAD without a body, 405 with `Allow: GET, HEAD`, host source files never served, invalid `PORT`/`MEDIAMTX_*_PORT` rejected at boot.
- **Browser logic** (`js_checks.js`) — runs the real `app.js` functions in Node: SDP tuning (bandwidth ceiling, `rtcp-fb` lines scoped to the video section, idempotence), status polling and reconnect backoff, disconnect cleanup, the latency-mode table (plus persistence of a manual choice), windowed playout-delay measurement (the drift-detection ground truth — cumulative `jitterBufferDelay` averages hide fresh drift within seconds), AV1 capability detection, and the rendition path matrix (`live` / `live-av1` / `live-h264` selection per browser codec support).
- **MediaMTX contract** — boots the bundled MediaMTX on free ports and checks `GET /v3/paths/list` reports the `live` path state, `OPTIONS /live/whep` answers 204 with no publisher (which is why the player never probes liveness with OPTIONS), and WHEP session creation fails fast without one.
- **Receiver-lag fixes** — the player fetches Cloudflare-STUN-plus-optional-TURN ICE config, the WHEP POST is time-bounded, the adaptive buffer supervisor stays wired into the stats loop (and sleeps while the tab is hidden, where Chrome suspends presentation and delay measurements are meaningless), sustained frame drops auto-enable Eco Mode, MediaMTX queue/UDP buffers stay tuned (per-reader queue 2048: an empty queue costs nothing on a healthy link, and on a hotspot hiccup the backlog survives instead of overflowing into lost packets that break decode), the HUD shows the measured live playout delay next to the buffer target, a manual latency choice persists across visits, a returning background tab resumes telemetry without zeroing its measurement baselines, the playout target grows with measured network jitter (a fixed target on a jitterful link turns late frames into visible drops), buffer accommodation is **drop-gated** — the target rises only while frames are actually being discarded late (measured by `framesDropped` *or* by frames that arrived but never left the jitter buffer, an independent signal the measured mean cannot hide) and the buffer has outgrown the base target, holds while Chrome sits at it (a controller that raised to meet the measured delay would chase its own tail and inflate every session to the cap), and drains 50ms per tick after sustained calm — a delay still outgrowing the cap means the session itself is stale and triggers a clean rejoin at the live edge (bounded by the switch cooldown), returning from a hidden tab measures the hidden span immediately with one fresh stats delta and feeds it to the supervisor (a hidden span inflates the buffer to seconds — but the decision to rejoin needs **three** consecutive over-cap readings, because a normal Alt-Tab measures 1.7-2.8s against a 3.1s trip point, and the in-loop path already required persistence), an ABR loop switches stressed viewers onto the low-bitrate rendition and back after 20 calm seconds (and **only** when the browser can actually decode AV1 — a legacy browser keeps its decodable full-bitrate path, since an undecodable session is strictly worse than the stutter it is escaping), the SDP offer advertises NACK/PLI/transport-cc feedback for **every** video payload type (not just H.264) so AV1/VP9 streams can retransmit lost packets and request fresh keyframes, frame drops are measured through a rolling window (GOP-periodic bursts) and against actually-rendered frames (rVFC), the viewer ICE cache respects the mint half-life, and the codec bridge runs the verified low-latency pipeline (TCP RTSP read, NVDEC decode with automatic fallback, `tune=ull`, forced IDR keyframes, rendition watchdog).
- **Host & community hardening** — the site server installs process-level resilience handlers (a stray rejected promise logs instead of killing the host mid-broadcast; startup config errors still fail fast before the handlers arm), emoji reactions are rate-limited per IP (10 per 2s, swept like chat), the live viewer count is broadcast over SSE on every join and leave and rendered in the header, and a decode-pressure loop moves a viewer whose decoder falls behind onto the hardware-decodable rendition (native AV1 → `live-h264`, the AV1 rendition of an H.264 source → native H.264).
- **Connected-but-black limbo recovery** — a session where the WHEP handshake and ICE both succeed yet no frame ever decodes (the publisher vanished between the status probe and the handshake, or the offered codec cannot decode on this device) used to hang on a black picture forever: the freeze watchdog needs bytes flowing AND at least one decoded frame, so it can never fire there. The stats loop now detects the limbo (zero decoded frames 10s after connecting) and rejoins at the live edge, capped at three attempts with a clear "broadcast may be incompatible" notice afterwards. The staged freeze recovery is bounded too — `player.play()` stays pending forever on a media-less session, so each stage's await is time-boxed and stage 2 (decoder flush) must prove it restored playback before it can skip the stage-3 full session renewal. H.265 WHIP sources are routed by real receive capability: a browser without H265 support rides the bridge's AV1 rendition instead of a native path MediaMTX would happily answer with a stream it cannot decode.
- **Connection & recovery hardening** — a `navigator.connection` interface-type change (wifi → hotspot, band switch) tears down and rejoins immediately instead of waiting for ICE failure detection; the browser's own `online` event tears down a session still sitting in ICE `disconnected` (its path belongs to a network that no longer exists, so the 2.5s self-heal grace cannot help); the ICE config is prefetched in parallel with the first status poll and the in-flight fetch is memoized so a connect never double-fetches; `RTCPeerConnection` uses a small `iceCandidatePoolSize` so reconnects gather candidates sooner; STUN/TURN failures are surfaced through `onicecandidateerror` (once per connection, also in the diagnostic export) — a network that blocks UDP STUN used to loop connecting→offline with no explanation; the volume slider no longer attenuates twice (the WebAudio graph taps the element *after* its volume property, so the old code played 50% at 25% — the multiplier now rides exactly one control); the HUD gains a **Route** row (direct hole-punch vs TURN relay — the first thing to check for a stuttering remote viewer) and the diagnostic export includes the route plus NACK/PLI recovery counters; the header shows the **live viewer count** broadcast by the server over SSE on every page join/leave; chat SSE events carry `id:` lines so an EventSource auto-reconnect replays exactly the missed messages through the server's existing Last-Event-ID support; chat dedupe sets are capped so marathon sessions cannot leak memory; ABR can step a struggling viewer down to the light rendition from the audio-rescue path too, and upgrades back to whatever the path matrix prefers (the full-sound rendition for RTMP broadcasts, not a muted native path).
- **Server hardening** — the MediaMTX proxy rides a keep-alive connection pool (warm sockets for every viewer's status probe and WHEP handshake instead of a fresh TCP connect per request), a second launcher hitting an occupied port fails with a readable message instead of an `EADDRINUSE` stack trace, the SSE broadcast applies backpressure protection (a dead tab that stops reading is destroyed instead of buffering unbounded memory), and the chat rate-limit map is swept of expired entries; every response carries an error listener so a socket write racing a disconnect can never escalate beyond the connection, static reads that fail mid-flight (Windows editor save replacing the file) cut the connection instead of crashing, and page assets are served **gzip-compressed** when the browser asks (`Accept-Encoding`) — app.js drops ~170 KB → ~40 KB, roughly 4x faster first load on the LAN/Tailscale paths (the Cloudflare tunnel already compresses), with 304 revalidation untouched.
- **Bridge stall watchdog** — the rendition watchdog now has two phases: the verified startup phase (no video within 20s → restart) plus a **mid-broadcast stall** phase driven by the control API's per-path byte counter: once video has flowed, two consecutive samples that show no new bytes reaching the published path (a hung NVENC session, a dead RTSP leg that never errors) kill and rebuild the transcoder, because MediaMTX keeps the path online either way and rendition viewers would freeze indefinitely. The signal is deliberately **not** ffmpeg's stderr: ffmpeg prints its `frame=` progress line at `AV_LOG_INFO` and the bridge runs at `-loglevel warning`, so a stderr-gated watchdog could never fire at all (measured: 0 matching lines at `warning`, present at `info`). Published bytes are also the stronger evidence — they prove output is reaching the path, not merely that a process is alive. **It must be `bytesReceived`, not `bytesSent`.** In MediaMTX v1.21.1 `bytesReceived` is `InboundBytes` (from the publisher) while `bytesSent` is `OutboundBytes` — bytes delivered to **readers**. The bridge never subscribes to its own renditions, so on a healthy source with zero viewers `bytesSent` sits at exactly 0 forever: using it inverted the watchdog into firing every ~38 s and rebuilding the transcoder, taking both rendition paths non-joinable for 4.2 s per cycle (11% of wall-clock time, forever) — and with a single viewer attached it never fired at all, so the bug was invisible exactly when somebody was testing it. Measured on a scratch MediaMTX: with 0 readers `bytesReceived` climbed 3.5 MB → 9.0 MB over 8 s while `bytesSent` stayed 0; attaching one reader made `bytesSent` advance at the full source rate.
- **Bridge resilience** — the ffmpeg failure budget is genuinely *consecutive*: a run of 30s or more clears the strike count, so ten unrelated ffmpeg exits spread over a long broadcast (one per OBS auto-reconnect, one per host stall) can no longer accumulate into a permanent `exit(1)` that kills the rendition for the rest of the broadcast. `runOnAvailableRestart: true` means a bridge that does exit is re-run. The Opus rescue re-encodes with `aresample=async=1` so a source audio clock running slightly fast cannot walk the audio timestamps progressively ahead of video and leave the browser nudging `playbackRate` forever.

## Viewer-smoothness audit

A dedicated pass looked only for things that make a viewer's picture not smooth, at every layer. Findings and fixes:

**Transport / sender**
- `udpMaxPayloadSize` is set to 1200 rather than the 1452 default. An earlier audit round claimed the default was fragmenting every packet to remote viewers (this host's Tailscale adapter reports an MTU of 1280). **That claim was measured and is false**, and both the `mediamtx.yml` comment and the regression test now record the correction: against a real 1280x720 publish read by real headless Chrome through a real WHEP session, the mean inbound video RTP packet size was 901.1–902.1 bytes at *200*, *1200* and *1452* alike — the WebRTC path does not read this key at all, it packetizes with its own ~1200-byte MTU, which fits a 1280-byte MTU comfortably. 1200 is kept because the key is honoured by MediaMTX's other RTP consumers, but it was never a fragmentation fix and there was never WebRTC fragmentation on this host.
- The launcher reused a running MediaMTX instance **without comparing its config**, so editing any tuning knob and re-running was a silent no-op — the "tuned setting that does nothing" failure mode. It now diffs the running instance's effective config against `mediamtx.yml` and refuses to start if they differ.

**Compositing (the always-on costs)**
- `.video-container` ran an infinite `border-breathe` animation on `border-color` — a paint property on the element that *is* the video, i.e. a full-video-sized repaint every frame for the whole session — plus `will-change: transform`, which is the documented way to pull a `<video>` off the hardware-overlay path. Both removed.
- Three blurred ambient orbs animated behind three `backdrop-filter` surfaces, so ~500k pixels of Gaussian blur re-ran on every decoded frame. The orbs are now static, which lets the compositor cache the blur.
- The unmute button carried a `backdrop-filter` sitting directly on top of live video, and autoplay is only permitted muted — so it was there for the entire session by default. The idle action-ripple and volume-toast overlays used `opacity: 0` only, which still keeps a render surface alive; they now use `visibility: hidden`.

**Player control loop**
- The stress-raise was a **wall-clock stamp** expiring after 15s. Simulated end to end against the extracted real functions, a continuously marginal link produced a perfect square wave — 350ms for 15s, 180ms for 7s, five target steps per minute, forever — on a link that never once went calm. Every step re-paces the browser's playout. It is now a level that is *held* while the link is stressed.
- The anti-stutter accommodation was gated on a mean computed over the frames that **left** the jitter buffer, so late-discarded frames were excluded from numerator and denominator alike. On a slow link discarding 13 frames in 60s the mean peaked at 153ms against a 330ms requirement and the target never moved once — the mechanism was blind to the exact condition it exists to catch. It now also uses an independent late-frame signal (`framesReceived` vs `jitterBufferEmittedCount`).
- The drift rejoin counted **ticks**, not measurements. Three ticks containing zero new readings satisfied the confirmation and forced a 2–4s hard teardown of a healthy session, because the reading latches through a quiet window. It now requires a fresh reading.
- Every `jitterBufferTarget` write re-paces the browser's playout, and the floor used to decay 25ms *every tick* — 24 consecutive writes after one jitter spike. Writes are now band-limited and dwell-limited, with a faster path for a raise while frames are genuinely being dropped.
- The playout target was pushed to the **audio** receiver at video scale. Per spec, synchronized tracks use the larger of the two targets for *both*, so a 2200ms video target on the audio receiver stretches audio instead of containing itself.
- Returning from a hidden tab reconnected on a **single** reading, while the periodic supervisor required three. A normal Alt-Tab measures 1.7–2.8s against a 3.1s trip point, so this could end in a hard freeze. It now requires persistence, like the loop.
- `degradationPreference` is pinned to `maintain-resolution`: the default lets Chrome trade resolution away silently, and on a live stream the picture just gets softer with nothing "lost", so no controller can see it.
- The freeze watchdog used to run its own `getStats()` on top of the stats loop's — 1.67 full graph walks per second on the low-end receivers this code protects. It now reads the loop's snapshot and rejects a stale one.
- The HUD level meter wrote `style.width` every animation frame and kept re-arming while muted. It is now sampled at ~12Hz, writes only on change, and stops when there is nothing to measure.
- Auto-Eco was permanently disabled by *any* prior toggle click, including one that left it on the expensive "Turbo GPU" setting. Only an explicit Eco choice now vetoes the relief.

**Signaling**
- `server.keepAliveTimeout` was Node's 5s default while the client polls every 5s, so pooled sockets were torn down in a race with the next request; a WHEP handshake is a POST, which browsers do not reliably retry on a reused socket. Now 65s.
- The SSE "backpressure guard" counted consecutive `write()===false` returns, which cannot happen until the kernel socket buffer is already full — measured at 6000 events (~1.2MB) producing zero false returns. It now counts bytes and marks a subscriber lagging, recoverable on `drain`.
- `x-forwarded-for` was used as a rate-limit key even when nothing rewrites it, so the per-IP reaction limit was bypassable with one header per request. Forwarded headers are now trusted only behind the tunnel.
- The 304 branch omitted `Vary: Accept-Encoding` that the 200 sets.
- Reaction rate is now capped **globally** as well as per IP, and concurrent floating emoji over the video are capped — the aggregate is per-viewer rate × viewer count, and each one is a composited layer on top of the picture.
- The chat log's autoscroll read `scrollHeight` immediately after `appendChild`, which is a forced synchronous layout — one full sidebar relayout per message, on the same thread that decodes video. It is now deferred to the next animation frame so a burst coalesces into one layout.
- Webfonts use `display=optional`. The Google Fonts sheet is cross-origin and therefore render-blocking, so with the default `swap` the fonts arrive *after* the handshake has started playback and the swap re-metrics every header/chat/HUD string — a full relayout in the first seconds of a live stream.
- The cursor-hide helper wrote the **root** element's inline style on every qualifying mousemove, while writing the same value it had already written (outside fullscreen `hide` is always false). It now skips the no-op write.

## Second-pass audit — bugs the first pass introduced, and more

A second, deeper pass ran four parallel audits over areas the first one never touched (SDP/ICE handshake, audio, long-session stability, bridge ingest) and re-verified everything the first pass shipped. It found four regressions **in the first pass's own fixes**, all now fixed and all pinned by tests:

- **`first_pts=0` destroyed A/V sync.** The first pass added `-af aresample=async=1:first_pts=0` to the Opus rescue, believing it tidied the timeline. It does the opposite: `first_pts` forces the resampler's output to begin at PTS 0, which drags the audio track onto the video track's head. Measured with the bundled ffmpeg on a source whose audio starts 279 ms after its video — an ordinary OBS audio-device offset — the shipped filter turned +279 ms into **−7 ms** (destroyed, sign flipped), while plain `async=1` preserved it at **+294 ms**. Every rendition was shipping a permanent lip-sync error, which viewers report as the video being "janky" when it is purely an audio offset.
- **The SSE backpressure guard destroyed every subscriber.** It accumulated bytes written and only reset on `drain`, which fires solely after a `write()` has returned false. A *healthy* reader never drains, never resets, and climbs forever: real payload 173 bytes, so `ceil(262144/173) = 1516` events — about 1.2 h of a busy chat — after which every viewer was disconnected at once and each auto-reconnected. Verified twice: the real payload arithmetic, and a live socket probe that pushed 20,000 events past a healthy reader with zero disconnects. The guard now reads `writableLength`, the stream's own queue depth.
- **The rendition stall watchdog rebuilt a healthy transcoder forever.** It judged liveness from MediaMTX's `bytesSent`, which is **egress to readers**, not ingest — so with nobody watching it sits at exactly 0. Measured on a scratch MediaMTX: with zero readers `bytesReceived` climbed 3.5 MB → 9.0 MB over 8 s while `bytesSent` stayed 0; attaching one reader made `bytesSent` advance at the full source rate. The watchdog therefore fired every 38.2 s, taking both rendition paths not-joinable for 4.24 s per cycle (11.1 % of wall-clock time) and never firing at all when a viewer *was* watching. It now uses `bytesReceived`, and treats a counter *decrease* (a new publisher connected) as activity rather than a stall.
- **An aborted WHEP POST could wedge the page forever.** A first-pass fix cleared `isConnecting` in the `AbortError` branch. The 16 s connect watchdog is gated on `isConnecting && !isConnected`, and only `handleDisconnected()` re-arms the status poll — so clearing the flag alone left a hung attempt with no watchdog, no teardown (PeerConnection still open, no WHEP `DELETE` ever sent) and no retry. Measured: still on "connecting" after 60 s with 1 POST, 0 DELETEs, zero pending timers. The branch now runs the real teardown.

Also fixed from the second pass:

- **The connect watchdog never covered ICE.** It was armed before signaling and cleared only on connect, so it had to cover 2.5 s ICE fetch + 3 s gather + up to 10 s WHEP POST = 15.5 s of a 15 s budget, leaving half a second for the actual connection. A remote or relayed viewer — exactly the audience the tunnel serves — that would connect at 16 s was torn down at 15 s, and every retry repeated it. LAN viewers connect in ~50 ms and never saw it. The watchdog is now re-armed after the answer to cover ICE alone.
- **The offer could be sent with no usable candidate.** The gather window was a fixed 3 s deadline. This page never calls `getUserMedia`, so Chrome mDNS-obfuscates its host candidates as `*.local`, and MediaMTX (Pion) resolves no mDNS — an offer carrying only those has nothing to connect to. A fixed deadline POSTed exactly that on the networks the code itself diagnoses as blocking UDP STUN, and cut off any `turns:` relay needing more than 3 s to allocate. It now waits for a *routable* candidate (6 s cap, 400 ms settle so follow-up candidates still ride along).
- **The `rtcp-fb` collection pass swept the whole SDP** while the injection pass was section-scoped, so a payload type also present in `m=audio` counted as "already has feedback" and the video section silently kept only what audio declared. Reproduced with a colliding fixture: video came out with `nack pli` and `goog-remb` but **no `nack`** — no retransmission at all. Chrome's payload ranges don't collide today, so this was a latent trap; both passes are now scoped identically.
- **The adaptive buffer walked itself to its cap while paused.** With the new late-frame signal (`framesReceived` vs `jitterBufferEmittedCount`), a paused viewer satisfies it *permanently* — packets keep arriving, nothing leaves the jitter buffer — so the target ratcheted to 2200 ms in 50 ms steps, ~44 writes each re-pacing playout, and resumed into a long slow-motion catch-up. The supervisor now bails on `player.paused`, as the freeze watchdog and audio meter already did.
- **`onicecandidateerror` was missing from the teardown list**, so a candidate error from a gathering pass still in flight posted a chat warning after the offline banner for a session that no longer existed.
- A suspended `AudioContext` after `createMediaElementSource` is wired left **permanent silence** — the gesture listeners that would rescue it had already removed themselves. There is now an `onstatechange` recovery. (A suspended context does *not* stall the video: the media element has its own clock, which is why this was invisible in the video path.)
- `playSfx` created an `OscillatorNode`/`GainNode` pair per call and disconnected neither — 400 nodes from 200 calls, each a connected subgraph anchored on the destination. It now disconnects on `end` and caps concurrent voices at 6.
- A WebAudio `resume()` on the ordinary autoplay path had no `.catch()`, so it rejected unhandled for every viewer who connected without clicking.
- The wheel handler wrote `player.volume` immediately before `setMasterGain`, which sets it straight back — two `volumechange` events per notch, each fanning out to overlay style writes.

### Corrections to earlier claims

- **The IP-fragmentation claim was wrong and is retracted.** The first pass asserted MediaMTX's 1452-byte `udpMaxPayloadSize` default was fragmenting every packet to remote viewers because this host's Tailscale adapter reports an MTU of 1280. Measured A/B with a real 1280×720 publish read by real headless Chrome through a real WHEP session: the mean inbound video RTP packet size was **901.1–902.1 bytes at 200, at 1200 and at 1452 alike**. The WebRTC path does not read that key at all — it packetizes with its own ~1200-byte MTU, which fits 1280 comfortably. There was never fragmentation on the WebRTC path. The value stays at 1200 because the key is honoured by MediaMTX's other RTP consumers, but the config comment and the regression test now record the correction.
- **The rendition GOP measurement is stale.** The bridge now derives its keyframe interval from a probed frame rate (`gopSeconds()`), so the old "exactly 1.000 s, verified with `trace_headers`" no longer describes the shipped default.

Run a single check with `python run_tests.py JsLogicChecks.test_sdp_advertises_exactly_one_video_bandwidth_ceiling`; `node js_checks.js --list` prints the browser-logic cases.

## Third-pass audit — controller bugs, compositing, and the transport budget

Six disjoint audits (playback core, stats/watchdog, session lifecycle, bridge, rendering, transport) plus direct measurement with the bundled ffmpeg and against the live MediaMTX. The theme of this round: **guards that were supposed to bound a controller were not bounding it**, in both directions — they either never fired, or fired unconditionally.

### The buffer accommodation climbed to its cap on any real link
`bufferAccommodationMs()` compared the measured delay against `baseBufferTargetMs()`, which *deliberately excludes* `accommodationTargetMs`. So once Chrome converged on a granted target, `delay > base + 150` stayed permanently true and every drop-tick re-granted `delay + 100`: simulated against the real function, 180 ms → 2200 ms in 19 ticks, ~11 of which cleared the band/dwell gates and became real `jitterBufferTarget` writes — **~1.1 s of frozen picture in the first 20 s of any rough session**, since a write above the filled level makes Chrome *hold* frames. The drop-gate that was supposed to prevent exactly this only ever stopped the climb for the no-drops case. The raise now references the level **already granted**, never the bare base, and can never return less than it held (it used to collapse 2200 → 500 in one tick). A genuinely larger measured need still raises. Pinned by `js_checks.js buffer-accommodation-gate`.

### The stress raise was released as one 170 ms step
`adaptiveRaiseLevelMs` went 350 → 0 in a single tick, and a *downward* `jitterBufferTarget` is precisely what makes Chrome **discard** frames to reach the new level — 170 ms of frames, 5 dropped at 30 fps, on every stress→calm transition. It was the largest move in the system and the only one with no ramp, while the jitter floor decayed in 25 ms steps and the accommodation in 50 ms. It now releases in 50 ms steps, each with its own calm window.

### The dead band reset both accumulators, so marginal links got no protection at all
`stressRunSec` needs 3 consecutive stressed ticks and `abrBadSec` needs 8, but the ambiguous band (jitter 25–55 ms, **or loss 0.8–2.5 %**) zeroed *both*. A link stressed 2 ticks in 3 could therefore never cross either threshold — and the jitter floor, the only other absorber, is driven by jitter alone, so a lossy-but-not-jittery link (3 % loss, 20 ms jitter — ordinary congested Wi-Fi) reports *low* jitter and got no buffer at all. The band now **holds** rather than resets; each branch still zeroes the other counter on a genuine transition, and the two are mutually exclusive, so nothing leaks. Same fix applied to the ABR pair.

### Transport loss was being charged to the decoder
`framesDiscarded` was read **nowhere in the repository**. The decode-pressure ratio used `framesReceived`, which counts every frame handed to the jitter buffer *including* ones the decoder then dropped — so a lossy link, a problem the buffers already absorb, looked exactly like a struggling decoder and fired a full session teardown (2–4 s black) with the message *"this device's decoder can't keep up"*. The ratio is now `(decoded + discarded) / received`. The old `[0.70, 0.90)` dead band also meant a decoder stuck at 83 % of arrivals — a permanently stuttering picture, the exact case the hardware-path switch exists for — never accumulated at all; the band is now `[0.85, 0.98)`. Pinned by `js_checks.js decode-lag-state-machine`.

### Two guards that were dead code
- The tab-return re-baseline flag was consumed ~100 lines before its second read, so the hidden-span guard **never ran** — the exact damage its own comment describes. Captured once and used for both reads.
- `noMediaRejoinCount` was reset by the very function every rejoin re-entered, so it could never exceed 1: the cap of 3 and the "broadcast may be incompatible" notice were **unreachable**, and a permanently black broadcast looped a full teardown + reconnect + a chat message every ~11 s, forever. The budget is now per-*broadcast* (restored by the `decoded > 0` branch), not per-session.

### `connectStream` had no generation token
The function read the module-global `peerConnection` after every await, including a 3 s ICE-gather window that teardown could not cancel. A torn-down attempt therefore kept running and then operated on the **next** attempt's connection: reproduced with the real extracted function, a stale continuation woke at 3.0 s and tore down a *healthy* 1.9 s-old peer connection, and a second WHEP POST went out carrying the new pc's SDP — two MediaMTX reader sessions for one viewer, with `whepSessionUrl` overwritten so the orphan could never be `DELETE`d. The pc is now bound locally with an identity check after every await, the gather timer is module-scoped and cancelled on teardown, and a superseded answer releases the reader it just created.

### Every rendition switch was a guaranteed 2–4 s black screen
`switchRendition` is the single choke point for *all* path changes (ABR steps, the limbo rejoin, the drift rejoin, the decode-pressure hop), and teardown nulled `player.srcObject` before the replacement existed. Simulated against the real thresholds that is **21–30 s of hard black per 10-minute session** (3.5–5 %) on any link that alternates stressed/calm — i.e. every hotspot and tailnet. The element is now left attached: the ended track freezes on the **last decoded frame** instead of going black, and the replacement track swaps in when it arrives. A 12 s safety net forces a real reconnect if no track ever lands. A paused viewer is also no longer silently force-resumed, and the paused state now stops the controllers that can rebuild the session (RTP keeps arriving while paused, so loss and jitter look "stressed" forever — the same 44-write walk the second pass fixed for the buffer was still reachable through the ABR path).

### MediaMTX could spend 7 s of the 10 s handshake budget gathering STUN
`webrtcSTUNGatherTimeout` was left at its 5 s default, **nested inside** the 10 s `webrtcHandshakeTimeout` alongside a 2 s track gather — 7 of 10 seconds before MediaMTX writes a single byte of the SDP answer, while the player aborts its own WHEP POST at 10 s. A single UDP binding request costs 20–80 ms on a healthy uplink, so 2 s is ~25× the real cost. The failure mode was not stutter, it was **permanent remote-viewing failure**: on a STUN timeout the answer comes back with no srflx candidate, leaving only host addresses (the hotspot LAN and Tailscale `100.x`) that are unreachable from the internet, and the client watchdog loops forever. This host's uplink is a phone hotspot already saturated carrying the video — exactly the condition under which a STUN binding is slow.

### A host stall disconnected the entire room
`readTimeout`/`writeTimeout` sat at 10 s. They are inert for WebRTC *readers* (a reader is a Pion PeerConnection, not a byte stream with read deadlines) — they bound the **publishers**, and the RTMP publisher is on loopback, so 10 s of silence there cannot be blamed on the network: it means the publisher process itself stopped running. At 10 s, `live` flips to not-ready and hard-disconnects **every** viewer for a 2–4 s re-WHEP. Now 20 s; a genuinely crashed publisher still exits immediately on EOF.

### The launcher's stale-config guard covered 4 of 23 knobs
`start_host.ps1` diffed `writeQueueSize`, `udpReadBufferSize`, `udpMaxPayloadSize` and `logLevel` against the running instance and refused to start on a mismatch — but `readTimeout`, `webrtcSTUNGatherTimeout`, `webrtcLocalTCPAddress`, the rtsp/rtmp/srt addresses and every `paths:` key were unchecked. Every tuning fix landed as a **silent no-op** on any machine that already had MediaMTX running, which is the normal case. The guard is now driven by the keys `mediamtx.yml` itself declares (23 compared today, booleans normalised so `yes` no longer false-mismatches the API's `True`, non-scalar values skipped rather than false-flagged). The launcher also probes **UDP 8189** — the port every viewer's video flows through, which a `TcpClient` check is structurally unable to see — with an error that names the port, and runs MediaMTX at `AboveNormal` so OBS capture and NVENC threads cannot preempt the per-reader write path.

### Compositing: the always-on costs
- `.telemetry-hud` had `backdrop-filter: blur(20px)` with the **live video in its backdrop**, present the entire time the stream plays. A full-width 20 px Gaussian blur over a 1080p layer is ~2.07 M pixels re-read per frame (~124 M/s at 60 fps) while the browser is trying to present a new frame in the same compositor. Replaced with an opaque panel.
- `.player-controls` was hidden with `opacity: 0` only, leaving the layer in the render tree; it now leaves it entirely. Because `visibility: hidden` also unfocuses descendants, the control bar is additionally pinned while focus is inside it, so the bar can never fade out from under a focused control.
- `.noise-overlay` was a permanent full-viewport composited layer; the grain now lives under the video where it is invisible during playback.
- The HUD audio level meter animated `width` (a layout property) at ~12 Hz plus ~6 interpolated relayouts/s; it is now a compositor-only `transform: scaleX()` driven by a custom property.
- Theatre mode nested a scrolling container inside a scrolling ancestor (phantom inner scrollbar on desktop, a nested compositor drag on touch); it now has a single scrollport.

### Device capability: Eco Mode missed the viewers that need it
The low-end heuristic was `hardwareConcurrency <= 4`, but a current iPhone (A14+) reports **six** cores, so every modern iPhone sailed past it and ran the full blur/blur/animated-noise stack. It also *overrode an explicit "Turbo GPU" choice*, because the guard read `!== '1'` and so treated "Turbo" as "no choice" — the opposite of what its own comment promised. Eco is now restored from an explicit stored choice in both directions, and the no-choice path uses `deviceMemory`, core count and a coarse-pointer check.

### What measurement refuted
Recording these so they are not "fixed" later:
- **Tightening the VBV made pacing worse.** `bufsize` 6000k → 1500k raised the 100 ms peak from 10.61 to 11.17 Mbps and cost 3.7 % total bitrate. The existing `-maxrate`/`-bufsize` pair is already correct.
- **Averaging over a longer keyframe window changes nothing in total bandwidth** (see the pipeline section above) — the win from 0.5 s is halved freeze time, not bandwidth.
- **`av1_nvenc` already defaults to 8-bit `yuv420p`** and `rc-lookahead` already 0; the default vsync does **not** duplicate or drop frames on this FLV output (75-in/75-out on a VFR source). Three plausible smoothness bugs, all absent.
- **`tune=ull` vs `hq` vs `ll` is byte-identical** at these settings — the rate control is saturated, so the tuning profile is inert.

## Fourth-pass audit — closing the receiver measurement loop

The first three passes made the *control* side of the receiver careful (delta-based
measurement, hysteresis, dwell, a drop-gated accommodation, a video-only playout write).
What none of them could do was **observe the result of its own writes**. Five signals
that decide whether a viewer sees lag, drift, dropped audio or a "speeded-up" picture
were either never read or read under the wrong name. Every spec claim below was checked
against the W3C WebRTC-PC and WebRTC-Stats Recommendations rather than from memory;
the audit notes, the spec quotes and the sources are in `_research/`.

### The write is a hint, and nothing ever read back what it produced

`RTCRtpReceiver.jitterBufferTarget` is the only standardized playout-delay control
(WebRTC-PC: `attribute DOMHighResTimeStamp? jitterBufferTarget`, milliseconds, and
"If target is negative or larger than 4000 milliseconds, then throw a RangeError"). The
spec is also explicit that the UA holds a minimum and maximum target "reflecting what
the user agent is able or willing to provide", that the value is "a target", and that
the resulting change in delay is observed **gradually**. A write is therefore not a
measurement. The app wrote a target up to 2200 ms and then regulated every downstream
decision against that *request*.

`jitterBufferTargetDelay` is the standardized read-back, defined in exactly the same
cumulative terms as `jitterBufferDelay` — "increased by the target jitter buffer delay
every time a sample is emitted... to get the average target delay, divide by
`jitterBufferEmittedCount`" — so the same windowed-delta formula applies.
`jitterBufferMinimumDelay` is the UA's own floor and is explicitly "not affected by
external mechanisms that increase the jitter buffer target delay, such as
`jitterBufferTarget`".

Why it mattered: a UA that silently clamped a 350 ms request to 120 ms was
**indistinguishable from one that honoured it**. The drop-gated accommodation then saw
the resulting late frames, concluded the network was stressed, and kept raising —
against a target that never landed. Both readings now go to the HUD (`180 ms → 120`)
and to the diagnostic export, and the suite pins that the supervisor never steers on
them, so the read-back cannot become a second feedback loop around the controller it
audits.

### The audio half of A/V sync was completely unobserved

Every stats consumer filtered on `kind === 'video'`, so the audio report was discarded
even though it arrives in the same `getStats()` walk. That left unmeasured: the audio
clock (`totalSamplesDuration`), concealment (`concealedSamples`, `concealmentEvents` —
audible gaps), and `insertedSamplesForDeceleration`, which is the UA stretching audio to
reach the video target — the exact mechanism the existing comments reason about at
length but could not see. Audio drift is now measured in **ppm** against wall time; a
few hundred ppm walks tens of milliseconds per minute and the browser then
micro-corrects continuously, which reads as jank while every video stat is clean.

`totalSamplesDuration` is a *receive*-side measure ("all samples that have been
received"), so the reading absorbs drift in the source's clock as well as the
receiver's, and it is not a signal for "is audio being rendered". The measurement is
gated on element state and the WebAudio tap instead (`audioIsPulled()`), because what
freezes when a track is not rendered is the audio **jitter buffer** and its emitted
counters — mixing the two in one measurement produces a reading that looks like an
enormous clock drift and is really just "nothing has been played yet".

### "The video speeds up / slows down" was structurally unobservable

`player.playbackRate` reads `1.0` for a `MediaStream` and cannot see this. The
mechanism is real and lives in this app's own control path: per the spec, a lowered
`jitterBufferTarget` is reached by **discarding** buffered frames, and a buffer surplus
is spent rather than sitting still. `rVFC`'s `metadata.mediaTime` was never read — the
callback used only `presentedFrames`. It now computes a smoothed
`d(mediaTime)/d(wall)`: the rate of **presented** media per unit wall time. A rate
persistently above 1 means the element is spending surplus, which is the visible
hitch-then-jump.

It is a presented-rate measure, not a playback-rate reading: rVFC fires per frame sent
to the compositor, so a source that is itself dropping frames reports a *lower* ratio
while still running at exactly 1.0×. That is why it is reported alongside the presented

### Encoder: three verified defects

Checked against the bundled ffmpeg (`ffmpeg -h encoder=h264_nvenc`) rather than assumed:

- **`-spatial-aq` defaults to `false`.** The pipeline has been spreading bits uniformly
  instead of by regional complexity. A/B measured on the bundled encoder, 1920x1080@60
  testsrc2, 6000k, 12 s, `-g 30`: total 8804 KB → 8817 KB (+0.15%), average
  6.01 → 6.02 Mbps, **100 ms peak 8.96 → 8.64 Mbps**, max IDR 36.8 → 39.8 KB. It is
  bitrate-neutral and it *lowers* the peak, which is the figure that overflows
  MediaMTX's per-reader write queue on keyframes.
- **`env.gopFrames || '60'` contradicted `DEFAULT_GOP_SECONDS`.** 60 frames is 1.0 s at
  60 fps, 2.5 s at 24 fps and 5 s at 12 fps — two to ten times the designed 0.5 s
  interval — silently, in exactly the case where the probe could not answer. It now
  falls back through the same arithmetic the probe itself uses, so the two cannot drift
  apart. (The suite pinned `'60'` as correct; that assertion was pinning the
  contradiction and was corrected to `30`, with a second case proving an explicit
  `env.gopFrames` still wins.)
- **No `-fps_mode passthrough`.** ffmpeg's default `auto` "chooses between cfr and vfr
  depending on muxer capabilities", so with a constant-rate-capable muxer it resolves
  to cfr, whose documented behaviour duplicates and drops frames to hit an exact
  constant rate. Either branch rewrites frame timing, manufacturing frame-count
  discontinuities. This is the encoder-side twin of the 24 fps measurement above.

Opus is now pinned to the WebRTC clock: `-ar 48000 -ac 2 -application lowdelay
-frame_duration 20`. RFC 7587 fixes `audio/opus` at 48 kHz, and the default `audio`
application permits encoder lookahead — audio latency the video path deliberately
refuses to accept.

### What was checked and deliberately left alone

- **`-preset p4` is a no-op** (verified: it is the NVENC default). Changing it to `p1`
  trades real quality for encode speed, the wrong trade for a project whose stated goal
  is smoothness. Left in place as an explicit pin.
- **`tune=ull` is not what removes lookahead.** `rc-lookahead` already defaults to 0
  (verified). The conclusion is right and the cause is mis-attributed, but the
  behaviour is correct, so nothing was changed on the strength of a comment edit.
- **The drift "catch-up" is a reconnect, not a ramp.** Reducing surplus by *lowering*
  the target discards frames, and the staged reconnect avoids that but costs 2–4 s of
  black. Both are worse than the surplus. Left as-is and documented rather than
  "fixed" into something that trades one artefact for another.

### Open, and not done

- The browser probe in `_probe/` is scaffolding, not a shipped tool. It was written to
  get ground-truth viewer stats out of a real headless-Chrome WHEP session and could
  not be completed on this host: headless Chrome needs ~10 s to open its debug port
  here, and it could not load the loopback page origin, so the WHEP POST failed with a
  bare "Failed to fetch". The numbers in this section therefore come from
  `ffprobe`/`ffmpeg` against the running MediaMTX, not from a browser. Re-running the
  probe against a live broadcast is the obvious next step and would confirm or refute
  the read-back and presented-rate instruments on real `getStats()` output rather than
  on unit fixtures.
- `start_host.ps1` raises only MediaMTX to `AboveNormal`. The bridge's ffmpeg (NVDEC +
  NVENC + mux) and `server.js` stay at Normal, even though a preempted encoder thread
  makes every viewer hitch at once — the same reasoning the file already applies to
  MediaMTX.

frame count rather than acted on alone.

### The freeze bound is frame-rate dependent and was a single constant

The stats spec defines a freeze as a rendered-frame gap of at least
`Max(3 * avg_frame_duration_ms, avg_frame_duration_ms + 150)`. In the 10–120 fps range a
real broadcast uses, the `+150` term dominates: the bound is 166.7 ms at 60 fps,
183.3 ms at 30 fps and 191.7 ms at 24 fps, and the 3× term only takes over below
~13.3 fps — so one constant is wrong everywhere. (This host's own live source measured
1080p at a true 24 fps CFR — 41.71 ms PTS deltas — while the container advertised
48 fps, so the two are not always close.) `specFreezeThresholdMs()` now derives the
bound from the measured frame rate.

**It is reported, not acted on.** `triggerFreezeRecovery()` costs 2–4 s of black, worse
than the freeze it would "fix", so a short freeze should widen the buffer rather than
tear the session down. The staged recovery keeps its existing threshold for a genuine
*decoder* stall (bytes flowing, nothing decoding).


### `playoutDelayHint` was written, and it does not exist

`applyPlayoutDelay` carried a fallback writing `receiver.playoutDelayHint =
targetMs / 1000`. That property is not in the WebRTC-PC Recommendation, not in MDN's
`RTCRtpReceiver` member list, and appears in no W3C WebRTC specification or extension.
The branch could never be taken — and its presence advertised a compatibility path that
does not exist, so a maintainer reading it would have believed non-Chromium receivers
were covered. Removed; `jitterBufferTarget` is the only control and it is in
milliseconds.

Related: nothing enforced the setter's documented `[0, 4000]` range, and an
out-of-range write throws a `RangeError` that the existing `catch` reported as "this
browser has no such API". The accommodation cap (2200) sits under 4000 today, so this
was a latent trap rather than a live bug — but a future constant bump, or summing the
base terms instead of `max()`ing them, would have thrown on *every* write and silently
disabled buffer control while the HUD kept advertising a target. Now clamped at the
call site.

- Audio gain is now **ramped, not stepped** (`setValueAtTime` moves gain within one 128-sample render quantum, so mute/unmute was a full-scale 0 dBFS click and a volume drag was 60–200 clicks/second of zipper noise).
