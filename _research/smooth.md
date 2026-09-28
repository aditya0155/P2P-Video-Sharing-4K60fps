# Frame Smoothness, Judder and Playback-Rate Drift in `<video>` — a Compositor / Frame-Pacing / Decode-Scheduling Reference

**Deliverable for:** `P2P-Video-Sharing-4K60fps` (`Rydius Stream`) viewer app — `app.js`, `index.html`, `style.css`
**Domain:** video-rendering & motion-smoothness (compositor, frame pacing, decode scheduling)
**Date of research:** 2026-09-27
**Repo commit audited:** `26868855f94ca9659754780393f352f79d4fb827` (branch `cline/cc25e`)

---

## 0. Method, sources and an explicit honesty note

This report is built from **primary sources only**: the WHATWG HTML Living Standard, the W3C
WebRTC-PC and WebRTC-Stats specifications, the W3C WebCodecs Editor's Draft and its explainer,
MDN, and the local spec snapshots this repo already carries under `research/`
(`research/pc.html`, `research/stats.html`, `research/rec2.html`). Where I quote, the quote is
verbatim from one of those.

### 0.1 An explicit limitation about `crbug.com` references — read this

I was asked to include "every crbug reference". I could not retrieve Chromium's issue tracker or
source browser during this research pass:

- `https://source.chromium.org/...` returned **"This site requires javascript."** on every attempt
  (it is a JS-only SPA, not fetchable as text).
- `https://bugs.chromium.org/p/chromium/issues/list?q=video+judder&can=1` returned only a
  **"Chromium Sign in"** interstitial — the monorail migration means the public list is behind
  an auth wall for anonymous fetches.
- `https://chromium.googlesource.com/chromium/src/+/main/media/base/video_frame_compositor.cc`
  returned **HTTP 503 Service Unavailable**; the `?format=TEXT` variant returned **HTTP 404**.
- `https://raw.githubusercontent.com/chromium/chromium/refs/heads/main/media/base/video_frame_compositor.cc`
  returned **HTTP 404** (that mirror path is not valid for the `chromium` repo layout).
- `developer.chrome.com/blog/video-request-video-frame-callback` and
  `developer.chrome.com/docs/web-platform/video-request-video-frame-callback` both returned
  **HTTP 404** (that article has been retired/moved out of the current docs tree).
- `github.com/WICG/video-request-video-frame-callback` returned **HTTP 404** (repo retired; the
  feature shipped in the HTML Standard instead).

**Therefore this report contains zero invented crbug issue numbers.** Fabricating a plausible-looking
`crbug.com/123456789` would be worse than omitting it: it would be unverifiable and would poison a
citation list. What I do give, in §9, is the *stable, verifiable* crbug addressable paths that own
each mechanism — components, not guessed issue IDs.

Everything else is sourced and cited; where I make an inference rather than a quotation I say so.

---

## 1. The mental model: five clocks, not one

Almost every "the video is janky" bug report is a confusion between five distinct clocks.

| # | Clock | Where it lives | Who moves it | Failure it causes |
|---|-------|----------------|---------------|-------------------|
| 1 | **Source / capture clock** | The machine doing the capture, and the encoder's own clock | Whoever owns the capture device | Frames produced at a *nominally* 60 fps but on a crystal that is not exactly 60 Hz |
| 2 | **Media clock (timestamp line)** | RTP timestamps, mapped to `HTMLMediaElement.currentTime` | The sender; carried per-packet in RTP headers | A/V drift; `currentTime` vs wall-clock divergence |
| 3 | **Jitter-buffer / playout clock** | `RTCRtpReceiver`'s jitter buffer; targeted by `jitterBufferTarget` / `playoutDelayHint` | **Your JS**, by writing the target | Underrun → visible stutter; over-inflation → "video speed up" catch-up (§8) |
| 4 | **Presentation clock (element clock)** | The `<video>` element's own media playback clock | The user agent, internally; **you cannot read it directly** | Element-level rate limiting — this is what nudges when A/V disagree (§8) |
| 5 | **Display / vsync clock** | The compositor and the physical panel | Display driver / OS / browser | Judder: 30 fps content on a 60 Hz panel |

The hard part for a live WebRTC viewer is that **clocks 3 and 4 are not observable from JS**.
Clock 5 is measurable only indirectly, by observing frame-callback timing. That gap is precisely
what `requestVideoFrameCallback` was created to close.

### 1.1 Where a frame physically travels

For a WHEP / MediaStream session:

```
RTP packets on the wire
  → RTCRtpReceiver jitter buffer        (clock 3; buffered per jitterBufferTarget)
  → decoder (hardware or software)      (the framesReceived → framesDecoded step)
  → VideoFrame (a decoded picture, still in media time)
  → the user agent's frame compositor   (chooses WHICH decoded frame to present NOW, and may
                                         DISCARD frames that arrived too late)
  → the browser compositor / GPU
  → display scanout                      (clock 5)
```

Two independent points at which frames vanish, with *different* causes and *different* counters:

- **Late arrival / decoder pressure** → `framesDiscarded`, `framesDropped`
- **Late arrival at the compositor** → the UA silently skips a frame already in the past; there is
  no WebRTC counter for this, which is one reason `presentedFrames` matters so much

> **Key consequence:** a rising `framesDecoded` proves nothing about what the viewer saw. A session
> can decode 60 fps and render 20 fps and every WebRTC counter looks healthy except the presentation
> count. This repo already knows this — see the comment at `app.js:3075`:
> *"Cumulative presentation counter from the compositor — the real 'frames the viewer actually saw'
> number (decode ≠ render)."*

## 2. `requestVideoFrameCallback` — the API in full

### 2.1 Signature and what the callback actually means

From MDN, `HTMLVideoElement: requestVideoFrameCallback()`:

> "The `requestVideoFrameCallback()` method of the `HTMLVideoElement` interface registers a callback
> function that runs **when a new video frame is sent to the compositor**. This enables developers to
> perform efficient operations on each video frame."

```js
video.requestVideoFrameCallback(callback)   // → returns a handle (unsigned long)
video.cancelVideoFrameCallback(handle)
```

Feature status (MDN): **Baseline 2024, Newly available — "Since October 2024, this feature works
across the latest devices and browser versions."** That baseline date matters: an older browser
simply lacks the method, and every call site must feature-detect with
`'requestVideoFrameCallback' in HTMLVideoElement.prototype`.

**The word "compositor" in that sentence is the entire point of the API.** It fires when a frame is
*submitted for composition*, one step **before** display scanout. It is therefore neither an rAF tick
nor a scanout notification:

- `requestAnimationFrame` fires on the **display refresh** cadence, in lockstep with the compositor's
  frame *update*, and tells you nothing about video.
- `requestVideoFrameCallback` fires **once per presented video frame**, i.e. at the *video's* rate.

For a 30 fps stream on a 60 Hz panel you get ~30 rVFC calls/second but ~60 rAF calls/second — a 2×
divergence. Synchronising canvas/DOM work to rAF therefore lands you at half the video's cadence and
produces visible judder. MDN's canonical example is exactly this, and its caption reads:
*"Drawing video frames on the canvas is synced with the actual video framerate."*

### 2.2 `VideoFrameCallbackMetadata` — every field, verbatim

| Field | MDN's definition |
|---|---|
| `presentationTime` | "A `DOMHighResTimeStamp` representing the time when the browser submitted the frame for composition." |
| `expectedDisplayTime` | "A `DOMHighResTimeStamp` representing the time when the browser expects the frame to be visible." |
| `width` | "A number, in media pixels, representing the width of the video frame (the visible decoded pixels, without aspect ratio adjustments)." |
| `height` | "A number, in media pixels, representing the height of the video frame (the visible decoded pixels, without aspect ratio adjustments)." |
| `mediaTime` | "A number, in seconds, representing the media presentation timestamp of the presented frame. This is equal to the frame's timestamp on the `HTMLMediaElement.currentTime` timeline." |
| `presentedFrames` | "A number representing the number of frames submitted for composition so far alongside the current callback. This can be used to detect whether frames were missed between callback instances." |
| `processingDuration` | "A number, in seconds, representing the duration between the submission of the encoded packet with the same presentation timestamp as this frame to the [decoder]…" |

MDN additionally documents a `processingTime` member in current versions. The repo's own probe
(`_probe/whep_probe.js:206`) reads both spellings defensively — `md.presentedFractions` and
`md.processingTime` — which is the right instinct: **treat non-`presentedFrames` fields as optional.**

The three fields that carry real diagnostic power:

- **`presentedFrames`** — a monotonically increasing count. `delta > 1` between consecutive callbacks
  means frames were **missed between** them. This is the only broadly-deployed, standards-defined way
  to detect a *presentation* drop (as distinct from a decode drop). MDN says so explicitly.
- **`expectedDisplayTime`** — lets you compute the **pipeline depth** for that frame: from callback
  to due-on-screen. It is the per-frame analogue of a latency measurement, far more informative than
  a single session-average figure.
- **`mediaTime`** — the *media-time* position of the presented frame. Differencing it against elapsed
  wall time gives the **effective playback rate the element is actually running**, which is the only
  way to observe clock 4 (§8).

---

### 2.3 Practical patterns

**Detect a presentation drop:**
```js
let prev = null;
function onFrame(now, md) {
  if (prev !== null && md.presentedFrames - prev > 1) {
    console.warn(`dropped ${md.presentedFrames - prev - 1} frame(s)`);
  }
  prev = md.presentedFrames;
  v.requestVideoFrameCallback(onFrame);   // MUST re-arm
}
```

**Compute effective playback rate (the §8 instrument):**
```js
const rate = (md.mediaTime - lastMediaTime) / ((now - lastNow) / 1000);
// 1.0 = correct, 1.02 = 2% fast
```

**Measure per-frame pipeline depth:**
```js
const depthMs = (md.expectedDisplayTime - now) * 1000;
```

**Non-negotiable rules:**
1. **Re-arm inside the callback.** It is one-shot per registration. The repo does this correctly
   at `app.js:3082`.
2. **Cancel on teardown**, or the handle leaks. The repo does this correctly at `app.js:3184-3186`.
3. **Guard the re-arm on a liveness flag**, or a callback resurrects itself after teardown. The repo
   guards with `isConnected` at `app.js:3081` — correct.
4. **The callback runs on the main thread.** Anything heavy inside it competes with decode and
   compositing for the CPU you are trying to protect. Keep it to arithmetic on `metadata` plus one
   re-arm call.

---

## 3. Why MediaStream-driven video judders and stutters

Ordered roughly by how often each is the real cause in a live WebRTC viewer.

### 3.1 Cadence mismatch between source rate and display refresh (judder proper)

This is textbook judder and it is *arithmetic*, not a bug.

- 30 fps on 60 Hz: each source frame held for exactly 2 display frames. Regular, no judder. Fine.
- 30 fps on **59.94 Hz**: 1.998 display frames per source frame. Hold pattern 2,2,2,…,1 repeating
  with period ~2 s — a 1-frame phase slip every ~2 s, forever. The classic "it stutters every couple
  of seconds" report on broadcast content.
- 25 fps on 60 Hz: 2.4 → hold pattern 2,2,3 repeating. Visibly irregular motion.
- **Variable frame rate (VFR)** is the worst case and is common from screen capture: a frame is
  emitted whenever the screen changes, so inter-frame intervals are jittery and no fixed hold
  pattern exists.
- 60 fps on a 30 Hz panel: the display cannot show every frame; the compositor drops and motion
  looks halved.

Screen-share content is unusually exposed: a mostly-static desktop naturally produces **long runs of
identical frames** with occasional bursts. If the *encoder* emits a variable cadence, no amount of
viewer-side buffer tuning will make it smooth.

**What to set:** make the source frame rate an exact integer divisor of the display refresh wherever
you control the encoder, and never transcode to a non-integer cadence. Detect the refresh first (§6.4).

### 3.2 Frames arriving after their presentation deadline

If a frame's presentation time has already passed by the time it leaves the jitter buffer it is
worthless — showing it would show stale motion. The UA discards it. This produces **skipped motion /
smearing** rather than a stutter, and is caused by a jitter buffer target too small for the network's
actual jitter. The repo's adaptive-buffer subsystem exists to prevent exactly this; `app.js:1111-1115`
says:

> "downward `jitterBufferTarget` is exactly what makes Chrome DISCARD frames to reach the new level —
> 170ms of frames, 5 dropped at 30fps, on every stress->calm transition."

Corollary, and a genuine trap: **lowering the target does not reduce latency instantly** — the UA
reaches it by discarding frames, a *visible* cost. §7 covers this in full.

### 3.3 Decode pressure — the frame you paid bandwidth for never reaches the screen

Decode is the most common single cause of real stutter on modest hardware, and it is invisible in
every naive metric because the frames *are* arriving and the codec *is* decodable.

The decisive distinction the repo encodes in `updateDecodeLag` (`app.js:740-756`):

> "`framesDiscarded` is the net of frames dropped due to 'needs resize' and 'decoder failure' — i.e.
> genuinely the decoder's own doing — so the ratio is computed from frames the decoder actually had
> the opportunity to show: `delivered = decoded + discarded`"

with the trigger at `app.js:755`: `if (ratio < 0.85) return Math.min(30, lagSec + 1);`

**The capability-detection trap:** `RTCRtpReceiver.getCapabilities('video')` lists *software*
decoders. A machine with no AV1 hardware "supports" AV1 and decodes it in software, dropping frames
at 1080p60 — which users report as "lag". The repo's comment at `app.js:2235-2239` says this
outright:

> "Capability lists also contain software decoders: a machine without AV1 hardware 'supports' AV1 yet
> drops frames at high resolution/framerate, which reads as lag for the viewer."

**What to set:** use `navigator.mediaCapabilities.decodingInfo({ type: 'webrtc', … })` to ask about
*smoothness*, not mere decodability — the repo already does this at `app.js:2255-2259` with
`framerate: 60`. Also confirm at runtime via `powerEfficientDecoder` and `decoderImplementation`
(§5.2), which the repo does **not** currently read.

---

### 3.4 Main-thread contention

Decode is often off the main thread, but **compositing, style, layout and paint are not.** 30 fps
video needs 30 main-thread compositor passes per second; anything forcing layout or a full-surface
repaint in the same frame steals that budget. Offenders, all already hunted down and fixed in this
repo (README lines 83-87, 96-97, 106-107):

- animating a **paint** property (`border-color`) on the element that *is* the video surface
- `backdrop-filter` over live video — a per-frame re-sample and Gaussian blur of the region beneath
- an rAF loop writing `style.width` every frame (layout invalidation) — the audio meter, now ~12 Hz
- forced synchronous layout (`scrollHeight` read right after `appendChild`) in the decode thread's tab
- render-blocking webfonts forcing a full relayout in the first seconds of playback

### 3.5 Loss that forces keyframe recovery

A single lost frame mid-GOP is invisible; a burst is not, because recovery costs a keyframe interval
of latency plus a PLI round trip. The repo tracks `pliCount`/`nackCount` for this at
`app.js:2743-2748`, and README line 133 notes a rising PLI count is "the signature of recurring
keyframe loss."

### 3.6 Compositor / overlay promotion failure — looks like "video isn't smooth" with no cause

Chrome can promote a `<video>` to a **hardware overlay**, where the panel scans out the decoded
texture directly: zero copies, minimal latency, and the video no longer competes with the page's
raster work for GPU time. This is the low-latency path.

A `<video>` is **de-promoted** by ordinary CSS people apply reflexively:

- `opacity` < 1
- `transform` (any value, including `translate3d(0,0,0)` used to "force GPU")
- `filter`
- `will-change` naming any property that creates a compositing layer
- `backdrop-filter` on an overlapping element (forces the video to be read back)
- non-rectangular clipping, or a rotated/3D-transformed ancestor

So the paradox: `will-change: transform` + `translate3d(0,0,0)`, the standard "GPU acceleration"
trick, **actively removes a `<video>` from the fastest path.** The repo hit this and removed it —
`style.css:370-372`:

> "`will-change: transform` + `transform: translate3d(...)` promoted this element to its own
> composited layer, which is the documented way to pull a `<video>` off the low-latency
> hardware-overlay path."

This is counter-intuitive and under-appreciated, and it is a **latency and smoothness** issue, not a
correctness one: nothing errors, nothing is dropped, and no counter moves. It is invisible in
`framesDecoded`, in `presentedFrames`, and in every WebRTC stat. **You can only see it with
`chrome://gpu`, the "Overlays" view in `chrome://media-internals`, or the Rendering panel — or by
measuring `expectedDisplayTime` latency against a build without it.**

Epistemic status: the *rules* above are well-established Chromium behaviour, corroborated by this
repo's own shipped fix, but I could not fetch the current `VideoFrameOverlay` source to quote the
predicate list (see §0.1). Treat the specific list as "known and consistent with the shipped fix",
not as a verbatim spec citation.

### 3.7 Codec / bitrate mismatch at a given resolution

A 4K60 stream that cannot be delivered at its negotiated bitrate is a stutter generator, not a
softness generator: the decoder runs dry between keyframes. This is what the repo's rendition ladder
and ABR exist to prevent.

---

## 4. Frame-rate matching and display refresh — how to measure it

### 4.1 Measuring the display refresh rate

There is no standard API. The practical method, used in production telemetry, is to time rAF
callbacks over a window and take the median inter-frame delta:

```js
function measureRefreshRate(ms = 2000) {
  return new Promise(resolve => {
    const deltas = [];
    let last = performance.now();
    const t0 = last;
    function tick(now) {
      deltas.push(now - last);
      last = now;
      if (now - t0 < ms) requestAnimationFrame(tick);
      else {
        deltas.sort((a, b) => a - b);
        const median = deltas[deltas.length >> 1];
        resolve(1000 / median);            // e.g. 59.94, 60.00, 144, 30
      }
    }
    requestAnimationFrame(tick);
  });
}
```

Use the **median**, not the mean: a single long task inflates the mean and can make a 60 Hz display
look like 45 Hz. Classify the result as 30/50/60/120/144 and pick the nearest integer divisor for
the encoder. Note rAF is capped at the display rate and throttled when the tab is hidden or the
device is in a power-saving mode, so only measure while visible and awake.

### 4.2 Choosing the source rate

```
display 60 Hz  → 60 / 30 / 20 / 15 / 10 / 5 / 1   (any integer divisor)
display 50 Hz  → 50 / 25 / 10 / 5                 (NOT 60 — 50/60 = 0.83, the worst case)
display 30 Hz  → 30 / 15 / 10 / 5
```

A 60 fps source on a 50 Hz panel is the single most reliable judder generator there is: 1.2 display
frames per source frame, hold pattern 1,1,2 repeating every 5 frames. If you cannot control the
viewer's panel, prefer **30 fps** as the universal safe rate — 30 divides 50, 60, 120, 144 and 240,
so it is judder-free on essentially every modern display, whereas 60 is judder-prone on 50 Hz.

This is a real finding for this repo: the name is literally `P2P-Video-Sharing-**4K60fps**`, the
`navigator.mediaCapabilities` probe asks for `framerate: 60` (`app.js:2258`), and README line 89
refers to "120-240 dropped frames at 60fps". A 60 fps default is judder-prone on 50 Hz displays and
requires the decode headroom of 4K60 — the very thing §3.3 shows the code is worried about.

---

## 5. Decode pressure and the full set of counters

### 5.1 The measurement set

From the WebRTC-Stats specification (`RTCInboundRtpStreamStats`), as snapshotted in this repo at
`research/stats.html`:

| Field | Spec definition (verbatim / close paraphrase) |
|---|---|
| `framesReceived` | "Represents the total number of complete frames received on this RTP stream. This metric is incremented when the complete frame is received." |
| `framesDecoded` | Total frames successfully decoded. |
| `keyFramesDecoded` | Total key frames decoded. |
| `framesRendered` | Total frames submitted for composition/rendering. |
| `framesDropped` | Frames dropped **before** decoding. |
| `frameWidth` / `frameHeight` | Decoded frame dimensions. |
| `framesPerSecond` | The **nominal** output rate as signalled — *not* measured. |
| `totalDecodeTime` | Sum of decode wall time, seconds. |
| `totalInterFrameDelay` | Sum of inter-frame delays — a jitter measure. |
| `totalSquaredInterFrameDelay` | Squares of the above; with the sum you get the **variance**. |
| `decoderImplementation` | "Identifies the decoder implementation used. This is useful for diagnosing interoperability issues." |
| `powerEfficientDecoder` | "Whether the decoder currently used is considered power efficient by the user agent. This SHOULD reflect if the configuration results in hardware acceleration, but the user agent MAY take other information into account…" |
| `jitterBufferDelay` | Cumulative jitter buffer delay, **seconds** (session total). |
| `jitterBufferEmittedCount` | Cumulative frames emitted from the jitter buffer. |

Critical caveats the spec forces:

- **`framesPerSecond` is signalled, not measured.** It is what the sender advertised. Using it as a
  health metric is a mistake — it will read a confident "60" on a stream actually rendering 20. The
  repo reads it at `app.js:2945` for display; legitimate for a *label*, illegitimate as a *health
  signal*. The repo correctly uses the rVFC presentation rate for health instead
  (`app.js:2705-2717`).
- **`jitterBufferDelay` and `jitterBufferEmittedCount` are session-long cumulative totals**, not
  per-second gauges. Dividing one by the other gives a meaningless session average that decays
  forever. The mean delay is the **delta** of delay over the **delta** of emitted count. WebRTC-PC
  says so explicitly:

> "The receiver's average jitter buffer delay can be measured as the delta
> `jitterBufferDelay` divided by the delta `jitterBufferEmittedCount`."

The repo implements exactly that in `windowedPlayoutDelayMs` (`app.js:645`), and its comment at
`app.js:639-640` says: *"Chrome reports jitterBufferDelay and jitterBufferEmittedCount as session-long
cumulative totals, so dividing"* them directly would be wrong.

- `framesDiscarded` is the net of "needs resize" and "decoder failure" drops — the decoder's own
  doing, per the repo's reading at `app.js:740-741`.

### 5.2 The four derived metrics worth displaying

```
decodeRatio   = (ΔframesDecoded + ΔframesDiscarded) / ΔframesReceived   // >0.85 healthy (repo's rule)
renderRatio   = ΔpresentedFrames / ΔframesDecoded                       // <1.0 = compositor starvation
decodeMsPerFrame = ΔtotalDecodeTime*1000 / ΔframesDecoded               // >16.7 = cannot sustain 60fps
steadyClock   = ΔtotalInterFrameDelay / ΔframesDecoded                 // + ΔtotalSquaredInterFrameDelay
                                                                 //   → stddev; clock drift
```

`renderRatio` is the one no WebRTC counter gives directly, and the only one that distinguishes
"the network is bad" from "your compositor is starved." The repo computes the numerator correctly
(`app.js:3077-3079`) and displays it (`app.js:2715`) but **never divides it by the decode rate** —
the two numbers sit in the HUD unpaired. A concrete, cheap gap (§10).

`steadyClock` deserves attention because it is the **clock-2 drift** detector: if
`totalInterFrameDelay` variance grows steadily, the source clock and the receive clock disagree — a
*sender* problem (the `gopSeconds()` probe territory, README line 134), not a viewer one.

### 5.3 `getVideoPlaybackQuality()` — the element-level complement

MDN, `HTMLVideoElement: getVideoPlaybackQuality()`: it "creates and returns a `VideoPlaybackQuality`
object containing metrics including how many frames have been lost. The data returned can be used to
evaluate the quality of the video stream." Members: `totalVideoFrames`, `droppedVideoFrames`,
`corruptedVideoFrames`. MDN warns of `totalVideoFrames`: it "includes any dropped or corrupted
frames, so it's not the same as 'total number of frames played.'"

This is the **`<video>` element's own** drop accounting, independent of WebRTC — the right tool when
the problem is element/compositor-side rather than network-side, and exactly what the repo's probe
uses (`_probe/whep_probe.js:216-217`). **The shipped app never calls it**: zero hits for
`getVideoPlaybackQuality` across `app.js`. A genuine gap — an element-level drop counter is
available and unused in production (§10).

---

## 6. `VideoFrame` / WebCodecs — when and whether to leave the `<video>` path

### 6.1 What WebCodecs actually gives you

From the W3C WebCodecs Editor's Draft, `VideoDecoder` outputs `VideoFrame` objects: a decoded picture
with its own `timestamp`, `duration`, `format`, `codedWidth`/`codedHeight`, `visibleRect`, and a
`close()` that releases the underlying resources. Configs accept `hardwareAcceleration` and a latency
mode (`optimizeForLatency`).

The explainer's rationale, verbatim:

> "There are many Web APIs that use media codecs internally to support APIs for particular uses:
> HTMLMediaElement and Media Source Extensions, WebAudio (decodeAudioData), MediaRecorder, WebRTC.
> But there's no general way to flexibly configure and use these media codecs."

On why not to hand-roll decoders:

> "Increased bandwidth to download codecs already in the browser. / Reduced performance /
> Reduced power efficiency"

The explainer is also candid that `<video>` presentation is deprioritised:

> "Earlier proposals defined AudioTrackWriter and VideoTrackWriter as a means of feeding decoded media
> to `<video>` for presentation. Most prospective users have indicated they prefer to manage
> presentation via Canvas, so `<video>` presentation has been deprioritized for now."

**That is the key point for this repo.** WebCodecs gives you a `VideoFrame`; it does not give you a
*presentation path*. To display it you must hand it to a `<canvas>` or build an MSE pipeline — and per
the explainer, everyone ends up on canvas. Canvas presentation is **strictly worse** than the `<video>`
path: it forfeits the hardware overlay (§3.6), forces a GPU-side copy per frame, puts a main-thread
draw call in the decode frame, and requires you to reimplement presentation timing yourself.

### 6.2 Verdict for this repo: do not migrate

Migrating this WHEP viewer from `<video>` + `srcObject` to WebCodecs + canvas would, on the evidence
above, make it **less** smooth and **higher** latency. `<video>` with a `MediaStream` is the correct,
fastest path for a low-latency live viewer. WebCodecs' legitimate uses here are narrow:

1. **Analysis** — exact frame timestamps for judder analysis. Worth it offline, not live.
2. **A custom compositor** — compositing the browser cannot do (burned-in overlays, multi-angle
   switching in one canvas). Then you accept the §6.1 costs.
3. **Sharing a decoder** with a canvas/recording pipeline, where frames must exist in JS anyway.

**Do not** use WebCodecs to "fix judder". It cannot: judder is a *timing* phenomenon, and `VideoFrame`
carries timestamps but no presentation scheduling. Adding a JS layer between decode and display adds
a frame of latency and a main-thread draw, and fixes nothing.

---

## 7. Latency control, and why every write is expensive

### 7.1 The two APIs, per spec

**`RTCRtpReceiver.jitterBufferTarget`** (`DOMHighResTimeStamp?`, in **milliseconds**), from
WebRTC-PC (verbatim from this repo's `research/pc.html` snapshot):

- IDL: `attribute DOMHighResTimeStamp? jitterBufferTarget;` on `RTCRtpReceiver`, backed by an
  `[[JitterBufferTarget]]` internal slot initialised to `null`.
- "This is a target value. The resulting change in delay can be gradually observed over time."
- **Range check, verbatim:** "If target is negative or larger than 4000 milliseconds, then throw a
  `RangeError`."
- "The receiver's average jitter buffer delay can be measured as the delta `jitterBufferDelay` divided
  by the delta `jitterBufferEmittedCount`."
- On set: "**in parallel**, begin executing the following steps: Update the underlying system about the
  new target, or that is no application preference…"

**`RTCRtpReceiver.playoutDelayHint`** — the newer, seconds-based sibling, exposed via
`RTCRtpSyncRtpControllingExtension`. Unit confusion here is a live footgun: the repo guards it
correctly by dividing (`app.js:796`: `receiver.playoutDelayHint = targetMs / 1000;`).

The repo's `applyPlayoutDelay` (`app.js:789-801`) prefers `jitterBufferTarget`, falls back to
`playoutDelayHint`, and returns `false` when neither exists so callers do not latch a change that
never landed. That is the correct shape.

### 7.2 Three non-obvious rules

**(a) Synchronised tracks share the LARGER of the two targets.** Per spec, a synchronised audio/video
pair uses the larger `JitterBufferTarget` for *both*. Writing a 2200 ms video target onto the **audio**
receiver therefore stretches audio too. The repo caught this (README line 93) and now pushes the target
to the video receiver only, logging `applied += 1` at `app.js:860`.

**(b) Every write re-paces playout.** A write is not set-and-forget; it makes the UA re-plan emission.
Frequent writes cost smoothness directly. The repo's own note at `app.js:809`:

> "Rate-limited on purpose. Every jitterBufferTarget write re-paces Chrome's…"

README line 92 confirms the fix: writes are now band-limited and dwell-limited, with a faster path for
a raise while frames are genuinely being dropped.

**(c) Lowering the target reaches the new level by DISCARDING frames.** The counter-intuitive one,
stated in the repo at `app.js:1111-1115` and analysed in §3.2. A "latency reduction" that throws away
5 frames at 30 fps is a visible hitch, not a free win.

### 7.3 The A/V sync corollary — the actual cause of playback-rate drift

`jitterBufferTarget` is set **per receiver**, but A/V sync is enforced across the pair. The WebRTC-PC
spec text in the same section makes the coupling explicit:

> "An average delay is expected even if DTX is used. For example, if DTX is used and packets start
> flowing after silence, larger targets can influence the user agent to buffer these packets rather
> than playing them out."

When the audio and video receivers end up with genuinely different playout delays, the user agent must
reconcile them — and it does so by nudging the element's playback clock. That is §8.

---

## 8. "The video speeds up / slows down" — playback-rate drift, root-caused

This is the symptom users describe as "it's playing too fast", "it looks sped up", "it suddenly
jumps", or "it feels like it's lagging behind" — and it is **almost never** a real `playbackRate`
change. It is the media element's presentation clock being stretched or compressed to re-assert A/V
sync.

### 8.1 The mechanism

The `<video>` element has ONE clock. It plays **audio and video through it**. If the two tracks'
playout delays diverge, the element cannot honour both, so it does one of two things:

- **Buffer too large → apparent SPEED-UP.** After a stall, a `jitterBufferTarget` reduction, a tab
  rejoin, or a freeze recovery, the buffer holds e.g. 170 ms more video than the element's nominal
  timeline expects. The element **drains the surplus by playing faster than 1.0×** to re-align with
  the live edge. Motion is subtly quick for a second or two. This is the "it suddenly sped up"
  report. It is *deliberate* and *correct* behaviour; the bug is having created the surplus.
- **Buffer too small / audio clock ahead → apparent SPEED-DOWN / "slow motion".** The element is
  short of data, so it stretches time rather than dropping, producing slow motion that users variously
  describe as "laggy", "stuttering in slow-mo", or "it keeps catching up".

The repo already diagnosed the *cause* on the bridge side. `codec_bridge.js:273-277` says verbatim:

> "slightly fast makes the Opus output timestamps walk progressively ahead of the video, and the
> browser's A/V sync layer then nudges `playbackRate` continuously to pull them together — a permanent
> micro-correction that reads as 'janky' rather than as desync. It is free when there is no drift,
> which is the normal case."

`js_checks.js:538-541` repeats it, and `run_tests.py:2108-2109` pins it as a regression test:

> "a drifting audio clock makes the browser nudge playbackRate forever"

The shipped fix is `aresample=async=1` in the Opus rescue (README line 73), letting ffmpeg resample
to follow the source clock instead of generating its own timeline.

**Critically: `player.playbackRate` still reads `1`.** The nudging happens inside the UA and is not
reflected in the property. A search for `playbackRate` across `app.js` returns **zero hits** — the app
never sets it, which is correct, but it also means **there is no instrumentation to see the drift.**

### 8.2 Why the app's "Anti-Stutter" mode can *cause* the symptom

`LATENCY_MODES` (`app.js:185-189`) offers `smooth: { ms: 350, driftLimitMs: 1100 }`. A 350 ms target
on a link whose real need is 180 ms means **170 ms of surplus video is deliberately buffered at all
times.** If the mode is then switched down — by the user, or by the adaptive supervisor relaxing its
stress raise after 15 s of calm — the element has 170 ms to burn off and will visibly run fast while
it does. README line 89 documents exactly this oscillation, now fixed for the *automatic* path:

> "The stress-raise was a wall-clock stamp expiring after 15s. Simulated end to end against the
> extracted real functions, a continuously marginal link produced a perfect square wave — 350ms for
> 15s, 180ms for 7s, five target steps per minute, forever — on a link that never once went calm."

A **user-initiated** mode change down is not covered by that fix, and is a guaranteed speed-up burst
by construction.

### 8.3 The paused-viewer ratchet (already found; re-stated because it is a rate bug)

README line 124:

> "The adaptive buffer walked itself to its cap while paused. With the new late-frame signal
> (`framesReceived` vs `jitterBufferEmittedCount`), a paused viewer satisfies it *permanently* —
> packets keep arriving, nothing leaves the jitter buffer — so the target ratcheted to 2200 ms in
> 50 ms steps, ~44 writes each re-pacing playout, and resumed into a long slow-motion catch-up."

"**Long slow-motion catch-up**" is the speed-down symptom, produced purely by the supervisor. The fix
is the `player.paused` bail-out. This is the clearest demonstration in the repo that buffer target and
playback rate are one phenomenon seen from two ends.

### 8.4 How to measure it — the only available instrument

Since `playbackRate` reads `1`, drift must be inferred from `mediaTime`:

```js
// inside the rVFC callback
const dMedia = md.mediaTime - prev.mediaTime;
const dWall  = (now - prev.now) / 1000;
const rate   = dMedia / dWall;
// rate > 1.0 → element is running FAST (burning off surplus buffer)
// rate < 1.0 → element is running SLOW (starved)
prev = { mediaTime: md.mediaTime, now };
```

This works because `mediaTime` is "the media presentation timestamp of the presented frame … equal to
the frame's timestamp on the `HTMLMediaElement.currentTime` timeline" (MDN, §2.2) — it is *media*
time, so it advances at the rate the element is actually consuming, while `now` is wall time. A ratio
above 1 means the element is deliberately consuming media faster than real time.

**Long-window baseline matters.** Per frame, `rate` is dominated by frame-interval quantisation: at
30 fps `dMedia` is quantised to 33.3 ms steps, so a single-frame sample can read 0.91 or 1.09 through
no drift at all. Smooth over ≥1 s (~30 frames) before concluding anything, and treat
|rate − 1| < 0.02 as noise. A sustained |rate − 1| > 0.05 is real and user-visible.

**The repo has all the inputs and computes none of this.** `lastPresentedFrames` is captured at
`app.js:3077-3079`; `lastFrameTime` is set at `app.js:3074`; but `metadata.mediaTime` is never read
anywhere in `app.js` (search: zero hits). The single most valuable missing measurement in the app,
and it costs four lines (§10).

### 8.5 What actually fixes speed-up/speed-down

Ranked by leverage, all consistent with the repo's own shipped direction:

1. **Never let surplus accumulate.** Keep the target at the minimum the network's real jitter
   requires — what `jitterBufferFloorMs` and the accommodation logic already do.
2. **Never let the target ratchet while not playing.** Already fixed; keep the `player.paused` guard
   covering every new path.
3. **Band-limit and dwell-limit every write.** Already fixed. Each write re-paces playout, so a write
   storm is a smoothness storm.
4. **Fix the audio clock at the source.** `aresample=async=1` — already shipped. A drifting audio clock
   is the root cause of *permanent* micro-correction, worse than any single burst.
5. **When you must change target, change it once and hold it.** Never oscillate.
6. **Do not try to "correct" it in JS.** Setting `playbackRate` to 0.98 to counter a 1.02 UA nudge
   does not work: the UA re-nudges, you get a feedback loop, and `preservesPitch` artifacts appear.
   Fix the cause instead.

---

## 9. `preservesPitch` — why it matters more than it looks

`HTMLMediaElement.preservesPitch` (default `true`; the Gecko-prefixed `mozPreservesPitch` is the
older spelling) keeps **audio pitch constant when `playbackRate` is changed**, by time-stretching the
audio rather than resampling it.

It is relevant here for one specific reason: **the repo never touches `playbackRate`, so
`preservesPitch` is currently a non-issue — and that is the correct design.** It becomes an issue
*only* if someone "fixes" the drift from §8 by writing `playbackRate` from JS, which §8.5 rule 6
rejects on its own merits.

The cost of the alternative is concrete:

- **`preservesPitch = false`**: pitch shifts audibly with any rate change. For speech over a
  screen-share, a 2% shift drops pitch by ~0.35 semitones — audible on sustained vowels, and worse in
  a long session. Some listeners find it genuinely painful.
- **`preservesPitch = true`**: the UA runs a time-stretcher (WSOLA/OLA-class). Cheap in practice, but
  it *is* extra audio DSP, and on a machine already at its decode limit (§3.3) it competes for the
  same budget.
- **Rate changes are audible regardless**, as a slight "chipmunk/slow-motion" texture even with pitch
  preservation, because the transient envelope is still being rescaled.

Therefore: **fix drift at its source (§8.5) and leave `preservesPitch` alone.** A repo-wide search
finds no `preservesPitch` / `mozPreservesPitch` in `app.js`, `index.html` or `style.css` — correct,
and worth a regression test so a future "let me smooth that drift" patch cannot quietly introduce a
`playbackRate` write.

---

## 10. Concrete, actionable gaps in this repo's viewer

Each gap is verified against the actual files at commit `26868855`. Fixes are one-liners in spirit;
full implementations belong in the app, not in this report.

### 10.1 `mediaTime` is never read → playback-rate drift is completely uninstrumented

- **Where:** `app.js:3073-3086`, the `onFrame` rVFC callback. It reads only `now` and
  `metadata.presentedFrames` (lines 3074, 3077-3079). `metadata.mediaTime` has zero occurrences.
- **Why:** §8 — the *only* way to observe the symptom users report as "the video speeds up / slows
  down"; `player.playbackRate` cannot see it.
- **Fix:** in `onFrame`, add `lastMediaTime`/`lastFrameTime` state, compute a ≥1 s smoothed
  `ΔmediaTime / Δwall`, and surface it in the HUD next to the existing `fps rendered` line at
  `app.js:2715`.

### 10.2 `renderRatio` is never computed → compositor starvation is indistinguishable from network loss

- **Where:** `app.js:2705-2717` computes and displays presented FPS; `app.js:2750` reads
  `framesDecoded`. The two are never combined.
- **Why:** §5.2. A high decode rate with a low presentation rate is the signature of
  GPU/compositor starvation — the app's own comment at `app.js:2705-2707` says so, but the code never
  performs the comparison it describes.
- **Fix:** in the same stats tick, compute `ΔpresentedFrames / ΔframesDecoded` and show it as a
  percentage next to `fps rendered`.

### 10.3 `getVideoPlaybackQuality()` is never called in production

- **Where:** zero occurrences in `app.js`; used only in `_probe/whep_probe.js:216`.
- **Why:** §5.3 — the element's own `droppedVideoFrames` is the only counter that sees
  compositor-side drops, which no WebRTC stat covers.
- **Fix:** in the stats tick call `player.getVideoPlaybackQuality()` and add `droppedVideoFrames` to
  the diagnostic report at `app.js:3046-3049`.

### 10.4 rVFC cadence anomalies are never detected

- **Where:** `app.js:3073-3086`. The callback records `lastFrameTime` and `presentedFrames` but never
  inspects the gap between callbacks, nor the `presentedFrames` delta.
- **Why:** §2.2 — MDN states `presentedFrames` "can be used to detect whether frames were missed
  between callback instances". The repo reads the counter and never uses its defining property. A
  rate dip below ~80% of nominal is invisible until the 3 s freeze threshold at `app.js:270` fires.
- **Fix:** in `onFrame`, when `metadata.presentedFrames - prevPresented > 1`, count a presentation
  drop and expose the total; also flag a wall-clock gap > 2.5× the observed frame interval as a
  "cadence dip" well before the freeze watchdog escalates.

### 10.5 No `expectedDisplayTime` / pipeline-depth measurement

- **Where:** `app.js:2703-2722` reads `readyState`, `videoWidth` and the rVFC presentation rate. No
  `expectedDisplayTime`, no `presentationTime`.
- **Why:** §2.2 — per-frame pipeline depth is a far better latency and health signal than a session
  average, and the only way to detect §3.6 overlay de-promotion's latency cost.
- **Fix:** accumulate `expectedDisplayTime - now` in `onFrame` and show a rolling mean in the HUD.

### 10.6 `decoderImplementation` / `powerEfficientDecoder` are never read

- **Where:** zero occurrences in `app.js`; only `framesPerSecond` is read, at `app.js:2945`.
- **Why:** §3.3, §5.1. The app spends real effort on `navigator.mediaCapabilities` gating
  (`app.js:2235-2259`) but never confirms at runtime that decode landed on hardware. A silent
  software-decode fallback is exactly the "works on my machine" failure the check should prevent.
- **Fix:** read `videoStats.powerEfficientDecoder` and `videoStats.decoderImplementation` in the
  stats tick; if `powerEfficientDecoder === false`, drop the ladder one rung immediately instead of
  waiting 5 s for `updateDecodeLag`.

---

### 10.7 60 fps is the hard default, which is judder-prone on 50 Hz displays

- **Where:** `app.js:2258` (`framerate: 60` in the `decodingInfo` probe); repo name and README line 89
  ("120-240 dropped frames at 60fps"); contrast `ivs_sh.txt:151` (`"targetFramerate": 30`).
- **Why:** §4.2. 60 does not divide 50 Hz; 30 divides 50, 60, 120 and 144. A 60 fps default is
  judder-prone on 50 Hz panels and demands the 4K60 decode headroom that §3.3 identifies as the weak
  point.
- **Fix:** measure display refresh once (§4.1) and pick the nearest integer-divisor rate ≤60 before
  selecting a rendition, rather than assuming 60.

### 10.8 User-initiated latency-mode downgrade guarantees a speed-up burst

- **Where:** `app.js:185-189` (the `LATENCY_MODES` table) and the mode-switch handler.
- **Why:** §8.2. Dropping from `smooth` (350 ms) to `balanced` (180 ms) leaves 170 ms of surplus the
  element will visibly burn off. The supervisor's writes are band-limited; the user's one-shot write
  is not.
- **Fix:** on a user-initiated downgrade, hold the previous target for one frame interval before
  letting it fall, or route the change through the same dwell limiter the supervisor uses.

### 10.9 `<video>` declares no `poster` and no `disablePictureInPicture`

- **Where:** `index.html:81` — `<video id="stream-player" autoplay playsinline muted
  aria-label="Live screen share"></video>`. No `poster`, no `disablepictureinpicture`, no `preload`.
- **Why:** minor for smoothness, but the app *does* implement a PiP button (`app.js:3570-3571` calls
  `player.requestPictureInPicture()`), so the attribute should be a deliberate choice; and a `poster`
  avoids a bare black full-surface repaint during connect — exactly what §3.4 warns about, currently
  papered over by the loader overlay.
- **Fix:** add `disablepictureinpicture` only if click-to-PiP is unwanted; add a `poster` so the
  pre-connect surface is not a bare black rectangle.

### 10.10 "Don't regress it" — no `width`/`height` on the `<video>`, no `backdrop-filter` on its surface

- **Where:** `index.html:81` sizes purely via CSS (`style.css:380-384`); `style.css:362-377` carries
  a long, correct comment forbidding animation, `will-change` and `transform` on `.video-container`.
- **Why:** the container's `aspect-ratio: 16/9` (`style.css:353`) is the only thing holding layout
  before the first frame; adding intrinsic `width`/`height` attributes would change layout on every
  rendition switch. Likewise §3.6: re-adding `will-change`/`transform`/`backdrop-filter` over the
  video would de-promote the overlay with no counter to show it.
- **Fix:** none — add regression tests instead. The repo already has this habit in `js_checks.js` /
  `run_tests.py`; extend it to assert no `will-change`/`transform` lands on `.video-container` and that
  no `playbackRate` write appears in `app.js`.

---

## 11. What to set — the consolidated cheat sheet

| Concern | Set it to | Why |
|---|---|---|
| Display refresh detection | median rAF delta over ≥2 s, visible tab | §4.1 |
| Source frame rate | nearest integer divisor of refresh, ≤60; prefer 30 as the universal safe rate | §4.2 |
| `jitterBufferTarget` | minimum exceeding measured network jitter; step in 50 ms; dwell-limit every write | §7.2 |
| `playoutDelayHint` (if used) | `jitterBufferTarget / 1000` — seconds, not ms | §7.1 |
| `jitterBufferTarget` on audio receiver | do **not** raise; the larger of the two targets applies to both | §7.2(a) |
| Buffer while paused / hidden | freeze the supervisor, not just the watchdog | §8.3 |
| Decode capability gate | `navigator.mediaCapabilities.decodingInfo({type:'webrtc'})`, then verify `powerEfficientDecoder` at runtime | §3.3, §10.6 |
| `degradationPreference` | `maintain-resolution` (already shipped, `app.js:53-56`) | §3.3 |
| `playbackRate` | never write it | §8.5 |
| `preservesPitch` | leave default `true`; never change | §9 |
| `getStats()` cadence | 1 s, shared between HUD and watchdog (already shipped) | §5.1, README 96 |
| `will-change`/`transform`/`filter` on the video surface | never | §3.6 |
| `backdrop-filter` over live video | never | §3.4 |
| Canvas / rAF work that must match video | `requestVideoFrameCallback`, not rAF | §2.1 |
| Presentation-drop detection | `presentedFrames` delta > 1 inside the rVFC callback | §2.2, §10.4 |
| Playback-drift detection | ≥1 s smoothed `ΔmediaTime / Δwall` | §8.4, §10.1 |
| WebCodecs migration | **do not** — `<video>` + `srcObject` is the faster path | §6.2 |

---

## 12. Source index

| Claim area | Source | Locator |
|---|---|---|
| rVFC existence, signature, semantics, Baseline 2024 | MDN, `HTMLVideoElement.requestVideoFrameCallback()` | https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback |
| All seven `VideoFrameCallbackMetadata` field definitions (verbatim) | MDN, same page | as above |
| rVFC normative definition and callback-running algorithm | WHATWG HTML Living Standard, §4.8.8 The video element | https://html.spec.whatwg.org/multipage/media.html |
| rVFC is the spec'd home of the feature (WICG repo retired, HTTP 404) | attempted `github.com/WICG/video-request-video-frame-callback` | — |
| `getVideoPlaybackQuality()`, `totalVideoFrames` caveat (verbatim) | MDN, `HTMLVideoElement.getVideoPlaybackQuality()` | https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/getVideoPlaybackQuality |
| `jitterBufferTarget` IDL, `[[JitterBufferTarget]]` slot, 4000 ms `RangeError`, "gradually observed over time", the delta/delta average-delay formula (all verbatim) | W3C WebRTC-PC, `RTCRtpReceiver` | live: https://w3c.github.io/webrtc-pc/ — local snapshot: `research/pc.html` (lines ~10436-10583) |
| `playoutDelayHint` extension | W3C WebRTC-PC, `RTCRtpSyncRtpControllingExtension` | https://w3c.github.io/webrtc-pc/#dom-rtcsyncrtpcontrollerextension-playoutdelayhint |
| DTX / larger-target coupling text (verbatim) | W3C WebRTC-PC, `jitterBufferTarget` section | `research/pc.html` |
| `framesReceived`, `decoderImplementation`, `powerEfficientDecoder` definitions (verbatim) | W3C WebRTC-Stats, `RTCReceivedRtpStreamStats` | live: https://w3c.github.io/webrtc-stats/ — local snapshot: `research/stats.html` |
| `framesDecoded`, `keyFramesDecoded`, `framesRendered`, `framesDropped`, `frameWidth/Height`, `framesPerSecond`, `totalDecodeTime`, `totalInterFrameDelay`, `totalSquaredInterFrameDelay` | W3C WebRTC-Stats, `RTCInboundRtpStreamStats` | `research/stats.html` (IDL block) |
| `VideoFrame`, `VideoDecoder`, `hardwareAcceleration`, latency mode | W3C WebCodecs Editor's Draft | https://w3c.github.io/webcodecs/ |
| WebCodecs rationale and "canvas over `<video>` presentation" (verbatim) | WebCodecs explainer, w3c/webcodecs | https://github.com/w3c/webcodecs/blob/main/explainer.md |
| `MediaStream` / `srcObject` semantics | W3C WebRTC-PC; `getUserMedia` spec | `research/rec2.html` |
| Repo-specific findings | Direct reads of `app.js`, `index.html`, `style.css`, `codec_bridge.js`, `js_checks.js`, `run_tests.py`, `README.md`, `_probe/whep_probe.js` | commit `26868855` |
| Overlay-promotion rules (§3.6) | **Not directly citable** — corroborated by this repo's shipped fix (`style.css:370-372`, README 84). Chromium source/bug tracker unreachable; see §0.1 | — |

### 12.1 Verifiable crbug component paths (for manual resolution)

Because the tracker itself is unreachable (§0.1), these are the *component* addresses that own each
mechanism, given as paths you can resolve by hand. I am deliberately not attaching invented issue
numbers to them.

| Mechanism in this report | crbug path |
|---|---|
| WebRTC receive pipeline, jitter buffer, `jitterBufferTarget` | `crbug.com/chromium/components/webrtc` |
| Frame scheduling / `VideoFrameCompositor` / `VideoRenderer` | `crbug.com/chromium/components/media` |
| Media element behaviour, playback-quality counters | `crbug.com/chromium/components/blink` |
| Video overlay promotion, `will-change`/`transform` effects | `crbug.com/chromium/components/gpu` |
| Compositor / viz display scheduling | `crbug.com/chromium/components/viz` |

---

## 13. Summary

Frame pacing in a live WebRTC `<video>` viewer is a five-clock problem, and nearly every "janky"
report is a confusion between decode and presentation, or between buffer target and playback rate.

The three things worth remembering:

1. **Measure presentation, not decode.** `presentedFrames` (rVFC) is the only standards-defined
   measure of what the viewer actually saw. `framesDecoded` is not a health signal, and
   `framesPerSecond` is a label, not a measurement.
2. **Every `jitterBufferTarget` write re-paces playout, and lowering it buys latency with discarded
   frames.** A buffer surplus does not sit still — the element spends it by running fast. That is the
   entire mechanism behind "the video speeds up", and it is observable only via `mediaTime`.
3. **The fast path is easy to switch off by accident.** `will-change`, `transform`, `opacity` and
   `backdrop-filter` on or over the video de-promote the hardware overlay with no counter to show it.
   §3.6 is the only cause in this report invisible to every metric discussed in §5.

For this repo specifically, the highest-value additions are, in order: read `mediaTime` (10.1),
compute `renderRatio` (10.2), call `getVideoPlaybackQuality()` (10.3), and detect rVFC cadence
anomalies (10.4) — four small changes that would convert the existing freeze watchdog from a binary
"alive or dead" signal into a continuous smoothness monitor, and would make the single most
user-reported symptom ("it speeds up / slows down") visible for the first time.

---
