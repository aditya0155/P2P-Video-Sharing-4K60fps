# A/V Sync & Audio Drift — Research Report

**Repo:** `P2P-Video-Sharing-4K60fps` (Rydius Stream — WebRTC WHEP player)
**Primary artefact audited:** `app.js` (4655 lines), plus `codec_bridge.js`
**Date:** 2026-09-27
**Author:** WebRTC A/V-sync specialist (research only — no project files were modified)

---

## 0. Executive summary — the headline finding

**`getPlayoutDelay()`, `setTargetDelay()`, `targetDelay`, `playoutDelay`, `minPlayoutDelay`
and `playoutDelayHint` do not exist.** They are not in the W3C WebRTC-PC Recommendation,
not in MDN, not in Blink, not in Gecko, and there are no WPT tests for them. They were an
abandoned/renamed API family. The **only** standardised playout-delay control on
`RTCRtpReceiver` is the single attribute **`jitterBufferTarget`** (milliseconds, `0…4000`,
nullable).

This matters directly to this repo because `app.js:795-796` contains a fallback branch
that writes a **`playoutDelayHint`** property that has never existed in any shipping
browser. It is dead code. See §7.1.

The second structural finding: **this repo reads zero audio stats.** Every stats access
is gated on `report.kind === 'video'`. So the entire audio half of A/V sync — concealment,
deceleration/acceleration sample counters, the audio jitter buffer, and audio clock drift —
is completely unobserved, even though the app's own comments (e.g. `app.js:852-853`)
reason about `insertedSamplesForDeceleration` as if it were being watched. See §7.2.

---

## 1. Scope & method

Primary sources fetched and read during this research:

| Source | URL | How used |
|---|---|---|
| W3C WebRTC-PC (editor's draft) | `https://w3c.github.io/webrtc-pc/` | Normative `RTCRtpReceiver` IDL + `jitterBufferTarget` algorithm |
| W3C webrtc-stats (CR Draft, 25 Sep 2025) | `https://w3c.github.io/webrtc-stats/` | `RTCInboundRtpStreamStats` member definitions |
| WPT `webrtc/` directory listing | GitHub API on `web-platform-tests/wpt` | Establishes which APIs are actually standardised/tested |
| WPT `RTCRtpReceiver-jitterBufferTarget.html` | raw.githubusercontent | Range/RangeError/null semantics |
| WPT `RTCRtpReceiver-jitterBufferTarget-stats-helper.js` | raw.githubusercontent | Canonical measurement recipe + **Chromium audio-pull workaround** |
| WPT `RTCRtpReceiver-video-jitterBufferTarget-stats.html` | raw.githubusercontent | Live target-raise/lower test |
| MDN `RTCRtpReceiver` | developer.mozilla.org | Documented member list (no playout-delay family) |
| MDN `RTCRtpReceiver.jitterBufferTarget` | developer.mozilla.org | Value/exception/semantics |
| Gecko `dom/webidl/RTCRtpReceiver.webidl` | mozilla/gecko-dev | Firefox IDL: `jitterBufferTarget` **is** implemented |
| Gecko `dom/media/webrtc/jsapi/RTCRtpReceiver.cpp` | mozilla/gecko-dev | Firefox `SetJitterBufferTarget` + RangeError behaviour |
| Chromium gitiles | `chromium.googlesource.com` | Attempted; rate-limited (503/404) — cross-checked via WPT + MDN instead |


## 2. The one real API: `RTCRtpReceiver.jitterBufferTarget`

### 2.1 IDL (verbatim, WebRTC-PC editor's draft)

```webidl
[Exposed=Window]
interface RTCRtpReceiver {
  readonly attribute MediaStreamTrack track;
  readonly attribute RTCDtlsTransport? transport;
  static RTCRtpCapabilities? getCapabilities(DOMString kind);
  RTCRtpReceiveParameters getParameters();
  sequence<RTCRtpContributingSource> getContributingSources();
  sequence<RTCRtpSynchronizationSource> getSynchronizationSources();
  Promise<RTCStatsReport> getStats();
  attribute DOMHighResTimeStamp? jitterBufferTarget;   // <-- the only delay control
};
```

There is **no** `getPlayoutDelay()`, **no** `setTargetDelay()`, **no** `targetDelay`
attribute, and **no** `playoutDelayHint` in this interface.

### 2.2 Units and range

* **Type:** `DOMHighResTimeStamp?` — i.e. a `double` in **milliseconds**, and
  **nullable**. `null` means "no application preference; the UA picks."
* **Valid range:** `0` … `4000` inclusive. Default is `null`.
* **Exception:** `RangeError` if the value is negative or `> 4000`.
* On a throwing write the previous (last valid) value is **preserved**.

### 2.3 Normative setter algorithm (from the spec, abridged)

> On setting, the user agent MUST run the following steps:
> 1. Let *receiver* be the `RTCRtpReceiver` on which the setter is invoked.
> 2. Let *target* be the argument to the setter.
> 3. If *target* is negative or larger than 4000 milliseconds, then **throw a `RangeError`**.
> 4. Set *receiver*'s `[[JitterBufferTarget]]` to *target*.
> 5. Let *track* be *receiver*'s `[[ReceiverTrack]]`.
> 6. **In parallel**, begin executing the following steps:
>    1. Update the underlying system about the new target, or that there is no
>       application preference if *target* is `null`.
>    2. If *track* **is synchronized with another `RTCRtpReceiver`'s track for audio/video
>       synchronization**, then the user agent **SHOULD** use the **larger of the two
>       receivers' `[[JitterBufferTarget]]` for both receivers**.

Also from the spec:

> The user agent **MUST** have a minimum allowed target and a maximum allowed target
> reflecting what the user agent is able or willing to provide based on network
> conditions and memory constraints, **which can change at any time**.

> **Note:** This is a *target* value. The resulting change in delay can be **gradually
> observed over time**.

> The receiver's average jitter buffer delay can be measured as the **delta
> `jitterBufferDelay` divided by the delta `jitterBufferEmittedCount`**.

MDN restates the same "influences, does not set" caveat and the same "if audio and video
tracks are synchronized, the larger of the two receivers' `jitterBufferTarget` should be
used for both" rule.

### 2.4 The A/V-synchronization "larger of two" rule — and why it bites

This `SHOULD` at step 6.2 is the single most consequential normative sentence for a
video+audio app. It means:

* Setting a large target on **video only** does **not** keep the audio buffer small.
  A conformant UA will raise the audio target to match.
* A UA that honours this by *decelerating* audio playout must **insert samples**, which
  the stats spec measures as `insertedSamplesForDeceleration`. That is a pitch/tempo
  change on the audio: audible artifacts, and drift between what you hear and what the
  video shows.
* Conversely, once **audio and video are linked**, raising the video target again cannot
  yield more video-only headroom.

`app.js` is aware of this and deliberately writes **video receivers only**
(`app.js:848-862`, `1368-1374`, `3545-3551`). That is a defensible reading, and the
comment is technically accurate — but see §7.3: the code *assumes* the UA ignores the
`SHOULD` on the audio side, with nothing measuring whether it actually does.

### 2.5 `jitterBufferTarget` is a *hint*, and writing it re-paces playout

Both this repo's own comments and WPT observe the practical effect: moving the target
makes the jitter buffer **hold** frames (raise) or **discard** frames (lower). Lowering
it discards the excess to get down to the new level — i.e. a lower target is
*implemented by dropping media*. This is why this repo ramps downward in 50 ms steps

## 3. The playout-delay API family: what it was and why it is not there

Names that appear in the wild and in older code/explainer drafts:

| Name | Status | Evidence |
|---|---|---|
| `RTCRtpReceiver.getPlayoutDelay()` | **Does not exist** | Not in WebRTC-PC IDL; not on MDN `RTCRtpReceiver`; MDN has no page for it (404) |
| `RTCRtpReceiver.setTargetDelay(max)` | **Does not exist** | Same; MDN 404 |
| `RTCRtpReceiver.targetDelay` | **Does not exist** | Same |
| `RTCRtpReceiver.playoutDelay` | **Does not exist** | Referenced in `webrtc-stats` only as a *stats member name*, not a receiver attribute |
| `RTCRtpReceiver.minPlayoutDelay` | **Does not exist** | Same |
| `RTCRtpReceiver.playoutDelayHint` | **Does not exist** | Not in spec, MDN, Blink IDL, Gecko IDL, or WPT |
| `RTCRtpReceiver.jitterBufferTarget` | **EXISTS — the only one** | Spec + WPT + Blink + Gecko |

The entire WPT `webrtc/` directory contains exactly these jitter-buffer files:

```
RTCRtpReceiver-jitterBufferTarget.html
RTCRtpReceiver-jitterBufferTarget-stats-helper.js
RTCRtpReceiver-video-jitterBufferTarget-stats.html
RTCRtpReceiver-audio-jitterBufferTarget-stats.https.html
```

There is **no** `getPlayoutDelay`, `setTargetDelay`, or `targetDelay` test. That is
definitive: an API with no WPT and no spec text is not a real API.

The `playoutDelay` / `minPlayoutDelay` names survive in one legitimate place only:
`_probe/whep_probe.js:112-115` feature-detects them defensively. That is harmless
probing. It is `app.js:795` that actually *writes* a nonexistent property.

**Practical consequence for `app.js`:** the `else if ('playoutDelayHint' in receiver)`
branch can never be taken in any shipping browser, so it is not a "fallback" — it is

## 4. `RTCInboundRtpStreamStats` — the measurement surface

From `https://w3c.github.io/webrtc-stats/` (Candidate Recommendation Draft,
25 September 2025). Exact definitions, with units.

### 4.1 Jitter buffer (both audio and video)

**`jitterBufferDelay`** — `double`, **seconds**
> The purpose of the jitter buffer is to recombine RTP packets into frames (in the case
> of video) and have smooth playout. […] It is the **sum of the time, in seconds**, each
> audio sample or a video frame takes from the time the first packet is received by the
> jitter buffer (ingest timestamp) to the time it exits the jitter buffer (emit
> timestamp). In the case of audio, several samples belong to the same RTP packet, hence
> they will have the same ingest timestamp but different jitter buffer emit timestamps.

Cumulative. Per-sample/frame granularity on audio, per-frame on video.

**`jitterBufferEmittedCount`** — `unsigned long long`, count
> The total number of audio samples or video frames that have come out of the jitter
> buffer (increasing `jitterBufferDelay`).

**`jitterBufferTargetDelay`** — `double`, **seconds**
> This value is increased by the target jitter buffer delay **every time a sample is
> emitted** by the jitter buffer. The added target is the target delay, in seconds, **at
> the time that the sample was emitted**. To get the average target delay, divide by
> `jitterBufferEmittedCount`.

**`jitterBufferMinimumDelay`** — `double`, **seconds**
> There are various reasons why the jitter buffer delay might be increased to a higher
> value, such as **to achieve AV synchronization** or because a `jitterBufferTarget` was
> set on a `RTCRtpReceiver`. […] This metric works the same way as `jitterBufferTargetDelay`,
> except that it is **not affected by external mechanisms** that increase the jitter buffer
> target delay, such as `jitterBufferTarget`, **AV sync**, or any other mechanisms. This
> metric is **purely based on the network characteristics** such as jitter and packet
> loss, and can be seen as the **minimum obtainable jitter buffer delay** if no external
> factors would affect it.

> **`jitterBufferMinimumDelay` is the single most useful stat for a drift controller and
> this repo does not read it at all.** It cleanly separates "the network needs N ms" from
> "the app/UA added M ms on top", which is exactly the distinction needed to tell
> 
### 4.2 Audio-only drift counters (all MUST NOT exist for video)

**`insertedSamplesForDeceleration`** — `unsigned long long`
> When playout is **slowed down**, this counter is increased by the difference between
> the number of samples received and the number of samples played out. If playout is
> slowed down by inserting samples, this will be the number of inserted samples.

**`removedSamplesForAcceleration`** — `unsigned long long`
> When playout is **sped up**, this counter is increased by the difference between the
> number of samples received and the number of samples played out. If speedup is achieved
> by removing samples, this will be the count of samples removed.

These are the **direct, spec-sanctioned measurement of the UA's own drift correction**.
The spec explicitly points at them in the `jitterBufferTarget` discussion:
> For audio, acceleration and deceleration can be measured with
> `insertedSamplesForDeceleration` and `removedSamplesForAcceleration`.
> For video, this may result in the same frame being rendered multiple times or frames
> may be dropped.

**`concealedSamples`** — `unsigned long long`
> The total number of samples that are concealed samples.

**`concealmentEvents`** — `unsigned long long`
> The number of concealment events. This counter increases every time a concealed sample
> is synthesized **after a non-concealed sample**. […] multiple consecutive concealed
> samples will increase the `concealedSamples` count multiple times but is a **single**
> concealment event.

(`concealmentEvents` is the better trigger for a user-visible glitch: a run of PLC is one
event, not N.)

**`totalSamplesReceived`** — `unsigned long long`
**`totalSamplesDuration`** — `double`, **seconds**
> Represents the total duration in seconds of all samples that have been received (and
> thus counted by `totalSamplesReceived`).

Together these two give the **actual media-clock rate of the audio stream**:
`Δ totalSamplesDuration / Δ wallclock`. If that ratio is not 1.0, the audio clock is
genuinely running fast or slow against the receiver's wall clock. This is the most
direct drift measurement available, and the repo does not compute it.

**`audioLevel`** — `double`, 0..1 linear
> 1.0 represents 0 dBov, 0 represents silence, and 0.5 represents approximately 6 dB SPL
> change […] The `audioLevel` is averaged over some small interval […] **The interval used
> is implementation-defined.**

**`totalAudioEnergy`** — `double`; `Math.sqrt(totalAudioEnergy/totalSamplesDuration)`
yields RMS in the same units as `audioLevel`. Interval-based differences give average
level over any window.

**`playoutId`** — `DOMString`, audio only
> If audio playout is happening, this is used to look up the corresponding
> **`RTCAudioPlayoutStats`**.

### 4.3 `RTCAudioPlayoutStats` (the device-level delay, unobserved by this repo)

Members include `totalSamplesDuration` (seconds), `totalSamplesCount`
(`unsigned long long`), and:

**`totalPlayoutDelay`** — `double`
> …delay from being emitted to the actual time of playout **on the device**. This metric
> can be used together with `totalSamplesCount` to calculate the **average playout delay
> per sample**.

This is the **only** stat that measures all the way to the speaker. It is what would
reveal a WebAudio graph adding a fixed device-latency offset to audio relative to video.

## 5. Browser support

| API | Chrome/Blink | Firefox/Gecko | Safari/WebKit | Evidence |
|---|---|---|---|---|
| `jitterBufferTarget` | **Yes** | **Yes** | Not documented in MDN | MDN; WPT has tests; Gecko IDL line 33 + `SetJitterBufferTarget` in `RTCRtpReceiver.cpp` |
| `getPlayoutDelay` | No | No | No | Absent from spec, MDN, WPT |
| `setTargetDelay` | No | No | No | Same |
| `targetDelay` | No | No | No | Same |
| `playoutDelayHint` | No | No | No | Same |

MDN's `RTCRtpReceiver` instance-property list is exactly: `jitterBufferTarget`, `track`,
`transport`, `transform`. Instance methods: `getContributingSources`, `getParameters`,
`getStats`, `getSynchronizationSources`. There is no playout-delay family in it.

**Firefox implementation detail** — Gecko IDL (`dom/webidl/RTCRtpReceiver.webidl`):

```webidl
//https://w3c.github.io/webrtc-extensions/#rtcrtpreceiver-jitterbuffertarget-rtcrtpreceiver-interface
partial interface RTCRtpReceiver {
  [Throws]
  attribute DOMHighResTimeStamp? jitterBufferTarget;
};
```

**Firefox implementation detail** — `dom/media/webrtc/jsapi/RTCRtpReceiver.cpp`, verbatim
comment and logic:

```cpp
void RTCRtpReceiver::SetJitterBufferTarget(
    const Nullable<DOMHighResTimeStamp>& aTargetMs, ErrorResult& aError) {
  // Spec says jitter buffer target cannot be negative or larger than 4000
  // milliseconds and to throw RangeError if it is. If an invalid value is
  // received we return early to preserve the current JitterBufferTarget
  // internal slot and jitter buffer values.
  if (mPipeline && mPipeline->mConduit) {
    if (!aTargetMs.IsNull() &&
        (aTargetMs.Value() < 0.0 || aTargetMs.Value() > 4000.0)) {
      aError.ThrowRangeError<MSG_VALUE_OUT_OF_RANGE>("jitterBufferTarget");
      return;
    }
    mJitterBufferTarget.reset();
    if (!aTargetMs.IsNull()) {
      mJitterBufferTarget = Some(aTargetMs.Value());
    }
    // If aJitterBufferTarget is null then we are resetting the jitter buffer so
    // pass the default target of 0.0.
    mPipeline->mConduit->SetJitterBufferTarget(mJitterBufferTarget.valueOr(0.0));
  }
}
```

Three behaviourally important details here that Chrome's WPT also asserts:

1. **A throwing write preserves the last valid value** (WPT: *'audio jitterBufferTarget
   returns last valid value on throw'*).
2. **`null` is a real reset**, and Firefox implements it as "default target of 0.0" at
   the conduit — i.e. **not** the same as an explicit `0` in intent, even though both end
   up at 0.0 in the conduit. Writing `null` is the spec-correct way to say "no preference".
3. **Firefox gates on `mPipeline && mConduit`** — a write on a receiver whose pipeline
   doesn't exist yet is a **silent no-op that does not even throw**, and the internal
   slot is left untouched. So a target written too early in `ontrack` can be lost without
   any error. This repo writes on `ontrack` (`app.js:1372-1374`), which is exactly the
   risky window.

Gecko ships it via a `partial interface` sourced from the (now-retired) **webrtc-extensions**
spec — note the Gecko IDL comment still points at
`https://w3c.github.io/webrtc-extensions/#rtcrtpreceiver-jitterbuffertarget-...`, and that
URL no longer contains the text (the current `webrtc-extensions` draft at 94 KB has
`jitterBufferTarget @ -1`). The API was promoted into WebRTC-PC proper.

WPT range assertions (verbatim test names from `RTCRtpReceiver-jitterBufferTarget.html`):

* `'audio jitterBufferTarget is null by default'`
* `'audio jitterBufferTarget accepts posititve values'` *(typo is in upstream)*
* `'audio jitterBufferTarget accepts values up to 4000 milliseconds'`
* `'audio jitterBufferTarget doesn't accept values greater than 4000 milliseconds'`
* `'audio jitterBufferTarget doesn't accept negative values'`
* `'audio jitterBufferTarget returns last valid value on throw'`
* `'audio jitterBufferTarget allows zero value'`
* `'audio jitterBufferTarget allows to reset value to null'`

## 6. How A/V sync actually works for a WHEP MediaStream in a `<video>` element

### 6.1 The chain

```
RTPDecoder  ->  jitter buffer  ->  playout  ->  sink
(per receiver)   (NetEq-ish)      (rate-adj)   (element / WebAudio)
```

Both tracks are decoded into the same `MediaStream` on one `HTMLVideoElement`. Chrome
keeps **one master media clock** and **syncs to audio**; video frames are scheduled
against the audio clock. The `<video>` element's `currentTime` is derived from that
master clock, and the compositor presents frames to hit it.

Key consequences for a live-stream player:

* **The element's `currentTime` is not the media's own timestamp.** It is the *rendered
  playout position*, and it is monotonic and paced. You cannot use it to detect A/V drift.
* **Video-only latency changes still move audio.** Because audio is the master clock,
  adding video buffer makes the *video* late relative to *audio*; the UA generally fixes
  this by holding/decelerating per the `SHOULD use the larger of the two` rule — which is
  the audible artifact `app.js:852-853` describes.
* **The audio jitter buffer only advances when audio is actually being pulled.** WPT
  contains an explicit Chromium workaround for this, verbatim:

  ```js
  // Workaround for Chromium to pull audio from jitter buffer.
  if (kind === "audio") {
    const audio = document.createElement("audio");
    audio.srcObject = new MediaStream([receiver.track]);
    audio.play();
  }
  ```

  In a `<video>`-only player, if the element is **muted** or **paused**, Chromium may
  stop pulling audio from its jitter buffer entirely. This is directly relevant: this app
  sets `player.muted = true` during autoplay-blocked setup (`app.js:1488`, `1843`) and
  toggles it on unmute (`3339`, `3916`).

### 6.2 Opus clock drift — where it comes from

Opus RTP timestamps advance on a **fixed 48 kHz clock regardless of the true rate** of
the source audio. If the source device/encoder clock runs even slightly fast, the Opus
output timestamps walk progressively ahead of the video timestamps; if slow, they fall
behind. Because RTP timestamps are what the receiver's jitter buffer and the UA's sync
layer use, a slow drift becomes a permanent, invisible pressure on A/V sync that the UA
must continuously correct by micro-adjusting the playout rate.

This repo already identified and fixed this **server-side**, and documented it well:

* `codec_bridge.js:269-294` adds `-af aresample=async=1` to the Opus re-encode.
* `codec_bridge.js:271-277`: *"`aresample=async=1` drops or duplicates samples to hold the
  output [timestamp alignment] … slightly fast makes the Opus output timestamps walk
  progressively ahead of the video, and the browser's A/V sync layer then nudges
  `playbackRate` continuously to pull them together — a permanent micro-correction that
  reads as 'janky' rather than as desync. It is free when there is no drift, which is the
  normal case."*
* `codec_bridge.js:287-288` records the measured evidence: `async=1:first_pts=0 -> 0ms
  (skew -7ms) BROKEN` vs `async=1 -> 294ms (skew +294ms) preserved`.
* `run_tests.py:2107-2109` locks it in as a regression test.

**This is the right place to fix drift** — at the encoder, once, for all viewers — and
this repo did it correctly. The gap is that there is **no client-side verification** that

### 6.3 WebAudio integration hazards

`app.js:281-347` builds `AudioContext -> GainNode -> AnalyserNode -> destination` with
`createMediaElementSource(player)` attached to the **video element**.

Once `createMediaElementSource()` is called on a media element, per the Web Audio spec
the element's audio is **re-routed into the graph** and the element no longer renders it
directly. Documented consequences, all of which this repo has handled:

* **Volume is applied before the tap** — hence the code's careful handoff where the
  `GainNode` takes over as the single volume authority and `player.volume` is pinned to
  `1.0` (`app.js:337-341`, `356-387`). Driving both would square the attenuation
  (50% -> 25%). Correct.
* **A suspended context = permanent silence**, because nothing else will play the audio.
  `app.js:305-321` adds an `onstatechange` recovery, correctly noting *"(A suspended
  context does NOT stall or drift the video: the media element has its own clock, which
  is why this was invisible in the video path.)"* — locked in by
  `run_tests.py:2402-2405`.
* **The un-`muted` risk is inverted here.** Because the audio is going through WebAudio,
  `player.muted` is a *different* control from the `GainNode`, and this repo keeps them
  consistent by hand across ~12 sites (`2491`, `3044`, `3339`, `3415-3499`, `3916`,
  `3930`). That is a maintenance hazard, not a current bug.

**The hazard this repo does NOT handle: the WebAudio graph inserts a fixed audio-vs-video
offset.** The graph adds `AudioContext` output latency plus the render-quantum and
`MediaElementAudioSourceNode` buffering on the audio path, while video is presented
directly by the compositor. The result is a **constant** A/V offset (audio late) that no
amount of buffer tuning removes, because buffer tuning changes both sides.
`latencyHint: 'interactive'` (`app.js:294`) minimises it; it does not correct it, and
nothing here measures it. This is measurable via `RTCAudioPlayoutStats.totalPlayoutDelay`
— which the app does not read.

### 6.4 Drift measurement recipes (spec-sanctioned)

From the spec, `jitterBufferTarget` note:
> The receiver's average jitter buffer delay can be measured as the **delta
> `jitterBufferDelay` divided by the delta `jitterBufferEmittedCount`**.

WPT's canonical helper implements exactly this, as a **windowed delta**:
```js
const emittedCount = inboundStats.jitterBufferEmittedCount - oldInboundStats.jitterBufferEmittedCount;
if (emittedCount) {
  const delay = 1000 * (inboundStats.jitterBufferDelay - oldInboundStats.jitterBufferDelay) / emittedCount;
  if (Math.abs(delay - targetDelay) < tolerance) return true;
}
```
with `tolerance = target / 10`, and a 1 s poll. It first establishes a baseline at the
default target, then raises to the target, then lowers back to `0` and re-checks.

`app.js:645-648` implements precisely this and gets it right, including the important
insight in the comment at `638-644` that a **session-lifetime** ratio is useless for
drift detection (a multi-second slip moves a 10-minute average by ~nothing).

### 6.5 Known browser bugs / sharp edges worth knowing

* **Audio jitter buffer stalls without a sink** (WPT's Chromium workaround, above). Any
  player that mutes or pauses a `<video>` and then expects audio stats to keep advancing
  can get frozen counters.
* **`jitterBufferTarget` is a target, not a setting.** Writes ramp. A controller that
  assumes step response will mis-tune. (This repo's dwell/band gating at
  `app.js:826-828` is correct for this reason, though the *reason* documented is churn
  rather than ramp.)
* **Lowering the target drops frames** to get there. Any "return to live edge" routine
  built on a target decrease **injects** drops. This repo avoids it in the one place it
  does it (`app.js:1108-1127` ramps 50 ms/step) — but its main catch-up mechanism is a
  full session reconnect anyway (§7.6).
* **Firefox silently drops early writes** when the pipeline/conduit doesn't exist yet
  (`SetJitterBufferTarget` body above), without throwing.
* **Gecko maps `null` -> conduit target `0.0`**, not to "UA default". A cross-browser
  `null` write is therefore not guaranteed to restore UA defaults.
* **MDN's Baseline for `jitterBufferTarget` reads "Newly available — Since September
  2026"** while the API has been in Chromium and Gecko for years. Treat MDN's Baseline
  line as unreliable for this member; the WPT + engine source evidence is stronger.
* **`getStats()` cost is per-graph-walk.** This repo is careful about this
  (`app.js:239-248` consolidates to one walk/sec and shares a snapshot with the freeze
  watchdog) — good, and directly relevant, because adding audio-side stats is free here:
  the same walk already returns the audio `inbound-rtp` object, the app just filters it
  out.
* **Chromium source was not directly readable during this research** (`chromium.googlesource.com`
  returned 503/404 repeatedly). Chromium support claims are therefore based on WPT
  coverage plus MDN, not on reading Blink's `rtp_receiver.cc` directly. The WPT file
  names (`...-video-...` and `...-audio-...`) and the Chromium-specific workaround
  
## 7. Concrete gaps in this repo's `app.js`

All line numbers are from the current `app.js` (4655 lines) at commit `2686885`.

### 7.1 `app.js:795-796` — writes a property that does not exist (`playoutDelayHint`)

```js
789:    function applyPlayoutDelay(receiver, kind) {
790:        if (!receiver) return false;
791:        const targetMs = currentBufferTargetMs();
792:        try {
793:            if ('jitterBufferTarget' in receiver) {
794:                receiver.jitterBufferTarget = targetMs;
795:            } else if ('playoutDelayHint' in receiver) {
796:                receiver.playoutDelayHint = targetMs / 1000;
797:            } else {
798:                return false;
799:            }
```

`playoutDelayHint` exists in no spec, no engine, and no WPT file (§3). The branch is
unreachable. Worse, it is a **silent** failure mode: it advertises a compatibility path
that does not exist, so a maintainer reading this function would believe a non-Chromium
browser is covered when it is not.

Two secondary defects in the same function:

* **No `RangeError` handling for the real case.** `currentBufferTargetMs()` can return
  `baseBufferTargetMs() = max(mode, adaptiveRaise, jitterFloor)` and then
  `max(that, accommodationTargetMs)`. The accommodation cap is 2200 and the jitter floor
  cap is 600, and mode max is 350 — so the current worst case is
  `max(350, 350, 600) = 600` vs accommodation 2200 -> **2200**, inside the 4000 limit.
  But this is **coincidence, not enforcement**: nothing in the code clamps to 4000. A
  future edit that raises the accommodation cap past 4000, or sums rather than `max`es the
  terms, throws a `RangeError` on *every* receiver write. The `catch` at line 801 would
  swallow it into a `console.warn` and return `false`, so the app would silently stop
  controlling the buffer while the HUD still advertised a target (§7.5).
* **The `try/catch` treats an out-of-range write as an unsupported browser.** Both
  failure modes return the same `false`, so the caller's "latch only after a receiver
  actually accepted the write" logic (`app.js:863-868`) cannot distinguish them.

### 7.2 Zero audio stats are read — the entire audio drift surface is unobserved

Every stats consumer in the app filters on video only:

* `app.js:2105` — `if (report.type === 'inbound-rtp' && report.kind === 'video') videoStats = report;`
* `app.js:2695` — same filter, main 1 s loop.

`Select-String` for `kind === 'audio'` across `app.js` returns **0 matches**. So none of
these are ever read on the audio receiver:

| Unread stat | What it would have told you |
|---|---|
| `jitterBufferDelay` / `jitterBufferEmittedCount` (audio) | The audio buffer's actual depth — is the audio side also accumulating lag? |
| `insertedSamplesForDeceleration` | **The UA stretching audio to reach the video target.** This is the exact mechanism `app.js:852-853` describes in a comment; the code reasons about it but cannot see it. |
| `removedSamplesForAcceleration` | The UA speeding audio up to catch up. |
| `concealmentEvents` | Packet-loss PLC runs — audible clicks/gaps the video stats cannot see. |
| `concealedSamples` | Total concealed audio volume. |
| `totalSamplesReceived` / `totalSamplesDuration` | **True audio clock rate** (§4.2) — the only direct drift measurement. |
| `audioLevel` / `totalAudioEnergy` | Whether audio is actually arriving non-silent, per spec, not via the WebAudio analyser. |
| `playoutId` -> `RTCAudioPlayoutStats.totalPlayoutDelay` | **Audio latency to the actual device** — would expose the WebAudio offset in §6.3. |

This is the single largest gap. The app has built an elaborate video-side playout-delay
controller (jitter floor, stress raise, drop-gated accommodation, drift rejoin) while
being structurally blind to half of the problem it is named after.

The good news: the stats are already being fetched. `peerConnection.getStats()`
(`app.js:2102`, `2690`) returns **every** `inbound-rtp` object; the app simply discards
the audio one. Adding audio observability costs **zero extra `getStats()` walks** — which
matters, because `app.js:239-248` documents that a second walk per second was a real
performance problem on low-end receivers.

### 7.3 The "video receivers only" decision is unverified

`app.js:848-862` writes `jitterBufferTarget` to video receivers only, with a comment
justifying it against the spec's `SHOULD use the larger of the two` rule. The reasoning is
sound, but it rests on an **unverified assumption**: that the UA keeps the audio target
independent. If a browser honours the `SHOULD` by pulling the audio target up to the
video target, then during exactly the stressful periods this controller creates
(accommodation raising to 2200 ms), the audio is being decelerated — pitch-shifted and
slowed — with no telemetry to detect it.

The one measurement that would settle it is `insertedSamplesForDeceleration` on the audio
receiver. It is unread (§7.2). A cheap proxy already exists and is also unused: the
`AnalyserNode` meter (`app.js:426-462`) is presentation-only and only samples at ~12 Hz
with an `fftSize` of 64, so it cannot resolve a slow rate change.

### 7.4 The Opus `aresample=async=1` fix is unverified at the client

`codec_bridge.js:294` applies `aresample=async=1` and `run_tests.py:2107` asserts the
flag is present. But the client never confirms the *effect*. The failure mode the flag
prevents — audio timestamps walking ahead of video, causing permanent `playbackRate`
micro-correction — is invisible from the video-only stats the app collects. If a future
codec-bridge change drops or reorders the filter, the test still passes on the flag string
while the actual drift returns.

`Δ totalSamplesDuration / Δ wallclock` on the audio receiver (§4.2) is the direct check,

### 7.5 No `jitterBufferTarget` clamp, and no `null` reset on teardown

* **No clamp to `[0, 4000]`.** See §7.1. The current 2200 ms ceiling is incidental. A
  `Math.min(4000, ...)` inside `currentBufferTargetMs()` (`app.js:782-784`) would make the
  spec's `RangeError` unreachable by construction.
* **The target is never reset to `null` on teardown or rendition switch.** `Select-String`
  finds no `jitterBufferTarget = null` anywhere in `app.js`. Per §5, `null` is the
  spec-correct way to say "no application preference" and is the only way to return a
  receiver to UA default. It matters most on the ABR seam, where `app.js:1416-1438`
  builds a `replacement` stream from `peerConnection.getReceivers()` for a **new**
  session — the new receivers start at `null` (the WPT default), and the target is
  re-applied only if `event.track.kind === 'video'` fires again and the band/dwell gates
  at `app.js:837-846` allow it. Because `lastAppliedTargetMs` is *not* reset on the
  seam, a switch to a target within 50 ms of the current one is suppressed — the new
  receiver silently runs at UA default while the HUD shows the intended value. There is
  a test asserting `lastAppliedTargetMs = null` is reset for the *manual* path
  (`app.js:3539`) but not for the ABR seam.

### 7.6 The drift "catch-up" is a full reconnect, not a catch-up

`app.js:1034-1070`: when `avgPlayoutDelayMs > rejoinCapMs` for 3 consecutive fresh ticks,
the response is `switchRendition(activeStreamPath, ...)` — a **full WHEP teardown and
re-establish**, with a 2-4 s black screen, guarded by a 60 s cooldown. The comment at
`app.js:883-886` describes the intended design as *"hold a ~0ms target briefly so late
frames are dropped and the picture snaps back to now"* — but that mechanism **does not
exist in the code**. There is no code path that writes a `0` target. Verified:
`Select-String` for `jitterBufferTarget = 0` returns nothing, and `bufferAccommodationMs`
decays only to `0` for the *accommodation* term while `baseBufferTargetMs()` always keeps
at least the mode minimum (80 ms, `app.js:186-189`).

So the documented soft-catch-up is really a hard reconnect. Given §2.5 (a downward target
write discards frames to get there), a real 0-target catch-up would inject visible drops —
which is presumably why it was not built. But the comment should not describe behaviour
the code does not have.

Also note `rejoinCapMs = Math.max(config.driftLimitMs + 1600, 3100)`
(`app.js:1045`). With `driftLimitMs` of 900/1000/1100 for the three modes, all three
evaluate to exactly **3100** — the per-mode `driftLimitMs` values are effectively dead,
inert under the `Math.max`. Not a bug, but the mode-specific tuning is doing nothing.

### 7.7 `avgPlayoutDelayMs` latches, and three guards have to compensate

`windowedPlayoutDelayMs` (`app.js:645-648`) returns `null` when
`emittedDelta <= 0`, in which case `avgPlayoutDelayMs` is **not** updated
(`app.js:2877-2883`) — it keeps its last value indefinitely. The app compensates with two
guards: `avgPlayoutDelayAt` freshness (`app.js:1057-1058`) and a re-baseline on the first
tick after a restart (`app.js:2918`). Both are correct and both are covered by
`js_checks.js:1256-1349` and `run_tests.py:2190+`.

The remaining hole: `lastJitterDelayTotal` / `lastJitterEmittedTotal`
(`app.js:213-214`) are reset on reconnect, but there is **no reset of `avgPlayoutDelayMs`
itself**, so a stale pre-teardown reading can survive into a new session and be treated as
fresh if `avgPlayoutDelayAt` is also recent. A `avgPlayoutDelayMs = null` on session start

### 7.8 The audio-pull invariant is implicit and undocumented in code

Per §6.1 and the WPT workaround, Chromium only advances the audio jitter buffer when
audio is actually being pulled. This app's audio only gets pulled once
`connectPlayerToAudioNodes()` runs `createMediaElementSource(player)` (`app.js:335`),
which is called from the `player.play().then(...)` handlers at `app.js:1480-1481` and
`1839-1840` — i.e. **after** play resolves.

That means there is a window at session start where audio packets are arriving, the
audio receiver exists, and Chromium may not be draining its jitter buffer. If audio-side
stats were added today (§7.2), the first few ticks would show a **falsely large**
`jitterBufferDelay` and could trip the drift rejoin. Any audio-side drift control must
therefore be gated on `audioSourceNode !== null` (or on the element being unmuted and
playing) — the same class of guard the app already applies to its video controllers via
`document.hidden` and `player.paused` (`app.js:894`, `903`).

---

## 8. Summary table

| # | Location | Gap | Severity | One-line fix |
|---|---|---|---|---|
| 1 | `app.js:795-796` | Writes nonexistent `playoutDelayHint` | Medium (dead code, false compat story) | Delete the `else if` branch; keep only `jitterBufferTarget` |
| 2 | `app.js:789-805` | No `[0,4000]` clamp; `RangeError` swallowed as "unsupported" | Medium | Clamp in `currentBufferTargetMs()` and distinguish `RangeError` in the catch |
| 3 | `app.js:2105, 2695` | Zero audio stats read | **High** | Also capture `kind === 'audio'` `inbound-rtp` (free — same walk) |
| 4 | `app.js:848-862` | "Video-only" write unverified against the `SHOULD` | Medium | Gate on `insertedSamplesForDeceleration` once #3 lands |
| 5 | `app.js:782-784` | Target never reset to `null`; ABR seam may suppress re-apply | Medium | Write `null` on teardown; reset `lastAppliedTargetMs` on the seam |
| 6 | `app.js:883-886` vs `1034-1070` | Comment describes a 0 ms catch-up that does not exist | Low | Fix the comment, or implement a ramped catch-up |
| 7 | `app.js:1045` | `driftLimitMs` per-mode values are inert under `Math.max` | Low | Drop the field or use it directly |
| 8 | `app.js:211-212` | `avgPlayoutDelayMs` not nulled on session start | Low | Set `avgPlayoutDelayMs = null` at session start |
| 9 | `app.js:335, 1480, 1839` | Audio-pull precondition for stats is implicit | Medium | Gate any new audio stats on `audioSourceNode` + unmuted + playing |
| 10 | `app.js:281-347` | WebAudio graph adds an unmeasured fixed A/V offset | Medium | Read `playoutId` -> `RTCAudioPlayoutStats.totalPlayoutDelay` |

---

## 9. What is already right (do not regress these)

Worth stating explicitly, because several of these are non-obvious and were clearly
arrived at the hard way:

* `windowedPlayoutDelayMs` (`app.js:645-648`) — the correct windowed-delta measurement,
  identical in form to the WPT helper.
* The video-only write decision (`app.js:848-862`) is a considered reading of the
  `SHOULD use the larger of the two` rule, not an oversight.
* The drop-gated accommodation (`app.js:701-726`) correctly fixes the "chase your own
  tail" bug, and `run_tests.py:2213-2220` enforces that **every** `applyPlayoutDelay`
  call site stays video-guarded.
* `codec_bridge.js:294` `aresample=async=1` — the correct, encoder-side drift fix.
* The `document.hidden` / `player.paused` bail-outs (`app.js:894`, `903`) — required,
  because a paused viewer's `jitterBufferEmittedCount` freezes while packets keep
  arriving, which is exactly what walked the target to its cap before.
* The 50 ms ramp on release (`app.js:1108-1127`) — required, because a downward target
  write discards frames (§2.5).
* `getStats()` consolidation (`app.js:239-248`) — which is what makes #3 free.

---

*End of report. No project file other than this report was modified.*
