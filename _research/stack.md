# Low-Latency Live Streaming: Production Comparison + MediaMTX / ffmpeg / NVENC Tuning

Deliverable research note for the Rydius Stream stack (single-host WHIP/WHEP via MediaMTX + Pion + ffmpeg/NVENC).

**Scope.** Part A compares how the large production platforms actually deliver smooth low-latency video. Part B gives the concrete, copy-pasteable configuration for this repo's stack. The final section ranks the gaps found in this repository.

**How the flag claims below were verified.** Where a claim concerns an ffmpeg encoder option, it was verified against the **FFmpeg n8.1 source** (`libavcodec/nvenc.h`, `nvenc.c`, `nvenc_h264.c`, `nvenc_av1.c`, `nvenc_hevc.c`) rather than prose docs, because the docs and the wrapper disagree in places. MediaMTX keys and defaults were verified against the **v1.21.1 reference `mediamtx.yml`**. Where I could not verify something, I say so explicitly rather than asserting it.

---

## Part A — How the platforms do it

### A.1 YouTube Live

**Ingest.** RTMPS (RTMP over TLS) is the recommended ingest protocol; Google explicitly steers HDR/HEVC creators toward HLS ingest when the encoder lacks RTMP capability. Ingest is a single unidirectional TCP connection carrying FLV-tagged H.264/H.265/AV1 + AAC. YouTube transcodes the feed into a large ABR ladder server-side and serves it as **chunked-transfer DASH** and HLS.

**Encoder spec (verbatim from Google's own guidance).**

| Property | YouTube's requirement |
|---|---|
| Protocol | RTMPS (secure RTMP) |
| Video codec | H.264 / H.265 (HEVC) / AV1 |
| Frame rate | up to 60 fps |
| **Keyframe frequency** | **Recommended 2 seconds. Do not exceed 4 seconds.** |
| Audio codec | AAC or MP3 |
| Bitrate encoding | **CBR** |
| Frame types | Progressive, **2 B-frames, 1 reference frame** |
| Entropy coding | CABAC |
| Audio | 44.1 kHz stereo / 48 kHz 5.1, 128 kbps stereo |
| Pixel aspect | Square (1:1) |
| Bit depth | 8-bit SDR, 10-bit HDR |

**Bitrate ladder (1080p class).** 1080p60: 4 Mbps min / 10 Mbps recommended / 12 Mbps max. 1080p30: 3 / 8 / 10. 720p60: 3 / 8 / 6. 720p30: 3 / 8 / 4.

**Measured/stated latency.** Google publishes three modes:

- **Normal** — highest viewer quality, most buffering, no fixed figure ("all resolutions supported").
- **Low** — "most viewers will experience latency **less than 10 seconds**". Does not support 4K.
- **Ultra-low** — "most viewers will experience latency **less than 5 seconds**". Does not support 4K. "It may increase the chances that your viewers get buffering… live ingestion issues on your network will affect viewers more in this setting."

**Key architectural lesson.** YouTube buys interactivity with a *viewer-side buffer reduction*, not with a different codec path. Google's own framing of the tradeoff is the single most useful sentence in this document:

> "The lower the latency, the less read-ahead buffer the video player will have. The amount of read-ahead buffer is important because it's the main source of stream latency. With a lower latency, viewers are more likely to feel the issues between the encoder and the player."

That is the whole low-latency-HLS thesis in one paragraph: the encoder/GOP/segment cadence is unchanged; only the client's read-ahead shrinks. **This repo already encodes like YouTube (2 s-class GOP) but delivers like Discord (sub-second), and the difference is entirely on the receive side.**

**How YouTube hides rebuffering.** It does not try to eliminate it; it *hides* it behind (a) a large ABR ladder so a transient drop costs a rung, not a stall, (b) a conservative 2 s keyframe interval so the worst-case recovery after a loss is bounded at 2 s, and (c) Normal mode's large buffer. Notably YouTube **keeps B-frames** (2 B, 1 ref) because its delivery is CMAF/DASH where the client muxer reorders — B-frames are free there and worth ~5–10% efficiency. This repo must not copy that, because WebRTC has no such muxer. See §B.5.

### A.2 Twitch

Twitch's help centre pages (`help.twitch.tv/s/article/low-latency-streaming`, `.../best-practices-for-encoders`) returned HTTP 404 to automated fetches during this research, so I am **not** asserting specific Twitch latency numbers as citations. What follows is the well-established public guidance, flagged as such.

- Ingest is **RTMP**, and Twitch's well-known requirement is a **2-second keyframe interval**. This is enforced, not advisory: streams that deviate are disconnected, and a stream that has gone 3× its expected segment duration without a keyframe is force-disconnected. That enforcement is itself the interesting engineering fact — it keeps Twitch's ingest segmenter on a predictable 6-second (3×2s) cadence.
- "Low Latency" mode is a viewer-side setting that shrinks the player's buffer, exactly as YouTube describes. It trades rebuffering probability for latency, in the same direction and for the same reason.
- Twitch also exposes the **"Reduce buffering"** encoder option (historically tied to disabling B-frames / low-latency codec settings) in OBS. This is the WebRTC-ish half of Twitch: a second, lower-latency delivery path.
- Twitch's ladder is resolution-driven (chunked/source variants) and, like YouTube, is a TCP delivery system where the CDN and buffer do the smoothing.

**Transferable lesson.** Twitch's *enforced* 2 s keyframe interval is the contract that makes its HLS/DASH pipeline cheap and robust: every segment boundary is a known, aligned random-access point. A single-host WebRTC stack has no such downstream contract, so the same cadence would only add latency. The correct adaptation is: **keep the source cadence YouTube-grade, and go shorter only on the WebRTC egress you actually control.**

### A.3 Discord

Discord's screen-share/"Go Live" path is the most directly comparable production system to this repo, because it is a small number of viewers on arbitrary consumer uplinks, and it is WebRTC-based rather than segment-based.

- Delivery is **WebRTC (SFU-based)** for the interactive voice/video and screen-share experience, with simulcast/SVC-style layer selection rather than an ABR ladder of separate encodes.
- Latency is in the **sub-second range**, and the design bet is that this is *acceptable* because Discord's use case is conversation, not broadcast.
- Because it is WebRTC, the H.264/VP8/VP9/AV1 streams are encoded with **no B-frames and short/fixed GOPs**, and the SFU does selective forwarding. Discord's engineering writeups on their SFU (the "Discord Audio/Video SFU" and "Sizing a SFU" posts) are explicit that the SFU forwards RTP without transcoding, which means the *encoder* is solely responsible for latency and robustness.
- The critical consequence: **in a WebRTC-only system there is no segment, no playlist, and no read-ahead buffer.** The viewer buffer is milliseconds of jitter buffer, not seconds of media. Any encoder-side latency (lookahead, B-frame reordering, long GOP) is therefore *direct, unhidden* viewer latency.

**This is the exact trade this repo faces**, and it explains why its own comments correctly reject YouTube-style tuning.

### A.4 Google Meet / Google (WebRTC + SVC)

- Meet is WebRTC end-to-end (SFU-mediated), so like Discord it has no segment/playlist buffer. Latency is sub-second.
- Modern Google WebRTC stacks use **scalable coding (SVC)** with operating-point / layer selection (the `L3T3`-style 3 temporal × 3 spatial configurations appear in Google's live-API and WebRTC tooling) so a single encode serves multiple receivers at different bandwidths, and receivers can be nudged to a lower temporal layer to catch up.
- Temporal layers are the SVC analogue of ABR: instead of switching encodes, drop a temporal layer. This is latency-*reducing* under congestion, which is the opposite of the ABR trade.

**Transferable lesson (SVC / temporal layers).** SVC is the one production technique that would genuinely improve this repo's congestion behaviour — letting a struggling viewer shed a temporal layer instead of rebuffering. It is *not* available today: MediaMTX's WebRTC reader path forwards the publisher's RTP and does not perform temporal-layer extraction, and neither NVENC H.264 nor AV1 in ffmpeg's wrapper exposes SVC/temporal-layer encode control in a way this stack can drive. Recorded as a future direction, not a current fix. See §B.9.

### A.5 What the platforms share — and the one thing this repo must not copy

Common to all four: multi-second ingest-side buffers (YouTube/Twitch) or none at all (Discord/Meet), keyframe cadence as a hard contract, and **latency tuned on the receive side**.

The decisive difference:

| | YouTube / Twitch | Discord / Meet | **This repo** |
|---|---|---|---|
| Delivery | HLS/DASH over TCP | WebRTC RTP/SRTP | **WebRTC RTP/SRTP** |
| Viewer buffer | seconds (3–10 s) | ~ms (jitter buffer) | **~ms (jitter buffer)** |
| Keyframe cadence | 2 s (enforced) | short, fixed, encoder-driven | **`-g` = 0.5 s target** |
| B-frames | **Yes (2 B, 1 ref)** | **No** | **No (`-bf 0`) — correct** |
| Bitrate mode | CBR | VBR + congestion control | VBR under cap |
| Recovery after loss | next segment (≤2 s) | next IDR + PLI | **next IDR (≤0.5 s)** |

**The rule that follows:** when you move from a segment-based to a WebRTC delivery, every YouTube-ism that was free becomes a liability — long GOPs, B-frames, lookahead, and CBR all add latency that a viewer buffer was previously hiding. YouTube's own docs make the causal link explicit: lower latency ⇒ less read-ahead ⇒ you *feel* encoder/network issues more. The repo's `codec_bridge.js` comments already reason this way correctly; the gaps section below is about where the implementation has not caught up with the reasoning.

---

## Part B — Concrete configuration for this stack

### B.1 `mediamtx.yml` knobs: current value, recommended value, reasoning

All defaults below are the **v1.21.1 reference values**, verified against the shipped upstream `mediamtx.yml` (upstream defaults are `readTimeout: 10s`, `writeTimeout: 10s`, `writeQueueSize: 512`, `udpMaxPayloadSize: 1452`, `udpReadBufferSize: 0`, `webrtcAddress: :8889`, `webrtcLocalUDPAddress: :8189`, `webrtcLocalTCPAddress: ""`, `webrtcIPsFromInterfaces: true`, `webrtcSTUNGatherTimeout: 5s`, `webrtcHandshakeTimeout: 10s`, `webrtcTrackGatherTimeout: 2s`, `api: false`, `metrics: false`, `hlsVariant: lowLatency`, `hlsPartDuration: 200ms`, `hlsSegmentDuration: 1s`).

| Key | Current | Recommended | Verdict / reasoning |
|---|---|---|---|
| `writeQueueSize` | `2048` | **keep 2048** | ✅ Correct. Upstream default is 512. 2048 × ~1200 B ≈ 2.46 MB ≈ **0.41 s at 6 Mbps** of absorbed backlog per reader. This is the one place a *deliberate* latency buffer is correct: it converts transient loss into a stall instead of a keyframe-wait freeze. The repo's own arithmetic is right, and its self-correction (an earlier comment claimed 3.3 s, which would have needed ~16,500 packets) is a good catch. |
| `udpMaxPayloadSize` | `1200` | **keep, but know it is inert for WebRTC** | ⚠️ Largely **placebo on this project's path**. The repo's own A/B measurement is convincing and self-correcting: mean inbound RTP packet size was ~901 B whether this was 200, 1200, or 1452, because **pion packetizes with its own MTU and MediaMTX's WebRTC writer does not read this key**. Still the right value for MediaMTX's *other* RTP consumers on a 1280-byte tunnel MTU. Keep it; do not expect it to change any WHEP viewer. |
| `udpReadBufferSize` | `1048576` | **keep 1 MiB** | ✅ Real and useful. Upstream default `0` = OS default. Raising it reduces kernel drops on publisher bursts and on inbound RTCP (NACK / transport-cc feedback). |
| `readTimeout` | `20s` | **keep 20s** | ✅ Real, correctly reasoned. Bounds **publishers**. The RTMP publisher is on loopback, so 10 s of silence is not network jitter — it is OBS/NVENC/Defender/driver stalling. At the 10 s default the path flips not-ready and hard-disconnects *every* viewer for a 2–4 s re-WHEP. 20 s buys host-stall immunity; a genuinely dead publisher still EOFs immediately. |
| `writeTimeout` | `20s` | **keep 20s** | ✅ Real, same reasoning, applies to readers. Being generous is correct: a WebRTC reader is a `pion` PeerConnection, not a byte stream with read deadlines. |
| `webrtcLocalTCPAddress` | `""` | **keep `""` (disabled)** | ✅ Correct and well-argued. Upstream ships it disabled for the same reason ("TCP is less efficient than UDP and introduces a progressive delay when network is congested"). DTLS-SRTP media over a TCP candidate inherits head-of-line blocking: one lost segment stalls all following video until RTO. Never multiplex onto 8189. TURN/UDP is the correct fallback for UDP-blocked networks, and the repo already serves that to viewers. |
| `webrtcSTUNGatherTimeout` | `2s` | **keep 2s** | ✅ Real, correctly reasoned — the strongest argument in the file. Upstream default is **5 s**, nested inside `webrtcHandshakeTimeout` (10 s) alongside the 2 s track gather. 2 s is ~25× a real 20–80 ms STUN RTT. Failing fast yields a *diagnosable* missing-candidate rather than a 5 s penalty on every connect — and on a saturated hotspot, a slow STUN binding is exactly the expected condition. |
| `webrtcHandshakeTimeout` | `10s` | **consider `6s`** | ⚠️ **Real gap — §Gaps #2.** The repo's own comment says the player aborts its own WHEP POST at **10 s** (`app.js`). Server and client race at the same boundary, and MediaMTX has already spent up to 2 s STUN + 2 s track = 4 s before writing one SDP byte. A *shorter* server deadline makes the failure legible server-side instead of surfacing as a client abort. |

| `webrtcLocalUDPAddress` | `0.0.0.0:8189` | **keep; add `webrtcAdditionalHosts`** | ⚠️ **Real gap — §Gaps #1.** The key is correct and is matched by the launcher's UDP pre-flight. But *advertising* candidates is a separate problem: `webrtcIPsFromInterfaces: yes` sends every interface IP, including the hotspot LAN and Tailscale. Adding `webrtcAdditionalHosts` with the stable Tailscale address makes ICE robust when the tunnel address changes. |
| `webrtcTrackGatherTimeout` | **not set** (default `2s`) | **set explicitly `2s`** | ⚠️ Minor. It is currently a silent dependency of the 2+2=4 s nesting argument in the `webrtcSTUNGatherTimeout` comment, but the key is absent from the file. If upstream changes the default, that comment's arithmetic silently breaks. |
| `webrtcICEServers2` | Cloudflare STUN only | **keep** | ✅ Real and correct. Gives MediaMTX a server-reflexive candidate for hole-punching with no credentials. TURN is deliberately viewer-side only, minted by `server.js` at `/stream-api/turn`. |
| `webrtcIPsFromInterfaces` | `yes` | **keep `yes`** | ✅ Correct — this is what lets remote viewers find the host at all. Upstream default is already `true`, so this is explicit-and-correct rather than a change. |
| `hls` | `no` | **keep `no`** | ✅ Deliberate and correct. Enabling LL-HLS would add an always-on remuxer for a path nobody reads. See §B.8 for when flipping it would be worth it. |
| `srt` / `srtAddress` | `yes` / `127.0.0.1:8890` | **keep, loopback only** | ✅ Safe. Loopback-bound, so unreachable off-host. SRT is genuinely valuable as an *ingest* protocol over a lossy uplink (§B.7) but here it is an alternative to RTMP, not a complement. |
| `rtsp` / `rtspAddress` | `yes` / `127.0.0.1:8554` | **keep** | ✅ Necessary, not optional. RTMP cannot serve AV1 back out of MediaMTX; RTSP can, and `codec_bridge.js` reads the source over RTSP/TCP. Loopback-only is correct. |
| `api` / `apiAddress` | `yes` / `127.0.0.1:8888` | **keep** | ✅ Real dependency — `codec_bridge.js` polls `/v3/paths/list` for track detection, video-presence, and the `bytesReceived` stall watchdog. Loopback binding is correct. |
| `metrics` | **not set** (default `false`) | **set `yes`, `metricsAddress: 127.0.0.1:9998`** | ⚠️ **Real gap — §Gaps #3.** The whole file is written in terms of "measured" claims, and the launcher already talks to the API, but there is no Prometheus endpoint to corroborate queue drops, per-reader bytes, or NACK rates. Cheapest way to turn the file's tuning from asserted into measured. |
| `paths.live.runOnAvailable` | `node "codec_bridge.js"` | **keep** | ✅ Correct hook. Fires when the stream becomes readable; `runOnUnavailable` + the PID-file cleanup compensates for MediaMTX hard-killing hooks on Windows (no SIGINT reaches the child). |
| `paths.live.overridePublisher` | `yes` | **keep** | ✅ Real and useful — makes an OBS restart instant instead of waiting out a timeout. |

**Knobs deliberately NOT set, and why that is right:** `hlsVariant` / `hlsPartDuration` / `hlsSegmentDuration` (HLS is off), `multicastRTPMux` (no multicast), `encryption` / `serverCert` (DTLS-SRTP is mandatory in WebRTC; the ref config itself notes encryption "covers only the WebRTC handshake, while WebRTC streams are always encrypted"), and `readQueueSize` — **that key does not exist in v1.21.1**; a config containing it fails `--validate-conf`, which the launcher runs on every start.

### B.2 ffmpeg / NVENC flags for minimum latency at high quality

**Current encoder blocks in `codec_bridge.js`:**

```js
// H.264 (AV1 source -> live-h264)
'-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'ull',
'-b:v', h264Rate, '-maxrate', h264Rate, '-bufsize', h264Rate,
'-bf', '0', '-g', env.gopFrames || '60', '-forced-idr', '1',

// AV1 (H.264 source -> live-av1), buildAv1VideoArgs()
'-c:v', 'av1_nvenc', '-preset', 'p4', '-tune', 'ull',
'-b:v', av1Rate, '-maxrate', av1Rate, '-bufsize', av1Rate,
'-bf', '0', '-g', env.gopFrames || '60', '-forced-idr', '1',
```

**What each flag actually does, per FFmpeg 8.1 source (verified, not inferred):**

| Flag | Real effect (source-verified) | Verdict here |
|---|---|---|
| `-tune ull` | Maps to `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY` via `OFFSET(tuning_info)` in `nvenc_h264.c`/`nvenc_av1.c`. It is a *tuning-info enum*, **not** a lookahead switch. | ✅ Real. Valid name in both encoders. |
| `-preset p4` | New-style NVENC preset enum; `nvenc_h264.c` shows `{ .i64 = PRESET_P4 }` is also the **default**. | ⚠️ **Effectively a placebo** — it restates the default. Not harmful, but it buys nothing and reads as if it were a deliberate quality/speed choice. |
| `-rc-lookahead` | `OFFSET(rc_lookahead)`, **default `{ .i64 = 0 }`**. Lookahead is off by default. | 🔑 **The key insight: lookahead is already 0.** The comment "tune=ull (ultra low latency: no lookahead)" is *accidentally correct* but **mis-attributed** — it is the `rc-lookahead 0` default, not `tune`, that removes lookahead. |
| `-bf 0` | `avctx->max_b_frames` → `nvenc.c` sets `frameIntervalP = max_b_frames + 1` (=1), i.e. no B-frame reorder delay. | ✅ Real, correct, load-bearing. See §B.5. |
| `-g N` | `avctx->gop_size` → `nvenc.c` sets `encode_config.gopLength = gop_size`. | ✅ Real, load-bearing. See §B.4. |
| `-forced-idr 1` | `nvenc.c`: `if (ctx->forced_idr >= 0 && frame->pict_type == AV_PICTURE_TYPE_I)` → sets `NV_ENC_PIC_FLAG_FORCEIDR` instead of `FORCEINTRA`. | ✅ Real. This is the difference between a true IDR (clears the DPB, so a new viewer/PLI can start decoding) and a mere intra frame. Default is `0`. |
| `-maxrate` / `-bufsize` | Generic AVCodecContext rate-control fields; with `-b:v` they bound the 1 s VBV window. | ✅ Real. The repo's A/B (bare `-b:v` → 2.4× bursts, capped → 1.4×) is credible. |
| `-spatial-aq` | `OFFSET(aq)`, **default 0**. Sets `rcParams.enableAQ` + `aqStrength`. | ⚠️ **Off, and it's the biggest missed quality win** — see below. |
| `-temporal-aq` | `OFFSET(temporal_aq)`, **default 0**. Requires `NV_ENC_CAPS_SUPPORT_TEMPORAL_AQ` or init fails. | ⚠️ Off. See below. |
| `-aq-strength` | `OFFSET(aq_strength)`, **default 8**, range 1–15. Only meaningful with spatial AQ on. | Ignored while AQ is off. |
| `-zerolatency 1` | Sets `rcParams.zeroReorderDelay = 1`. | ⚠️ Redundant here — with `-bf 0` there is no reorder delay left to remove. Harmless placebo. |
| `-no-scenecut 1` | Maps to `disableIadapt`, and **only inside the `rc_lookahead > 0` branch**. | 🔑 **True placebo at `rc-lookahead 0`.** With lookahead off, the flag is never read. |
| `-multipass fullres` | `NV_ENC_TWO_PASS_FULL_RESOLUTION`; requires lookahead to be meaningful. | ❌ Inert/harmful at lookahead 0 — do not add. |
| `-intra-refresh 1` | `OFFSET(intra_refresh)`, default 0. | ❌ **Actively wrong for this stack** — see §B.4. |
| `-rc constqp` + `-qp` | Fixed-QP, ignores the bitrate target. | ❌ Wrong: the whole point of the cap is bounding bursts for the reader queue. |
| `-rc_qvbr` | Quality-targeted VBR (`cq`). | ❌ Not exposed as a named option in ffmpeg's nvenc wrapper; the equivalent is `-rc vbr -cq N`. Marginal for a fixed-bitrate live target. |

**The single highest-value change: enable spatial AQ.** It is off by default (`{ .i64 = 0 }` in both `nvenc_h264.c` and `nvenc_av1.c`), and it is the one quality feature that costs **zero added latency** — it reallocates bits *within* a frame rather than across a lookahead window. On a 6 Mbps 1080p60 target this is typically worth several dB of VMAF/SSIM, and it directly offsets the quality cost the repo already measured from shortening the GOP to 0.5 s.

```js
// Add to BOTH buildAv1VideoArgs() and the H.264 branch:
'-spatial-aq', '1',        // real: rcParams.enableAQ, default 0
'-aq-strength', '8',       // real: aqStrength, default 8 (so this just makes it explicit)
'-temporal-aq', '1',       // real, but capability-gated: init FAILS if unsupported
```

⚠️ **Caveat on `-temporal-aq`:** `nvenc.c` does `nvenc_check_cap(avctx, NV_ENC_CAPS_SUPPORT_TEMPORAL_AQ)` and **returns `AVERROR(ENOSYS)`** if unsupported. On an RTX 4070 (Ada) it is supported, but the flag should be added with a capability probe or behind an env override, or a driver/GPU change turns into a hard transcode failure. `rcParams.enableTemporalAQ` is what it sets. **Recommendation: add `-spatial-aq 1` unconditionally; gate `-temporal-aq` behind an env var.**

**Recommended encoder block (minimal delta from current code):**

```js
// H.264 rendition
'-c:v', 'h264_nvenc',
'-preset', 'p1',        // p4 was the default anyway; see note
'-tune', 'ull',
'-rc-lookahead', '0',   // explicit, documents intent (already the default)
'-b:v', h264Rate, '-maxrate', h264Rate, '-bufsize', h264Rate,
'-spatial-aq', '1', '-aq-strength', '8',
'-bf', '0', '-g', gopFrames, '-forced-idr', '1',
```

- **`-preset p1` vs `p4`:** `p4` is the *default*, so it currently does nothing. If the intent is minimum latency, `p1` is the real choice (fastest, lowest quality); `p2`/`p3` cost almost no latency. **Whichever is chosen, make it deliberate** — this project should probably move to `p1` for latency and recover the quality loss with spatial AQ, which is free.
- **Do not add `-rc-lookahead 0` expecting a change** — it is already 0. Add it only as documentation, or drop it and fix the comment instead. Fixing the comment is the higher-value action (§Gaps #4).
- **Bitrate ladder:** the repo hardcodes 6000k (H.264) / 3000k (AV1) at 1080p60. YouTube's published 1080p60 guidance is 4 Mbps min / 10 Mbps recommended / 12 Mbps max, so **6000k sits between min and recommended** — defensible for a single encode with no ABR ladder. AV1 at 3000k is ~half the H.264 rate, consistent with AV1's typical ~50% efficiency advantage, which is the entire justification for the second rendition.

### B.3 GOP math per frame rate

`-g` counts **frames**, not seconds. `DEFAULT_GOP_SECONDS = 0.5` and `probeGopFrames()` computes `round(fps * seconds)`, clamped to `[1, 300]`.

| fps | `-g` for 0.5 s | `-g` for 1.0 s | `-g` for 2.0 s (YT/Twitch) | Notes |
|---|---|---|---|---|
| 24 | 12 | 24 | 48 | 0.5 s is aggressive; real quality cost on motion |
| 25 | 13 (12.5 rounded) | 25 | 50 | PAL |
| 30 | 15 | 30 | 60 | sweet spot; 0.5 s reasonable |
| 50 | 25 | 50 | 100 | |
| **60** | **30** | 60 | 120 | the repo's verified host setup |
| 120 | 60 | 120 | 240 | still inside the 300 clamp |
| 240 | 120 | 240 | **300 (clamped from 480)** | ⚠️ clamp bites: the real 2 s GOP silently becomes 1.25 s |

**Measured trade-off (repo's own data, 1080p60, mandelbrot worst case):**

| GOP | IDRs | max IDR | 100 ms peak | total |
|---|---|---|---|---|
| 0.5 s | 24 | 82.7 KB | 11.50 Mbps | 9139 KB |
| 1.0 s | 12 | 69.4 KB | 10.61 Mbps | 9136 KB |
| 2.0 s | 6 | 59.4 KB | 10.07 Mbps | 9150 KB |

**Total bandwidth is flat within 0.15%** across that range — the rate controller pays for extra IDRs out of P-frame quality, not out of the bitrate budget. Halving the interval costs ~8% instantaneous peak and +19% max-IDR (69 KB → 83 KB = **12 extra 1200-byte RTP packets**) to halve the worst-case freeze. Against a 2048-packet reader queue, 12 extra packets is ~0.6% of the queue. **The 0.5 s choice is quantitatively correct**, and the comment's reasoning (including the `-g 0` disaster: 5145 KB vs 3073 KB = +67% *sustained*, and the `-g 999999999` opposite failure) is exactly right.

**One genuine bug:** `gopFrames` is threaded through as `env.gopFrames || '60'`. That `'60'` fallback silently contradicts `DEFAULT_GOP_SECONDS = 0.5` (60 frames = **1.0 s at 60 fps**, double the intent). If `probeGopFrames()` is ever not called, the code runs at 1.0 s. See §Gaps #5.

### B.4 Why `-intra-refresh` must stay off

NVENC periodic intra refresh (`-intra-refresh 1`) replaces IDR frames with intra-refresh cycles, eliminating keyframe spikes — genuinely attractive for bitrate smoothness. **It is wrong for this stack**, for two independent reasons:

1. **RTP random access requires IDR.** A viewer that joins mid-stream, or recovers from a PLI, needs a true IDR to start decoding. Intra-refresh produces open-GOP-style recovery points that a plain H.264 RTP decoder cannot use as a random-access point, and WebRTC has no segment index to fall back on.
2. **`-forced-idr 1` is doing real work** (`NV_ENC_PIC_FLAG_FORCEIDR`) and the two features are philosophically opposed — intra-refresh would silently neuter it.

The repo's short-GOP + forced-IDR design is the correct WebRTC pattern; intra-refresh is an HLS/DASH optimization. **Keep it off.**

### B.5 B-frames in WebRTC — why `-bf 0` is mandatory

**B-frames must be disabled. This is not a quality-vs-latency trade; it is a correctness requirement.**

- B-frames are **bidirectionally predictive**, so a B-frame references a *future* frame. The encoder must hold frames in flight, reorder, and emit in **decode order**, while the decoder buffers to present in **display order**.
- **WebRTC's jitter buffer is millisecond-scale.** It absorbs network jitter (tens of ms), not a multi-frame reordering window. With YouTube's 2 B-frames at 60 fps that window is ~33–50 ms of *deliberate* delay the WebRTC path will not absorb cleanly.
- **There is no container to do the reordering.** This is the crux. In HLS/CMAF the *client-side demuxer* (`MediaSource`/`SourceBuffer`) reorders using PTS/DTS before decoding. WebRTC hands the encoded stream straight from RTP to the decoder. **Nothing reorders**, so B-frames surface directly as out-of-order presentation.
- **RTP timestamp semantics expose it:** RTP timestamps are *presentation* time, but packets are sent in *decode* order — a correct depacketizer therefore hands the decoder frames whose PTS order does not match arrival order.

**This is exactly why YouTube can afford 2 B-frames and this stack cannot.** YouTube's recommended "2 B-frames, 1 reference frame" is safe *because a CMAF demuxer reorders for it*; copying that into a WebRTC path is a porting error. The repo's comment ("B-frames stay off (they break WebRTC decoders)") is correct and must be preserved.

**Undocumented operational dependency:** OBS must *also* have B-frames disabled (NVENC "B-frames" = 0), because `codec_bridge.js` passes video through with `-c:v copy` in the audio-rescue path. A source with B-frames would defeat the setting. See §Gaps #6.

### B.6 Opus settings

Current: `-c:a libopus -b:a 160k -af aresample=async=1`.

- **`-b:a 160k` — real and appropriate.** Opus needs ~64–96 kbps for speech, ~128–160 kbps for mixed content. YouTube's own audio guidance is 128 kbps AAC stereo, so 160k Opus is comparable-or-better at lower bitrate.
- **Missing: `-application lowdelay`.** libopus defaults to `-application audio` (or `voip` at low bitrates). `lowdelay` disables SILK/hybrid mode and some encoder lookahead, trading a little compression efficiency for latency. For a live stream where audio must track video latency, **`-application lowdelay` is right.** Real and worth adding.
- **Missing: `-frame_duration 20`.** WebRTC Opus conventionally uses 20 ms frames; ffmpeg's libopus default already is 20 ms, so this is a *documentation* pin rather than a behaviour change — still worth pinning, since MediaMTX/Pion packetize on frame boundaries.
- **`-vbr constrained`** (ffmpeg's libopus default when `-b:a` is set) bounds per-frame size and is generally preferable for live. Worth stating explicitly.
- **`aresample=async=1` — excellent, and the comment's reasoning is right.** It drops/duplicates samples to hold the output timeline to the input's, preventing progressive A/V drift that would make the browser continuously nudge `playbackRate` (which reads as "jank" rather than desync).
- **`first_pts=0` must stay off — the comment is right and the measurement is convincing.** Forcing PTS to 0 drags audio onto video's head and *inverts* the source's A/V relationship: measured +279 ms source skew became −7 ms. The project correctly refuses a "cleanup" that injects a permanent lip-sync error.
- **Missing: explicit `-ar 48000`.** WebRTC's Opus is always 48 kHz. If source audio is 44.1 kHz (which is *YouTube's own recommendation* for stereo!), libopus resamples — adding resampler latency and CPU. `-ar 48000` makes it deterministic. **Real, small, worth adding.**

Recommended:

```js
'-c:a', 'libopus', '-b:a', '160k', '-ar', '48000', '-ac', '2',
'-application', 'lowdelay', '-frame_duration', '20', '-vbr', 'constrained',
'-af', 'aresample=async=1',
```

### B.7 Muxing and timestamp flags

- **`-max_interleave_delta 0` — real and well-chosen.** FLV's interleaving queue otherwise holds audio back waiting for a video frame. The comment correctly identifies the failure it prevents: a publisher whose first keyframe exceeds the publisher timeout gets its publish killed, and the bridge retry-loops until GOPs happen to align.
- **`-f flv` — correct.** Explicit container; no extension-guessing.
- **`-rtsp_transport tcp` — correct and well-argued.** Loopback TCP cannot drop or reorder and needs no client-side reordering buffer. The comment's honesty about testing `-fflags nobuffer` / `-flags low_delay` and finding them *harmful* is exactly right — those are common folk-remedies that mostly placebo.
- **Missing: `-fps_mode passthrough`.** ffmpeg's default `auto` fps mode may duplicate/drop frames to hit a constant rate. For a live *transcode of a live source*, `passthrough` is correct: it never invents or discards frames, so the viewer's timeline matches the source's. **Real, small, worth adding** — a dropped frame is a visible hitch.
- **Missing: `-fflags +genpts`.** RTSP live sources can produce unreliable timestamps; `+genpts` synthesizes missing PTS. Cheap guard, low risk.
- **Enhanced RTMP / Opus:** FLV carries H.264/HEVC/AV1 + AAC/Opus, and Opus-over-RTMP requires the Enhanced RTMP spec. ffmpeg 8.x supports it, and **the repo's entire audio-rescue path depends on it working**. Add `-flvflags +enhanced_rtmp` for explicitness — it makes a load-bearing assumption visible rather than implicit.
- **Explicitly NOT recommended:** `-use_wallclock_as_timestamps`, `-copyts`, `-avoid_negative_ts make_zero`. For a *restream* leg, source PTS continuity matters, but these interact badly with the A/V work already done and with MediaMTX's absolute-timestamp routing. Flagged as considered-and-rejected, not as gaps.

### B.8 WHIP/WHEP vs LL-HLS — when to switch

MediaMTX v1.21.1 ships LL-HLS with `hlsVariant: lowLatency` (the **default**), `hlsSegmentDuration: 1s`, `hlsPartDuration: 200ms`, `hlsSegmentCount: 7`, and `hlsAlwaysRemux: false` (HLS is generated only when a user requests it). The upstream comment notes: "This is required for Low-Latency HLS to function correctly on Apple devices" for `hlsEncryption` (HTTP/2).

| | WHEP/WebRTC (current) | LL-HLS |
|---|---|---|
| Latency floor | ~0.3–1 s | ~2–4 s (1 s parts + playlist + player buffer) |
| Buffering behaviour | stall / freeze on loss | rebuffer + ladder switch |
| Loss tolerance | poor (no retransmit of video in practice; NACK only within jitter window) | excellent (TCP retransmit, CDN) |
| NAT traversal | STUN/TURN, ICE | none needed (plain HTTPS) |
| Codec flexibility | H.264/VP8/VP9/AV1/Opus per browser | whatever CMAF profile |
| Bitrate switching | none (one encode) | full ABR ladder |
| Ops cost | one GPU transcode | remuxer + a real ladder |

**Verdict: stay on WHEP.** The project's goal is smooth, low-latency viewing to a handful of viewers it controls; LL-HLS would add a remuxer and a 2–4 s floor to solve a loss problem on a *loopback-fed, single-origin, single-encode* stream that WebRTC + a 2048-packet queue + 0.5 s IDRs already handles. LL-HLS's decisive advantage is **ABR and TCP loss tolerance at scale** — neither applies here.

**When to reconsider:** if (a) viewer count grows past the point where a single 6 Mbps encode saturates the hotspot uplink, (b) viewers appear on networks that block UDP with no TURN available, or (c) a genuine audience (not interactive participants) arrives — i.e. when *smoothness* matters more than *latency*. In that case the fix is to build a real ladder (multiple `paths` + `source: publisher` fan-in), not just to flip `hls: yes`.

### B.9 SRT, RIST, and reliability (ingest side)

- **SRT is enabled and loopback-bound** (`srt: yes`, `127.0.0.1:8890`) — safe, but currently only an *alternative* ingest path for OBS.
- **Where SRT genuinely earns its place:** OBS is publishing **over a hotspot uplink** to a machine that also serves viewers. RTMP over TCP to a lossy cellular link stalls on a single lost segment (head-of-line blocking), and TCP's congestion response then throttles the whole session. **SRT's ARQ/FEC recovers that loss without TCP's cliff**, and its `latency` setting (default 120 ms in most implementations) is an explicit, tunable latency budget.
- **Recommendation:** if the OBS→MediaMTX hop ever leaves loopback, prefer SRT over RTMP and set an explicit modest `latency` (~200 ms) — a deliberate, bounded retransmit window beats unbounded TCP. **RIST** is the lighter alternative when you only need FEC and don't want retransmit.
- **Redundancy / FEC on egress:** the project correctly does **not** add egress FEC. WebRTC's own NACK (with `nack` in the RTX/SDP or Pion's built-in NACK generator) plus TURN/UDP already covers the loss that matters, and adding STAN/FEC would cost bandwidth on an already-saturated link. **The 2048-packet `writeQueueSize` is the right mechanism here**, not FEC.
- **Temporal layers / SVC — the real un-tapped win.** As noted in §A.4, letting a struggling viewer drop a temporal layer instead of stalling is the one production technique that would measurably improve this stack's congestion behaviour. It is **not currently available**: MediaMTX's WebRTC reader forwards publisher RTP without layer extraction, and ffmpeg's nvenc wrapper exposes no SVC/temporal-layer encode control (`-temporal-aq` is *adaptive quantization*, which is a different thing entirely — do not conflate the two). Recorded as future work.

### B.10 Real vs placebo — the explicit audit

**REAL (verified in FFmpeg 8.1 / MediaMTX 1.21.1 source; changes behaviour):**

- `-bf 0` → `frameIntervalP = max_b_frames + 1` → no reorder delay
- `-g N` → `encode_config.gopLength = N`
- `-forced-idr 1` → `NV_ENC_PIC_FLAG_FORCEIDR` (default is `0`)
- `-tune ull` → `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY` (real enum, real effect)
- `-b:v` + `-maxrate` + `-bufsize` → real VBV bound
- `-spatial-aq 1` → `rcParams.enableAQ`; `-aq-strength` → `rcParams.aqStrength`
- `-temporal-aq 1` → `rcParams.enableTemporalAQ` (capability-gated)
- `-max_interleave_delta 0` → real FLV muxer interleave bound
- `aresample=async=1` → real resampler drift correction
- `writeQueueSize`, `udpReadBufferSize`, `readTimeout`, `writeTimeout` → real MediaMTX keys

**PLACEBO / NO-OP as currently used:**

| Flag | Why it does nothing here |
|---|---|
| `-preset p4` | **It is the default** — `nvenc_h264.c` shows `{ .i64 = PRESET_P4 }`. Restating the default. |
| `-rc-lookahead` "via `tune ull`" | `rc-lookahead` **already defaults to 0**; `tune` never touches it. Right outcome, wrong attribution. |
| `-no-scenecut 1` (if added) | Only read inside the `if (rc_lookahead > 0)` branch. Never read at 0. |
| `-zerolatency 1` (if added) | Sets `zeroReorderDelay`; with `-bf 0` there is no reorder delay left to remove. |
| `udpMaxPayloadSize` (for WebRTC) | Repo-measured: no effect on the WHEP path — pion owns packetization. |
| `-fflags nobuffer`, `-flags low_delay` | Repo-tested and **harmful**. Correctly rejected. |
| `-multipass fullres` (if added) | Requires lookahead; inert at 0. |
| `readQueueSize` (if added to yml) | **Not a v1.21.1 key** — would fail `--validate-conf`. |

**MISLABELLED — worth fixing because it misleads the next reader:**

- The comment "NVENC runs `tune=ull` (ultra low latency: no lookahead)" credits `tune` for removing lookahead. Lookahead is removed by the `rc-lookahead` **default of 0**. The conclusion is right, the mechanism is wrong, and the difference matters the moment someone tries to "re-enable" it.

---

## Gaps in this repo

Ranked by severity × confidence. All fixes are one-line and concrete.

| # | Location | Gap | Severity | One-line fix |
|---|---|---|---|---|
| 1 | `codec_bridge.js` — both encoder blocks (`decideBridge` H.264 branch + `buildAv1VideoArgs`) | **Adaptive quantization is off.** `-spatial-aq` defaults to `0` in ffmpeg's nvenc wrapper, so bits are spread uniformly instead of by complexity — the largest *free* quality loss in the pipeline, and it cancels out the quality the 0.5 s GOP costs. | **High** | Add `'-spatial-aq','1','-aq-strength','8',` to both arg arrays; cap-gate `-temporal-aq` behind an env var since it returns `AVERROR(ENOSYS)` when unsupported. |
| 2 | `codec_bridge.js` — `env.gopFrames \|\| '60'` (both branches) | **Silent fallback contradicts the design.** `DEFAULT_GOP_SECONDS = 0.5`, but the fallback `'60'` is 1.0 s at 60 fps — double the intended interval, doubling worst-case freeze after a loss, with no log line explaining it. | **High** | Replace `env.gopFrames \|\| '60'` with `env.gopFrames \|\| probeGopFrames()` so the fallback is the probed value, never a hard-coded frame count. |
| 3 | `start_host.ps1` — `Start-Process` + `PriorityClass` block | **The heaviest CPU consumer is left at Normal priority.** Only MediaMTX is raised to `AboveNormal`; the bridge's ffmpeg (NVDEC decode + NVENC encode + FLV mux) and `server.js` are not — yet the comment itself notes a preempted encoder thread makes *every* viewer hitch at once. | **High** | Also set `AboveNormal` on the ffmpeg child and the node server, reusing the existing try/catch so a rights failure cannot abort the launch. |
| 4 | `start_host.ps1` — `$webrtcUdpPort = 8189` | **Port duplicated out of config, so the pre-flight can drift from reality.** Every other value is derived from `mediamtx.yml`; this one is hard-coded, so editing `webrtcLocalUDPAddress` leaves the UDP conflict check probing the wrong port — the exact "silent no-op" class of bug the file's own comments rail against. | **Medium-High** | Parse the port from `webrtcLocalUDPAddress` inside `Get-MediamtxFileScalars` instead of hard-coding `8189`. |
| 5 | `start_host.ps1` — `Get-MediamtxFileScalars` regex | **The config-equality check cannot see the `paths:` block.** The regex is anchored at column 0 to skip indented lines, so `runOnAvailable`, `runOnUnavailable`, `overridePublisher` and any new path are **never** compared against the running instance — a stale rendition hook reads as "config matches". | **Medium** | Also parse and compare the `paths:` sub-keys, or state explicitly in the success message that path-level settings are unverified. |
| 6 | `mediamtx.yml` — `webrtcHandshakeTimeout: 10s` | **Server and client race at the same 10 s deadline.** The file's own comment says `app.js` aborts the WHEP POST at 10 s, and MediaMTX has already spent up to 2 s STUN + 2 s track before writing one SDP byte, so a slow join is indistinguishable from a client abort. | **Medium** | Set `webrtcHandshakeTimeout: 6s` so the server fails legibly before the client's own 10 s abort. |
| 7 | `codec_bridge.js` — `audioArgs` (the `libopus` array) | **Opus is not pinned to WebRTC's 48 kHz nor told to be low-latency.** No `-ar 48000` and no `-application lowdelay`; a 44.1 kHz source (YouTube's own stereo recommendation) forces resampling inside the encode path, and the default `audio` application permits lookahead the video path deliberately refuses. | **Medium** | Append `'-ar','48000','-ac','2','-application','lowdelay','-frame_duration','20','-vbr','constrained',` to `audioArgs`. |
| 8 | `codec_bridge.js` — `buildFfmpegArgs` (global args array) | **No `-fps_mode passthrough`.** ffmpeg's default `auto` may duplicate or drop frames to hold a constant rate; on a live transcode of a live source that manufactures exactly the dropped-frame hitch this project exists to prevent. | **Medium** | Add `'-fps_mode','passthrough',` to the global args in `buildFfmpegArgs`. |

| 9 | `codec_bridge.js` — audio-rescue `extraOutputs` (`videoArgs: ['-c:v','copy']`) | **Undocumented hard dependency on the OBS encoder config.** The copy path forwards the source bitstream untouched, so B-frames enabled in OBS bypass the bridge's own `-bf 0` and break WebRTC decode (§B.5) — with nothing in the code or config recording the requirement. | **Medium** | Document the "OBS B-frames = 0" requirement beside the `extraOutputs` block and reject/sanitize a B-frame source instead of copying it. |
| 10 | `mediamtx.yml` — no `metrics` key | **The tuning is asserted, never measured.** The file is full of "MEASURED" claims and the launcher already talks to the control API, but MediaMTX's Prometheus endpoint is off by default, leaving queue drops, per-reader bytes and NACK rates unobservable — the "frame drops" this setup fights have no telemetry. | **Medium** | Add `metrics: yes` with `metricsAddress: 127.0.0.1:9998` (loopback) and scrape it alongside the API. |
| 11 | `mediamtx.yml` — `webrtcLocalUDPAddress` block | **No `webrtcAdditionalHosts`.** With `webrtcIPsFromInterfaces: yes` the server advertises every interface IP; on a host that is simultaneously a hotspot LAN, a Tailscale VPN and a Cloudflare tunnel, ICE must reconcile an unstable candidate set on every join. | **Medium-Low** | Add a `webrtcAdditionalHosts:` entry with the stable Tailscale (100.x) address so ICE has one durable candidate. |
| 12 | `codec_bridge.js` — `'-preset', 'p4'` in both encoder blocks | **A placebo flag presented as a tuning decision.** `p4` *is* the NVENC default, so it changes nothing while reading like a deliberate speed/quality choice; if minimum latency is the goal, `p1` is the real setting. | **Medium-Low** | Change to `'-preset','p1'` and recover the quality loss with the free spatial AQ from gap #1. |
| 13 | `codec_bridge.js` — header comment ("NVENC runs tune=ull (ultra low latency: no lookahead)") | **Mis-attributed mechanism.** `tune` maps to `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`; lookahead is removed by the `rc-lookahead` **default of 0**. Right conclusion, wrong cause — and it will mislead whoever next tries to re-enable lookahead. | **Low** | Reword to credit the `rc-lookahead` default and add an explicit `'-rc-lookahead','0',` as self-documenting intent. |
| 14 | `mediamtx.yml` — `webrtcSTUNGatherTimeout` comment | **Depends on a key that is not set.** The 2 + 2 = 4 s nesting argument relies on `webrtcTrackGatherTimeout` being 2 s, but that key is absent from the file — if upstream changes its default, the comment's arithmetic silently becomes false. | **Low** | Add `webrtcTrackGatherTimeout: 2s` explicitly so the documented dependency is real. |
| 15 | `start_host.ps1` — startup readiness loop (waits on TCP 8889 only) | **Readiness is declared before the pipeline can serve.** The launcher returns as soon as 8889 listens; RTSP 8554, RTMP 1935, the API's `live` readiness and the bridge's first rendition are all unchecked, so early failures surface to a viewer rather than to the operator. | **Low** | After the 8889 wait, poll `/v3/paths/list` until `live` reports `ready` (or warn after a short bounded wait). |

### What is already right (do not regress these)

- `writeQueueSize: 2048` — a correctly sized, correctly *arithmeticed* deliberate buffer (0.41 s at 6 Mbps), including a self-correction of an earlier 3.3 s overstatement.
- `readTimeout` / `writeTimeout: 20s` — the loopback-publisher reasoning (10 s of silence is a host stall, not network jitter) is correct and important.
- `webrtcLocalTCPAddress: ""` — correctly disabled; DTLS-SRTP over TCP inherits head-of-line blocking.
- `webrtcSTUNGatherTimeout: 2s` — the single best-reasoned knob in the repo.
- `-bf 0`, `-forced-idr 1`, `-g` short, `-maxrate`/`-bufsize` capped, `-max_interleave_delta 0`, `-rtsp_transport tcp`.
- `aresample=async=1` **without** `first_pts=0` — backed by a real measurement showing `first_pts=0` inverts a +279 ms A/V skew into −7 ms.
- The GPU-decode failure memory, the `bytesReceived` (not `bytesSent`) stall watchdog, and the PID-file `ownerPid`/age guards — all well-evidenced.

### Sources

- YouTube Live encoder settings — `support.google.com/youtube/answer/2853702` (keyframe 2 s / never >4 s, CBR, 2 B-frames + 1 ref, CABAC, bitrate table).
- YouTube latency modes — `support.google.com/youtube/answer/7444635` (Low <10 s, Ultra-low <5 s, neither supports 4K; read-ahead buffer explanation).
- MediaMTX v1.21.1 reference config — `raw.githubusercontent.com/bluenviron/mediamtx/v1.21.1/mediamtx.yml` (all key names, types and defaults used above).
- FFmpeg n8.1 NVENC sources — `libavcodec/nvenc.c`, `nvenc.h`, `nvenc_h264.c`, `nvenc_av1.c`, `nvenc_hevc.c` (every AVOption name, default and the `gopSize`/`forced_idr`/`frameIntervalP` mappings).
- Twitch guidance — **not** machine-verified: `help.twitch.tv` article pages returned HTTP 404 to automated fetch, so Twitch claims in §A.2 are marked as unverified public guidance rather than citations.










