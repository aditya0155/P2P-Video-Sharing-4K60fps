# Playout-Delay Control & QoE — Reference Report

**Deliverable for:** `P2P-Video-Sharing-4K60fps` (`Rydius Stream`) viewer app — `app.js`
**Domain:** WebRTC receiver playout-delay control, jitter-buffer sizing, and QoE
**Date of research:** 2026-09-27
**Repo commit audited:** `26868855f94ca9659754780393f352f79d4fb827` (branch `cline/cc25e`)
**Audit target size:** `app.js` = 4354 lines

---

## 0. Scope, method, and honesty notes

This report audits the receiver-side playout-delay control loop in `app.js`: how the
playout/jitter-buffer target is computed, how it is written onto the peer connection, how
often it is permitted to change, and how the resulting drift and freezes are detected.

The units under audit, named in the brief, are:

| # | Unit | Lines | Role |
|---|------|-------|------|
| 1 | `applyPlayoutDelay` | 789-805 | Writes the target onto one `RTCRtpReceiver` |
| 2 | `reapplyBufferTargets` | 834-876 | Band/dwell-gated write across all video receivers |
| 3 | `bufferAccommodationMs` | 701-726 | Pure: drop-gated raise, calm-gated decay of the accommodation term |
| 4 | `jitterBufferFloorMs` | 677-684 | Pure: network-jitter-proportional floor |
| 5 | `superviseAdaptiveBuffer` | 887-1145 | Per-tick supervisor: ABR, decode-pressure, drift, stress/calm |
| 6 | The 1s stats loop | 2676-3025 | Measurement, baseline maintenance, dispatch |
| 7 | The freeze watchdog | 3068-3312 | rVFC + bytes liveness, 3-tier staged recovery |

**Sources.** Primary only: the W3C WebRTC-PC Recommendation, the W3C WebRTC-Stats
specification, MDN, and the local spec snapshots this repo already carries
(`research/pc.html`, `research/stats.html`). Where I quote, the quote is verbatim from one
of those. Where I infer rather than quote, I say so explicitly.

**Honesty note on Chromium sources.** I could not retrieve Chromium's issue tracker or
source browser during this pass (`source.chromium.org` is a JS-only SPA;
`bugs.chromium.org/p/chromium/issues/list` is behind a "Chromium Sign in" interstitial;
`chromium.googlesource.com/.../video_frame_compositor.cc` returned HTTP 503). This report
therefore contains **zero invented crbug issue numbers** — fabricating a plausible-looking
`crbug.com/123456789` would be unverifiable and would poison the citation list. Where a
Chromium-specific behaviour is load-bearing below, I say so and mark it as unverified
against Chromium source.

**Honesty note on one claim I could disprove.** The comment at `app.js:2753-2756` asserts
`framesDiscarded` is "a per-second gauge in the spec". It is not in the spec **at all** —
see §3.2. The surrounding arithmetic happens to be correct; the stated justification is not.

---

## 1. The control surface: what exists and what does not

The application has exactly **one** actuator for playout delay: the
`RTCRtpReceiver.jitterBufferTarget` attribute. It is written in exactly one place
(`app.js:794`).

**Actuators used:**

| Actuator | Used? | Evidence |
|---|---|---|
| `RTCRtpReceiver.jitterBufferTarget` | Yes, 1 write site | `app.js:794` |
| `RTCRtpReceiver.playoutDelayHint` | Written at `app.js:796` — **dead code** | §2.3 |
| `HTMLMediaElement.playbackRate` | **Never touched** | §5.1 |
| `RTCRtpScriptTransform` / insertable streams | Never used | grep: no hits |
| `getStats()` `totalInterFrameDelay` | Never read | §3.4 |
| `getStats()` `jitterBufferTargetDelay` | **Never read** | §4.1 |
| `getStats()` `jitterBufferMinimumDelay` | **Never read** | §4.1 |
| `getStats()` `freezeCount` / `totalFreezesDuration` | **Never read** | §4.2 |
| `getStats()` **audio** `inbound-rtp` | **Never read** | §4.3 |

**The consequence, stated once and plainly:** the controller is **open-loop**. It writes a
target, assumes the write landed, latches its own intent as truth, and regulates every
downstream decision against that intent. The specification provides *three* read-back
statistics that would close this loop; the application reads none of them. This is the
single largest structural gap in the playout-delay path, and §4.1 develops it.

---

## 2. The specification surface

### 2.1 `RTCRtpReceiver.jitterBufferTarget` — the only real API

**IDL** (verbatim from `research/pc.html`):

> `attribute DOMHighResTimeStamp? jitterBufferTarget;`

It is **nullable**. `null` means "no application preference".

**Setter algorithm, abridged** (verbatim from `research/pc.html`):

> Set `receiver`'s `[[JitterBufferTarget]]` internal slot to `target`.
>
> Update the underlying system about the new `target`, or that there is no application
> preference if `target` is `null`.
>
> If `track` is synchronized with another `RTCRtpReceiver`'s track for
> [audio/video synchronization](https://www.rfc-editor.org/rfc/rfc5888#section-7), then the
> user agent SHOULD use the larger of the two receivers' `[[JitterBufferTarget]]` for both
> receivers.

**Range and error** (verbatim):

> If `target` is negative or larger than 4000 milliseconds, then [=exception/throw=] a
> `RangeError`.

**What the UA does on set** (verbatim) — this is the passage that governs every rate-limit
decision in `reapplyBufferTargets`:

> Modifying the jitter buffer target of the underlying system SHOULD affect the internal
> audio or video buffering gradually in order not to hurt user experience. Audio samples or
> video frames SHOULD be accelerated or decelerated before playout, similarly to how it is
> done for [audio/video synchronization](https://www.rfc-editor.org/rfc/rfc5888#section-7)
> or in response to congestion control.
>
> The acceleration or deceleration rate may vary depending on network conditions or the type
> of audio received (e.g. speech or background noise). It MAY take several seconds to achieve
> 1 second of buffering but SHOULD not take more than 30 seconds assuming packets are being
> received. The speed MAY be different for audio and video.

**And the consequence the application is subject to but cannot see** (verbatim):

> For audio, acceleration and deceleration can be measured with
> `insertedSamplesForDeceleration` and `removedSamplesForAcceleration`. For video, this may
> result in the same frame being rendered multiple times or frames may be dropped.

That final clause is the exact mechanism behind every "it speeds up / it slows down"
viewer report, and the application has no instrument to detect it (§4.3, §5.2).

**DTX interaction** (verbatim):

> An average delay is expected even if DTX is used. For example, if DTX is used and packets
> start flowing after silence, larger targets can influence the user agent to buffer these
> packets rather than playing them out.

**Getter semantics** (verbatim): the getter returns the value of the `[[JitterBufferTarget]]`
internal slot — i.e. **the application's own last write, not a measurement.** Reading it
back would prove nothing. The measurement lives in stats (§3).

**WPT coverage** (from the `data-tests` attribute in `research/pc.html`):
`RTCRtpReceiver-jitterBufferTarget.html`, `RTCRtpReceiver-audio-jitterBufferTarget-stats.https.html`,
`RTCRtpReceiver-video-jitterBufferTarget-stats.html`.

Source: <https://w3c.github.io/webrtc-pc/#dom-rtcrtpreceiver-jitterbuffertarget>
(local snapshot: `research/pc.html`).

### 2.2 The "larger of the two" rule — and why writing video only does not contain it

The application writes **only** video receivers (`app.js:858-862`, `app.js:3546-3551`), and
`app.js:848-856` documents the reasoning: a 2200 ms target written to the audio receiver
would, per the rule above, be applied to **both**.

That reasoning is correct, and the video-only choice is the right call. But the comment
concludes "The video never benefits from a target that large" — which is true of the
*video track* and irrelevant to the *system*, because the rule is symmetric. With audio
left at the UA's own default (which is **not** zero — the UA always maintains some minimum)
and video at 2200 ms, the UA is expected to converge both to 2200 ms and to reach it by
decelerating audio playout, i.e. by inserting samples. The application:

* cannot observe `insertedSamplesForDeceleration` (never read — §4.3),
* never reads the audio `inbound-rtp` report at all (§4.3), and
* has an explicit code comment at `app.js:851-853` describing *exactly* this stretching —
  reasoning about a mechanism it has no instrument to confirm or refute.

The write is correctly scoped; the *consequence* is unmeasured. That is the gap.

### 2.3 `playoutDelayHint` is dead code

`app.js:795-796`:

```js
} else if ('playoutDelayHint' in receiver) {
    receiver.playoutDelayHint = targetMs / 1000;
}
```

`RTCRtpReceiver.playoutDelayHint` does not exist in the W3C WebRTC-PC Recommendation, in
MDN's `RTCRtpReceiver` instance-property list, in the Blink IDL, in the Gecko IDL, or in
WPT. It belonged to an abandoned API family (`getPlayoutDelay()` / `setTargetDelay()` /
`targetDelay`) that was renamed before shipping. The unit conversion in the branch
(`targetMs / 1000`, seconds not ms) is correct for a hypothetical seconds-based sibling, so
the branch is *well written* — it simply can never be taken in any shipping browser.

It is harmless dead code rather than a bug, but it misleads a future maintainer into
believing a fallback exists. This is corroborated in the sibling report
`_research/avsync.md` §3 and §7.1.

**Correction to a sibling report.** `_research/smooth.md:520-522` describes
`playoutDelayHint` as "the newer, seconds-based sibling, exposed via
`RTCRtpSyncRtpControllingExtension`" and treats the fallback as meaningful. `_research/avsync.md`
§2.1/§3/§5 reached the opposite conclusion with a broader evidence base (spec + MDN + Blink
IDL + Gecko IDL + WPT). **This report sides with `avsync.md`.** The two sibling reports
disagree and a reader needs to know which is right before acting on either.


---

## 3. The measurement surface

### 3.1 `jitterBufferDelay` / `jitterBufferEmittedCount` — and the delta rule

Both are **session-long cumulative totals**. Verbatim from `research/stats.html`:

> `double jitterBufferDelay;` — The total amount of time spent in the jitter buffer
> (increasing `jitterBufferEmittedCount`).
>
> `unsigned long long jitterBufferEmittedCount;` — The total number of frames emitted from
> the jitter buffer (increasing `jitterBufferDelay`).

And the measurement rule, verbatim from `research/pc.html`:

> The receiver's average jitter buffer delay can be measured as the delta
> `jitterBufferDelay` divided by the delta `jitterBufferEmittedCount`.

The application implements exactly this in `windowedPlayoutDelayMs` (`app.js:645-649`), and
its comment at `app.js:639-644` states the reason correctly. **This is right and should not
be regressed.**

### 3.2 `framesDiscarded` is not in the specification

`research/stats.html` contains **zero** occurrences of `framesDiscarded`. It is a
Chromium-only field, absent from the W3C WebRTC-Stats IDL. The comment at
`app.js:2753-2756` —

> `framesDiscarded` … This is a per-second gauge in the spec, not a cumulative counter, so
> it is read as a level and differenced against the previous level.

— is wrong on both counts: it is not *in* the spec, and in Chromium it is a **cumulative**
counter, not a per-second gauge.

The code's *arithmetic* is nevertheless correct: differencing a cumulative counter is
exactly right, and `discardedLevel - lastFramesDiscarded` (`app.js:2954`) does that. The
gap is a false invariant stated in a comment directly above load-bearing logic — a
maintainer who trusts it could "fix" the differencing into a level read and silently break
decode-pressure detection. The 0-fallback at `app.js:2757-2758` is the right defence
against the Chromium-only field and should stay.

### 3.3 `framesDropped` is cumulative — and it counts the controller's own discards

Verbatim from `research/stats.html`:

> `unsigned long framesDropped` — MUST NOT map/exist for audio. The total number of frames
> dropped prior to decode **or dropped because the frame missed its display deadline** for
> this receiver's track. The measurement begins when the receiver is created and is a
> cumulative metric as defined in Appendix A (g) of [RFC7004].

Two consequences the application does not act on:

1. It is cumulative. The code differences it correctly (`app.js:2796`), so this is fine.
2. **It counts frames dropped for missing their display deadline** — i.e. it counts exactly
   the frames a *deliberate* latency-reduction manoeuvre would discard. It therefore cannot
   distinguish "the network dropped this frame" from "the controller chose to drop this
   frame to catch the live edge".

The comment at `app.js:2803-2806` claims this is handled:

> ticks inside a live-edge catch-up count zero: those are the supervisor's intentional
> late-frame discards, not decode pressure.

**No such catch-up exists in the code** (§5.1). The `dropTickPending` mechanism that
actually implements this (`app.js:2815-2822`) is a *re-baseline* for the first tick after a
(restart, not a catch-up suppressor. The mitigation is written for a code path that was
never built.

### 3.4 Statistics that exist and would close the loop

All present in `research/stats.html`, none read by the application:

| Member | Type | Why it matters here |
|---|---|---|
| `jitterBufferTargetDelay` | `DOMHighResTimeStamp` | The delay the UA is **actually** applying — the true read-back of the write at `app.js:794` |
| `jitterBufferMinimumDelay` | `double` | The UA's **own** floor, "not affected by external mechanisms that increase the jitter buffer target delay, such as `jitterBufferTarget`". If this exceeds the app's target, the app's target is inert and every downstream decision is regulating against a fiction |
| `freezeCount` / `totalFreezesDuration` | `unsigned long` / `double` | The UA's own authoritative freeze accounting |
| `pauseCount` / `totalPausesDuration` | `unsigned long` / `double` | The same for buffering pauses |
| `totalInterFrameDelay` / `totalSquaredInterFrameDelay` | `double` | Rendered-frame inter-frame delay, and the variance that yields it — the only direct measure of the accel/decel the spec warns about |
| `powerEfficientDecoder` | `boolean` | Whether the decode-pressure switch is even necessary |
| `decoderImplementation` | `DOMString` | Distinguishes software AV1 from hardware, which `app.js:983-991` currently *infers* |

Verbatim for `jitterBufferMinimumDelay` from `research/stats.html`:

> This metric works the same way as `jitterBufferTargetDelay`, except that it is not
> affected by external mechanisms that increase the jitter buffer target delay, such as
> `jitterBufferTarget`. The metric is updated every time `jitterBufferEmittedCount` is
> updated.


---

## 4. The read-back surface: closing the loop

Every member in this section is defined in W3C WebRTC-Stats, present in the local snapshot
`research/stats.html`, and **read by no line of `app.js`**. Each subsection gives the exact
definition, units, cumulative-vs-delta, video/audio scope, and the concrete closed-loop use
in this application.

### 4.1 `jitterBufferTargetDelay` — the honest read-back of the write at `app.js:794`

**IDL** (verbatim from `research/stats.html`): `double jitterBufferTargetDelay;`

**Definition** (verbatim):

> This value is increased by the target jitter buffer delay every time a sample is emitted
> by the jitter buffer. The added target is the target delay, in seconds, **at the time that
> the sample was emitted from the jitter buffer**. To get the average target delay, divide
> by `jitterBufferEmittedCount`.

**Units:** seconds — despite the `double` type and despite the name ending in "Delay", it
is a **sum**, not a delay. **Cumulative:** yes, monotonic, like `jitterBufferDelay`.
**Scope:** `RTCReceivedRtpStreamStats`, so it exists for **both audio and video** (the
audio-only `MUST NOT map/exist` restrictions in this table apply to `framesDecoded`,
`framesDropped`, `totalInterFrameDelay`, `freezeCount` etc., not to the jitter-buffer
members).

**The correct windowed-delta formula** — identical in shape to the app's existing
`windowedPlayoutDelayMs` (`app.js:645-649`), and it must be the *delta/delta* form, because
dividing the two cumulative totals directly yields a session average that decays forever
and hides a fresh slip (the exact trap the app already documents at `app.js:639-644`):

```js
// avgTargetDelayMs = mean target delay actually in force over THIS window
const emittedDelta = statsNow.jitterBufferEmittedCount - statsPrev.jitterBufferEmittedCount;
const targetDelta  = statsNow.jitterBufferTargetDelay - statsPrev.jitterBufferTargetDelay;
const avgTargetDelayMs = (emittedDelta > 0) ? (targetDelta / emittedDelta) * 1000 : null;
```

**Detecting a CLAMPED or IGNORED write — the "regulating against a fiction" test.** This is
the key closed-loop use, and it is entirely absent today. At the moment of a write the app
records three things: the value it *intended* (`targetMs`), the value it *latched*
(`lastAppliedTargetMs`, `app.js:869`), and the value it *believes is running* (the HUD,
`app.js:1154-1164`). All three are the same fiction. The measurement:

```js
// after the write has had time to take effect (spec: "several seconds ... SHOULD not take
// more than 30 seconds"), compare what we ASKED for against what the UA REPORTS.
const requestedMs = lastAppliedTargetMs;
const inForceMs   = avgTargetDelayMs;   // windowed delta/delta, above
const uaFloorMs   = avgMinDelayMs;      // windowed jitterBufferMinimumDelay, 4.2
```

Then classify:

| Condition | Diagnosis | Correct response |
|---|---|---|
| `\|inForceMs - requestedMs\| <= 50` | Write landed and converged | Controller is regulating correctly |
| `inForceMs > requestedMs + 50` **and** `uaFloorMs >= inForceMs - 50` | The UA's **own network-derived floor** exceeds our target. Our write is honoured but is *below* what the network needs | Raise toward `uaFloorMs`. Current code instead re-raises against a `granted` figure it invented (`app.js:718`) — a lower bound already known to be wrong |
| `inForceMs > requestedMs + 50` **and** `uaFloorMs < requestedMs` | Something **other** than the network is inflating the buffer: AV sync (the "larger of the two" rule, §2.2), or a UA-internal policy | Do **not** keep raising the video target — it cannot win. Escalate to a diagnostic instead |
| `inForceMs < requestedMs - 50` sustained | The UA is **still converging downward** (spec allows up to 30 s), or it is discarding to reach a lower level | Wait. Do not latch a new target; a write here is what causes visible drops |

**Why this matters concretely.** `bufferAccommodationMs` computes
`granted = Math.max(baseTargetMs, prevMs)` (`app.js:718`) and raises only while
`delayMs > granted + 150` (`app.js:719`). `granted` is derived purely from what the app
*asked for*. If the real in-force target is 400 ms while `granted` says 180 ms — the
`jitterBufferMinimumDelay` scenario of §3.4, entirely plausible on a low-end device — the
measured `delayMs` reads ≈400, clears `180 + 150 = 330`, and the accommodation raises, one
50 ms step per permitted tick, **chasing a floor the UA was never going to go below.** The
controller cannot terminate: every raise re-measures a delay that stays above the target
because the target is not the binding constraint. Feeding `uaFloorMs` into the raise
decision makes the loop provably convergent, because the raise then stops at the one number
that is actually a floor.

A second, cheaper use: `inForceMs` is the correct quantity to show the HUD. Today
`updateBufferHud` prints the *requested* target beside the *measured* delay
(`app.js:1155-1157`) and labels divergence "absorbing" — which reads as the network
absorbing, when it may be the UA ignoring the request entirely.

### 4.2 `jitterBufferMinimumDelay` — the network-derived floor

**IDL** (verbatim): `double jitterBufferMinimumDelay;`

**Definition** (verbatim):

> …it can be useful to keep track of the minimal jitter buffer delay that could have been
> achieved, so WebRTC clients can track the amount of additional delay that is being added.
> This metric works the same way as `jitterBufferTargetDelay`, except that it is not
> affected by external mechanisms that increase the jitter buffer target delay, such as
> `jitterBufferTarget` (see link above), AV sync, or any other mechanisms. This metric is
> purely based on the network characteristics such as jitter and packet loss, and can be
> seen as **the minimum obtainable jitter buffer delay if no external factors would affect
> it**. The metric is updated every time `jitterBufferEmittedCount` is updated.

**Units:** seconds, cumulative. **Scope:** both audio and video.

**Closed-loop use in this app.** Three concrete placements:

1. **Bound `baseBufferTargetMs()` from below by the UA's own floor.** Today the floor is
   synthesized from `videoStats.jitter` by `jitterBufferFloorMs` (`app.js:677-684`), an
   app-side heuristic with a 600 ms cap. The UA is *already computing* the same quantity
   from the same packets, with knowledge of retransmission and loss-burst behaviour the app
   cannot see. `jitterBufferMinimumDelay` should become the primary floor and
   `jitterBufferFloorMs` the fallback for browsers that omit it.
2. **Make the accommodation provably convergent** (see the table in §4.1): the raise target
   becomes `max(requested + 100, uaFloor)`, a real ceiling the measurement can reach,
   instead of `delayMs + 100`, a moving quantity.
3. **Drive the decay honestly.** The accommodation decays 50 ms/tick after 5 calm ticks
   (`app.js:722-724`). It should refuse to decay below `uaFloor`, because decaying under
   the network floor guarantees the re-raise it just came from — the oscillation the
   `app.js:1108-1116` comment was written to eliminate, reintroduced one layer down.

### 4.3 `freezeCount` / `totalFreezesDuration` — the UA's own freeze accounting

**IDL** (verbatim): `unsigned long freezeCount; double totalFreezesDuration;`

**Definition of `freezeCount`** (verbatim):

> Count the total number of video freezes experienced by this receiver. It is a freeze if
> frame duration, which is time interval between two consecutively rendered frames, is equal
> or exceeds Max(3 * avg_frame_duration_ms, avg_frame_duration_ms + 150), where
> `avg_frame_duration_ms` is linear average of durations of last 30 rendered frames.

**Definition of `totalFreezesDuration`** (verbatim):

> Total duration of rendered frames which are considered as frozen (for definition of freeze
> see `freezeCount`), in seconds. This value is updated when a frame is rendered.

**Units:** count, and seconds. **Cumulative:** both yes. **Scope:**
**MUST NOT map/exist for audio** — video only.

**Closed-loop use.** The freeze watchdog (§7) *reimplements* this definition badly: it uses
a hard-coded `FREEZE_THRESHOLD_MS = 3000` (`app.js:270`) applied on a 1.5 s poll, which is
neither frame-rate-adaptive nor the spec's formula. `freezeCount` and
`totalFreezesDuration` are a ground-truth oracle computed by the UA from actual **rendered**
frames, and the app already maintains a rendered-frame counter it could be compared against
(`lastPresentedFrames`, from rVFC `metadata.presentedFrames`, `app.js:3077-3079`). The
correct design:

* **Confirm instantly, react adaptively.** A `freezeCount` delta > 0 between two stats ticks
  is a *spec-defined* freeze already confirmed by the UA. The watchdog should consult its
  own frame-rate-adaptive threshold (arithmetic in §7) rather than re-deriving staleness
  from wall clock alone.
* **Cross-check the detector.** If the watchdog fires recovery but `freezeCount` did not
  advance, the "freeze" was a false positive (hidden tab, paused element, a compositor
  stall the UA does not count) and the recovery ladder is escalating for nothing. That one
  comparison would have caught several false-positive paths described in `README.md`.
* **Measure the true cost of every intervention.** Each `jitterBufferTarget` write re-paces
  playout and "may result in the same frame being rendered multiple times or frames may be
  dropped" (§2.1). `totalFreezesDuration` deltas around each write attribute
  viewer-visible stalls to specific controller actions. Today the app logs the writes
  (`app.js:871-874`) and never measures their effect.

### 4.4 `pauseCount` / `totalPausesDuration` — buffering, distinct from freezing

**IDL** (verbatim): `unsigned long pauseCount; double totalPausesDuration;`

**Definition of `pauseCount`** (verbatim):

> Count the total number of video pauses experienced by this receiver. Video is considered
> to be paused if time passed since last rendered frame exceeds 5 seconds. `pauseCount` is
> incremented when a frame is rendered after such a pause.

**Units:** count, and seconds. **Cumulative:** both yes. **Scope:** video only.

**The 5-second figure is load-bearing for this app.** The spec's *pause* boundary is a
fixed 5 s, and it is strictly longer than the spec's *freeze* threshold at every frame rate
in this project (§7 tabulates them: 24 fps → 200 ms, 30 fps → 200 ms, 50 fps → 210 ms,
60 fps → 250 ms). So a real freeze is always "within" the pause window: a viewer stuck for
3 s has crossed the freeze threshold many times over but has **not** yet crossed 5 s. Two
consequences:

* The app's `FREEZE_THRESHOLD_MS = 3000` sits *between* the spec freeze thresholds
  (200–250 ms here) and the spec pause boundary (5 s). The watchdog is therefore far too
  slow to catch a spec-defined freeze — at 60 fps it lets a 250 ms-equivalent freeze run
  for **twelve times** its proper duration — while still reacting inside the region where
  the UA classifies the video as *freezing*, not *paused*.
* Because `pauseCount` increments only *after a frame is rendered* following the pause, it
  is a lagging indicator: a viewer currently stuck black has already been counted as a
  freeze (if long enough) but not yet as a pause. It is therefore the right signal for
  *post-mortem* severity ("this session had 4 pauses") and the wrong signal for
  *detection*.

**Closed-loop use.** Track `pauseCount`/`totalPausesDuration` per session, surface them in
the diagnostic export alongside the existing `recoveryCount`, and treat a `pauseCount`
advance *not* accompanied by a watchdog recovery as evidence that the watchdog missed a real
event — a self-audit of the detector that costs nothing, since the fields are already in
the same `inbound-rtp` report the stats loop walks.

### 4.5 `totalInterFrameDelay` / `totalSquaredInterFrameDelay` — measuring the re-pacing

**IDL** (verbatim): `double totalInterFrameDelay; double totalSquaredInterFrameDelay;`

**Definition of `totalInterFrameDelay`** (verbatim):

> Sum of the interframe delays in seconds between consecutively rendered frames, recorded
> just after a frame has been rendered. The interframe delay variance be calculated from
> `totalInterFrameDelay`, `totalSquaredInterFrameDelay`, and `framesRendered` according to
> the formula: (`totalSquaredInterFrameDelay` - `totalInterFrameDelay`^2/`framesRendered`)/
> `framesRendered`.

**Units:** seconds, cumulative sums. **Cumulative:** both yes. **Scope:**
`MUST NOT map/exist for audio` — video only.

**Closed-loop use.** This is the only direct instrument for the "video speeds up / slows
down" symptom, because it measures **rendered** frame spacing — the output of the
accel/decel the spec performs when a `jitterBufferTarget` is written:

> Audio samples or video frames SHOULD be accelerated or decelerated before playout … For
> video, this may result in the same frame being rendered multiple times or frames may be
> dropped. (§2.1)

Per-tick variance, windowed with the same delta/delta discipline:

```js
const renderedDelta = framesRendered_now - framesRendered_prev;   // RENDERED frames
const ifdDelta      = totalInterFrameDelay_now       - totalInterFrameDelay_prev;
const ifd2Delta     = totalSquaredInterFrameDelay_now - totalSquaredInterFrameDelay_prev;
const meanIfdMs     = (renderedDelta > 0) ? (ifdDelta / renderedDelta) * 1000 : null;
const meanSqMs2     = (renderedDelta > 0) ? (ifd2Delta / renderedDelta) * 1e6 : 0;
const variance      = Math.max(0, meanSqMs2 - meanIfdMs * meanIfdMs);
```

A spike in this variance in the seconds after a `jitterBufferTarget` write is the
quantitative signature of the re-pacing cost that `reapplyBufferTargets`'s band and dwell
(`app.js:826-828`) currently *assume* rather than *measure*. That scheme was derived by
reasoning about the spec's warning; this statistic would let it be tuned against reality,
and would immediately show whether the 50 ms band / 3000 ms dwell is well calibrated or
still several times too aggressive.

**Caveat, stated so this is not misread:** inbound `framesRendered` and rVFC
`metadata.presentedFrames` (`app.js:3077-3079`) are different counters. The spec formula
names `framesRendered`; rVFC reports the compositor's presented count. They should be
cross-checked once, and if they disagree the discrepancy is itself a finding — decode ≠
render is exactly the GPU/compositor-starvation signature the HUD already tries to surface
at `app.js:2705-2717`.

### 4.6 The unified closed-loop design

The changes above compose into a controller that is provably convergent, where today it is
not:

```
per stats tick:
  1. read jitterBufferTargetDelay, jitterBufferMinimumDelay   (video inbound-rtp)
  2. avgTarget = windowed(delta jitterBufferTargetDelay  / delta emitted)   [4.1]
     uaFloor  = windowed(delta jitterBufferMinimumDelay / delta emitted)   [4.2]
  3. classify the write outcome against lastAppliedTargetMs                  [4.1 table]
       - landed          -> proceed
       - below UA floor  -> raise toward uaFloor (a real ceiling, so it converges)
       - above UA floor  -> do NOT raise; emit a diagnostic instead
  4. accommodation raise = max(requested + 100, uaFloor), drop-gated (gate unchanged)
     accommodation decay = -50ms/tick, but never below uaFloor
  5. latch only UA-confirmed values, so lastAppliedTargetMs stops being a fiction
  6. freeze/pause oracle: freezeCount / totalFreezesDuration cross-check the watchdog
  7. re-pacing cost: totalInterFrameDelay variance attributed to each target write
```

The single highest-value change is steps 1–3: they convert
`bufferAccommodationMs`'s `granted = Math.max(baseTargetMs, prevMs)` (`app.js:718`) from an
app-side guess into a measured, bounded quantity. That is the difference between a
controller that can terminate and one that can chase its own tail to the 2200 ms cap.


---

## 5. Corrections to stale comments in `app.js`

Four comments in the file assert behaviour the code does not have. Each is a trap for the
next maintainer, and each sits directly above load-bearing logic.

### 5.1 `app.js:878-886` — the "hold a ~0 ms target" catch-up that does not exist

The `superviseAdaptiveBuffer` docstring states its second job as:

> 2) Anti-drift: when the browser's measured jitter-buffer delay grows far past the
>    requested target, playout is silently lagging the live edge; hold a ~0ms target briefly
>    so late frames are dropped and the picture snaps back to now instead of drifting
>    seconds behind the host.

**There is no such code path.** `currentBufferTargetMs()` returns
`Math.max(baseBufferTargetMs(), accommodationTargetMs)` (`app.js:782-784`), and
`baseBufferTargetMs()` is `Math.max` over the mode value, the stress raise and the jitter
floor (`app.js:769-778`). Every one of those is `>= 80` (the `ultra` mode minimum,
`app.js:186`). So the smallest target the application can ever write is 80 ms; the 0 ms
catch-up described in the comment is unreachable by construction. Verified: the only
assignment to `jitterBufferTarget` in the file is `app.js:794`, and no code path drives its
argument below 80.

The comment is not merely aspirational — it is **load-bearing for a second comment**.
`app.js:2803-2806` says drop-window ticks "inside a live-edge catch-up count zero: those are
the supervisor's intentional late-frame discards". Since no catch-up exists, no tick is ever
inside one, and the `dropTickPending` logic at `app.js:2815-2822` (which is genuinely a
re-baseline for the first tick after a restart) is doing double duty under a misleading
rationale. This is the same conclusion reached independently in `_research/avsync.md` §6.

**What the code actually does for drift:** nothing, until the delay exceeds
`rejoinCapMs = Math.max(config.driftLimitMs + 1600, 3100)` (`app.js:1045`) for 3 consecutive
fresh ticks, at which point it performs a full rendition switch / WHEP rejoin
(`app.js:1059-1067`). The `driftLimitMs` values (900 / 1000 / 1100, `app.js:186-188`) are
therefore **never used as a threshold** — only as an input to a `Math.max` whose 3100 ms
constant wins in all three modes. A viewer 1.5 s behind the live edge gets no corrective
action whatsoever, even though the code has a named per-mode `driftLimitMs` that reads as
though it should trigger at exactly that point.

### 5.2 `app.js:795-796` — the `playoutDelayHint` "fallback" that can never be taken

> ```js
> } else if ('playoutDelayHint' in receiver) {
>     receiver.playoutDelayHint = targetMs / 1000;
> ```

`RTCRtpReceiver.playoutDelayHint` exists in no shipping browser and in no current
specification (full evidence and the disagreement between the two sibling reports is in
§2.3). The `else` branch at `app.js:797-798` (`return false`) is the honest fallback and is
what actually runs on a browser without `jitterBufferTarget` — i.e. on essentially none of
them, since all shipping engines implement `jitterBufferTarget`. The comment at
`app.js:786-788` ("Returns true when a target was actually written, so callers can avoid
latching a change that never landed") is correct and valuable; the branch it guards is not
reachable.

### 5.3 `app.js:2753-2756` — the `framesDiscarded` "per-second gauge" claim

> The decoder's OWN drops. This is a per-second gauge in the spec, not a cumulative counter,
> so it is read as a level and differenced against the previous level.

`framesDiscarded` does not appear in W3C WebRTC-Stats at all (zero occurrences in
`research/stats.html`); it is a Chromium-only field. The claim is wrong twice: not in the
spec, and cumulative rather than per-second in Chromium. The **code** is right — it
differences, which is correct for a cumulative counter — so this is a documentation-only
defect, but a dangerous one: the comment sits directly above `discardedLevel`
(`app.js:2757-2758`) and the `discardedDelta` computation at `app.js:2954` that feeds
`updateDecodeLag` and therefore the hardware-rendition switch at `app.js:992-1031`. A
maintainer trusting the comment could "correct" the differencing into a level read and
silently disable decode-pressure detection on every browser.

### 5.4 `app.js:2803-2806` — the "live-edge catch-up" that does not exist

Covered in §5.1 above. Listed separately because it is a distinct comment in a distinct
file location, and because it is the one most likely to mislead: it names a specific
mechanism ("the supervisor's intentional late-frame discards") that a reader would
reasonably assume is implemented somewhere. Verifying it requires finding the absence, which
is much harder than verifying a present-but-wrong claim.

### 5.5 A fifth, milder one: `app.js:1041-1042`

> The cap must sit ABOVE the worst legitimate accommodated target (600ms jitter floor +
> 2200ms accommodation + margin) or a fully accommodated rough link would rejoin in a loop

The two terms are combined with `Math.max` at `app.js:783`, not added, so the worst
legitimate target is `max(600, 2200) = 2200 ms`, not 2800 ms. The conclusion (3100 > 2200,
so no rejoin loop) is unaffected, but the arithmetic in the comment is wrong and a future
edit that relies on the "sum" reading would over-provision the cap for no reason.


---

## 6. The drift rejoin is the wrong actuator for reducing buffer surplus

### 6.1 What the code does

When the measured playout delay exceeds `rejoinCapMs` for 3 consecutive fresh ticks
(`app.js:1057-1067`), the supervisor calls `switchRendition(activeStreamPath, …)`, which
stops the freeze watchdog, stops telemetry, tears the connection down via
`cleanupConnection(true)` and performs a full WHEP re-establishment. The same action is
taken on the tab-return path by `maybeRejoinOnReturn` (`app.js:2130-2141`).

`rejoinCapMs = Math.max(config.driftLimitMs + 1600, 3100)` evaluates to **3100 ms in every
mode**, because `driftLimitMs` is at most 1100 (`app.js:188`). The per-mode
`driftLimitMs` values are therefore inert as thresholds.

### 6.2 Why this is the wrong actuator

The problem being solved is "the buffer holds more than we need". The response is "destroy
the session and rebuild it". That is a cost/benefit inversion:

* **Cost is fixed and large.** A WHEP re-establishment tears down ICE, DTLS, the SRTP
  context, the decoder and the jitter buffer, and rebuilds all of them. The app's own
  comment at `app.js:1038-1039` puts the recovery at "2-4s". During that window the viewer
  sees a hard black screen — a categorically worse QoE event than the drift that motivated
  it. A viewer 3.2 s behind live is having a mild annoyance; a viewer black for 3 s is
  having an outage. Trading the first for the second is a bad trade even when the reconnect
  succeeds.
* **It is indiscriminate.** The same action fires for a session 200 ms over the cap as for
  one 30 s over. There is no proportionality.
* **It cannot converge gradually.** Reconnects land the viewer at whatever the UA's own
  default is, and the accommodation controller then re-learns the link from scratch. The
  loop is: inflate → reconnect → re-inflate → reconnect. The `app.js:1108-1116` comment
  describes having already fixed an oscillation of exactly this shape at the *stress raise*
  level; the drift path retains the square wave at a larger amplitude.
* **The `viewerPausedByChoice` interaction makes it worse.** `switchRendition` snapshots
  `player.paused` into `viewerPausedByChoice` and rebuilds anyway. A deliberately paused
  viewer who is 3.2 s behind gets a full session rebuild — and the buffer state that caused
  the drift was itself an artefact of the pause.

### 6.3 The correct actuator, and its hard constraint

The right actuator for surplus buffer is a **gradual, bounded reduction of the
`jitterBufferTarget`**, subject to one hard constraint the design must respect:

> Modifying the jitter buffer target of the underlying system SHOULD affect the internal
> audio or video buffering gradually in order not to hurt user experience. Audio samples or
> video frames SHOULD be accelerated or decelerated before playout … For video, this may
> result in the same frame being rendered multiple times or frames may be dropped. (§2.1)

**A LOWER `jitterBufferTarget` makes the UA discard frames to reach the new level.** This is
stated plainly, and is the reason the app's own comment at `app.js:1110-1113` calls a
single-step release "170ms of frames, 5 dropped at 30fps, on every stress->calm transition".
The correct catch-up is therefore *not* "drop the target to 0" — which is exactly what the
non-existent catch-up at `app.js:883-886` describes, and exactly what would produce the
worst possible artefact.

The design that respects the constraint:

```
catch-up (replaces the >rejoinCap hard reconnect):

  trigger:  measured delay > mode.driftLimitMs  (finally giving driftLimitMs its intended
            meaning) AND no drops in the last 5 ticks AND a healthy, fresh reading
  rate:     reduce the target by at most ONE frame interval per stats tick, i.e.
            stepMs = max(25, round(1000 / observedFps))
            at 30 fps this is 33 ms/tick; at 60 fps 17, floored to 25 ms
  dwell:    reuse the existing BUFFER_TARGET_DWELL_MS (3000 ms), which is what makes
            each step a single re-pace rather than a burst
  floor:    never step below max(mode.ms, jitterBufferFloorMs(currentJitter), uaFloorMs)
            -- i.e. below the level that would start discarding frames on purpose
  budget:   cap the total reduction per session (e.g. 1000 ms) so a genuinely broken
            session still falls through to the reconnect path
  stop:     stop as soon as delay <= driftLimitMs, or any drop appears
  fallthrough: if the budget is exhausted and delay is still over the cap, THEN rejoin
```

**Why one frame interval per tick is the right rate.** The UA discards enough frames to
absorb the step; at one frame interval per tick the discards are one frame per second of
catch-up rather than a visible cluster. This is the same principle already applied, and
correctly documented, in two other places in the file: the stress-raise release ramps at
50 ms per 20 calm ticks (`app.js:1117-1119`) and the accommodation decays at 50 ms/tick
(`app.js:722-724`). The drift path is the one place that skips the ramp entirely and
reaches for a reconnect.

**The measurable success criterion.** With `totalInterFrameDelay` variance instrumented
(§4.5), a correct catch-up shows a *small, bounded* variance spike per step; an incorrect
one shows a spike proportional to the step size. That turns "is the catch-up visible?" from
a judgement call into a number.

**Keep the reconnect — but demote it to a last resort.** It remains right for a genuinely
stale session (the `app.js:1036-1039` hidden-tab scenario is real: presentation suspended,
packets piled up, measured delay 1.7-2.8 s). The distinction should be:

| Measured delay | Reading fresh? | Drops? | Correct action |
|---|---|---|---|
| over `driftLimitMs`, under cap | yes | no | **ramped catch-up** (new) |
| over cap | no (latched / stale) | any | reconnect (existing) |
| over cap | yes | yes | catch-up first; reconnect only if it fails to converge |

Today the first row and the third row both fall straight through to the reconnect.


---

## 7. The freeze watchdog threshold is a fixed 3 s where the spec requires frame-rate adaptivity

### 7.1 What the code uses

`app.js:270`:

> `const FREEZE_THRESHOLD_MS = 3000;  // 3.0s without frame progression when network packets are flowing`

It is used in two places, and **both uses are wrong in the same way**:

* `app.js:3143` — `const isFrameStale = frameStaleness > FREEZE_THRESHOLD_MS;`
* `app.js:3150` — `} else if (now - frozenSince > FREEZE_THRESHOLD_MS) {`

The second is the more serious: it is the *confirmation* window, so total time from a real
freeze beginning to any recovery action is **up to 2 × 3000 ms plus one 1.5 s poll interval
— roughly 7.5 s of frozen picture** before Stage 1 even starts. The comment at
`app.js:3068` ("Zero False Positives") shows the threshold was tuned upward specifically to
avoid false positives, trading detection latency for silence.

### 7.2 What the spec says

`freezeCount` (verbatim from `research/stats.html`):

> Count the total number of video freezes experienced by this receiver. It is a freeze if
> frame duration, which is time interval between two consecutively rendered frames, is equal
> or exceeds Max(3 * avg_frame_duration_ms, avg_frame_duration_ms + 150), where
> `avg_frame_duration_ms` is linear average of durations of last 30 rendered frames.

So the spec threshold is:

```
freezeThresholdMs = max(3 * avg_frame_duration_ms, avg_frame_duration_ms + 150)
```

Two structural properties the fixed 3000 violates:

1. **It is frame-rate dependent.** The `+150` term dominates at every realistic frame rate
   (it only loses to the `3×` term below ~75 fps), so the threshold is effectively
   `avg_frame_duration_ms + 150` — i.e. **150 ms more than one frame interval**. A fixed
   3000 ms is 12–15× that.
2. **It adapts to content.** A 24 fps source legitimately renders a frame every 41.7 ms; a
   stream that has gone 200 ms without a frame is broken at 24 fps and merely jittery at
   4 fps. The `+150` floor is a deliberate absolute slack and the `3×` term is the
   adaptive part that catches genuinely high-rate content. Dropping adaptivity means the
   detector cannot distinguish "no frames because nothing is being sent" from "no frames
   because the decoder is wedged" at different frame rates.

### 7.3 The exact arithmetic for the frame rates this project publishes

`avg_frame_duration_ms = 1000 / fps`:

| fps | `avg_frame_duration_ms` | `3 × avg` | `avg + 150` | **spec threshold (max)** | app's fixed 3000 ms | Over-detection factor |
|---|---|---|---|---|---|---|
| 24 | 41.667 | 125.0 | 191.667 | **192 ms** | 3000 | **15.6×** |
| 30 | 33.333 | 100.0 | 183.333 | **183 ms** | 3000 | **16.4×** |
| 50 | 20.000 | 60.0 | 170.000 | **170 ms** | 3000 | **17.6×** |
| 60 | 16.667 | 50.0 | 166.667 | **167 ms** | 3000 | **18.0×** |

**The `+150` term wins in all four rows** — `3 × avg` never reaches 150 ms until
`avg ≥ 50 ms`, i.e. **20 fps or below**. This project publishes 4K60 and its latency-mode
comments assume 30 fps (e.g. `app.js:1112`, "5 dropped at 30fps"). So in every real
configuration the threshold is simply **`avg_frame_duration_ms + 150`**, and the app's
3000 ms is 12–18× too slow.

The correct implementation:

```js
// avg_frame_duration_ms from the LAST 30 RENDERED frames — the same window the spec names.
// rVFC metadata is the right source: it reports actual presentation, not decode.
const avgFrameDurationMs = meanOfLast30(metadata.expectedDisplayTime deltas);

const freezeThresholdMs = Math.max(3 * avgFrameDurationMs, avgFrameDurationMs + 150);
// 24fps -> 192ms   30fps -> 183ms   50fps -> 170ms   60fps -> 167ms
```

rVFC's `VideoFrameCallbackMetadata` exposes `mediaTime` and `expectedDisplayTime`, either
of which yields the frame interval directly per callback, so the rolling 30-frame window is
a trivial addition inside the existing `onFrame` closure (`app.js:3073-3086`), which already
accumulates `metadata.presentedFrames`.

### 7.4 Correcting the double-threshold mistake, not just the constant

Simply replacing 3000 with ~180 changes *detection* latency but leaves the *confirmation*
structure: with the same constant used for both, total latency is still 2 × threshold. The
two uses need different constants and different reasoning:

```js
const isFrameStale = frameStaleness > freezeThresholdMs;          // spec-defined freeze
// Confirmation must be > 0 but SHORT: the 1.5s poll already provides spacing, and the
// spec's threshold IS the confirmation. Waiting a second threshold-width on top of it
// is what produced the ~7.5s black screen.
if (frozenSince === 0) frozenSince = now;
else if (now - frozenSince > freezeThresholdMs) triggerFreezeRecovery('decoder_stall');
```

The `bytesDelta > 5000 && decodedDelta === 0 && currentDecoded > 0` conjunction
(`app.js:3144`) is a **good** guard and should be kept — it is what distinguishes "decoder
wedged while packets flow" from "publisher stopped sending", and it is why a large fixed
threshold was needed in the first place. The right fix is to make the threshold match the
spec and let the *conjunction* carry false-positive protection, then let `freezeCount`
(§4.3) verify the verdict.

With a 1.5 s poll there is an important interaction: a spec-correct threshold of 167–192 ms
is **far below the poll interval**, so `frameStaleness` can only ever be observed in ~1.5 s
granularity. The threshold therefore buys no precision *in this loop* — a second reason to
drive detection from `freezeCount`, which the UA evaluates per rendered frame, and to use
the app's own threshold only as a cross-check.

### 7.5 How `pauseCount` (5 s) relates

The spec's pause boundary is a **fixed 5 s** (verbatim from `research/stats.html`):

> Video is considered to be paused if time passed since last rendered frame exceeds 5
> seconds. `pauseCount` is incremented when a frame is rendered after such a pause.

The relationship is a strict ordering that the app currently straddles:

```
spec freeze threshold   167-192 ms   (frame-rate adaptive)
   <<<<<<<<
app's FREEZE_THRESHOLD  3000 ms
   <<<<<<<<
spec pause threshold    5000 ms      (fixed)
```

The app's threshold sits in the gap between them, which is the worst possible placement:

* It is **12–18× too slow** relative to what the UA calls a freeze, so a genuine decoder
  wedge runs 3 s before the app admits a problem and ~7.5 s before it acts.
* It is still **below** the pause boundary, so the app reacts while the UA classifies the
  event as *freezing* — the correct classification, reached far too late.

Three concrete uses for `pauseCount` / `totalFreezesDuration` in the watchdog:

1. **Confirm, don't infer.** A `freezeCount` delta between stats ticks is a UA-verified
   freeze. Fire Stage 1 on that rather than on `frameStaleness` arithmetic.
2. **Auto-verify the detector.** If the watchdog escalates and `freezeCount` did not move,
   the event was not a freeze — suppress Stage 2/3 and log a false positive. This
   retroactively validates the "Zero False Positives" goal at `app.js:3068` with a
   measurement instead of a fixed 3 s guess.
3. **Session severity in the diagnostic export.** `totalFreezesDuration` and
   `totalPausesDuration` give the true viewer-visible stall budget for the session, next to
   the existing `recoveryCount`. Today the app reports how many times *it* intervened; it
   cannot report how long the viewer actually saw a frozen picture.

### 7.6 One further watchdog defect, found while auditing the threshold

`app.js:3144` gates on `decodedDelta === 0` — an **exact** zero. But the stats loop
publishes `inboundSnapshot` every ~1 s (`app.js:2761-2765`) while the watchdog polls every
1.5 s (`app.js:3160`), so the snapshot often has not advanced between two polls and
`decodedDelta` is 0 **even during healthy playback**. The guard that prevents false
positives is therefore partly firing on a sampling artefact rather than on a stall — and on a
genuinely slow-but-progressing decode (say 1 frame per 1.5 s at 30 fps) it never fires at
all, because `decodedDelta` is 1, not 0.

The correct predicate is a *rate*, not an equality:

```js
const elapsedMs   = now - snapshot.at;               // actual span of this snapshot delta
const expectedMin = Math.max(1, (observedFps * elapsedMs / 1000) * 0.25);  // 25% of nominal
const isActualDecoderStall = bytesDelta > 5000
    && decodedDelta < expectedMin
    && currentDecoded > 0;
```

This keeps the "packets are flowing but the decoder is not keeping up" semantics, tolerates
the sub-poll sampling artefact, and additionally catches the *partially* wedged decoder that
the current `=== 0` test is blind to.


---

## 8. Consolidated actionable findings, ranked by severity

Severity reflects **viewer-visible QoE impact × likelihood**, not code aesthetics.

| # | Location | Gap | Severity | One-line fix |
|---|---|---|---|---|
| 1 | `app.js:1057-1067`, `2130-2141` | Buffer surplus is corrected with a 2-4 s **hard WHEP reconnect** instead of a ramped catch-up; a viewer 200 ms over the cap gets the same black screen as one 30 s over (§6) | **Critical** | Before the rejoin, ramp the target down by ≤1 frame interval/tick while delay > `mode.driftLimitMs` and no drops; reserve the reconnect for stale readings |
| 2 | `app.js:718-720` | `granted = Math.max(baseTargetMs, prevMs)` is app-side fiction; when the UA's own floor exceeds it the raise loop **cannot terminate** and walks to the 2200 ms cap (§4.1) | **Critical** | Read `jitterBufferMinimumDelay`; set the raise to `max(requested + 100, uaFloor)` and never decay below `uaFloor` |
| 3 | `app.js:3539-3553` | `applyPlayoutDelay`'s return value is **discarded** and `lastAppliedTargetMs` latched unconditionally — re-introducing the "latching a fiction" bug fixed at `app.js:863-868`; a failed write then suppresses all correction for the session | **Critical** | Count successful writes as `app.js:857-868` does, and latch only when `applied > 0` |
| 4 | `app.js:270`, `3143`, `3150` | `FREEZE_THRESHOLD_MS = 3000` is 12–18× the spec threshold (167–192 ms) **and is reused as its own confirmation window**, giving ~7.5 s of black screen before recovery (§7) | **High** | Compute `max(3*avgFrameDur, avgFrameDur + 150)` from a 30-frame rVFC window; use it for detection only, with a one-tick confirmation |
| 5 | `app.js:3144` | `decodedDelta === 0` is an exact equality across a 1.5 s poll of a 1 s snapshot — fires on a sampling artefact during healthy playback, and is blind to a partially wedged decoder (§7.6) | **High** | Replace with a rate test: `decodedDelta < max(1, observedFps * elapsedMs/1000 * 0.25)` |
| 6 | `app.js:2921-2934` | `recentDropAt` is set only on `droppedDelta > 0`, so the 1200 ms emergency dwell bypass is **disabled exactly when `lateFrameEvidence` fires** — the stronger, independent late-frame signal (§3.4) | **High** | Also set `recentDropAt` when `lateFrameEvidence` is true |
| 7 | `app.js:782-784`, `718-724` | The accommodation decays ~20× faster than the stress raise (50 ms/tick vs 50 ms/20 ticks), so it dominates the `Math.max` and **permanently overrides the user's latency mode** once any frame has ever dropped (§4.6) | **High** | Make the accommodation decay at least as slowly as the stress raise, and bound how far it may exceed the mode |
| 8 | `app.js:794` | **No read-back anywhere**: `jitterBufferTargetDelay` and `jitterBufferMinimumDelay` are never read, so `lastAppliedTargetMs` and the HUD display intent, not reality (§4.1) | **High** | Add both to the stats loop; latch/display UA-confirmed values and classify write outcomes per the §4.1 table |

| 9 | `app.js:677-684` | The jitter floor is synthesized from `videoStats.jitter`, which is blind to loss bursts (the app's own comment at `app.js:1130-1137` says so) and blind to the UA's real floor, which the UA already computes | **Medium** | Use `jitterBufferMinimumDelay` as the primary floor; keep `jitterBufferFloorMs` as the fallback when absent |
| 10 | `app.js:2694-2701` | The stats loop reads **only** `kind === 'video'`; zero audio `inbound-rtp`, so `insertedSamplesForDeceleration` and the A/V effects of the video write are invisible despite `app.js:851-853` describing exactly them | **Medium** | Also collect the audio `inbound-rtp` report; log `insertedSamplesForDeceleration` alongside each target write |
| 11 | `app.js:3068`, `3152` | The watchdog infers freezes from wall-clock staleness while the UA publishes `freezeCount`/`totalFreezesDuration` — an authoritative, frame-rate-adaptive oracle that is never read (§4.3) | **Medium** | Trigger Stage 1 on a `freezeCount` delta; use the app threshold as a cross-check and log a false positive when the watchdog fires but `freezeCount` did not move |
| 12 | `app.js:794` | No clamp to the spec's 4000 ms `RangeError` ceiling at the write site; safe today (max 2200) but unguarded against future cap edits (§2.1) | **Medium** | Clamp the value written at `app.js:794` to `[0, 4000]` |
| 13 | `app.js:883-886` | The docstring's anti-drift job ("hold a ~0ms target") **does not exist**; the 80 ms floor makes it unreachable by construction, and `app.js:2803-2806` depends on the fiction (§5.1, §5.4) | **Medium** | Rewrite both comments to describe real behaviour, or implement the §6.3 ramped catch-up they were reaching for |
| 14 | `app.js:2753-2756` | Comment claims `framesDiscarded` is a "per-second gauge in the spec"; it is not in the spec at all and is cumulative in Chromium — directly above load-bearing decode-pressure logic (§5.3) | **Medium** | Correct the comment to "Chromium-only, cumulative; we difference it" — **the code is already right, only the comment is wrong** |
| 15 | `app.js:795-796` | The `playoutDelayHint` fallback can never execute in any shipping browser; it reads as a working fallback and invites future reliance (§2.3, §5.2) | **Low** | Delete the branch; keep the `else { return false; }` fallback |
| 16 | `app.js:826` vs `676` | `BUFFER_TARGET_BAND_MS` and `ADAPTIVE_RAISE_STEP_MS` are both 50, so the ramp passes the band gate by exactly one comparison operator; changing either silently disables or doubles the ramp | **Low** | Add a comment tying them together, or derive the band from the step |
| 17 | `app.js:1041-1042` | Comment computes the worst legitimate target as "600 + 2200"; the terms are `Math.max`-combined, so it is `max(600, 2200) = 2200` (§5.5) | **Low** | Fix the arithmetic in the comment |
| 18 | `app.js:1155-1157` | The HUD shows the *requested* target beside the *measured* delay and labels divergence "absorbing", misattributing a UA-side inflation to the network | **Low** | Show `jitterBufferTargetDelay` (the in-force value) instead of `lastAppliedTargetMs` once §4.1 is in place |

### Do not regress these

Already correct, load-bearing, and in several cases the result of documented past incident
analysis. Any change to the playout-delay path should preserve them.

1. **The windowed delta/delta playout-delay measurement** — `windowedPlayoutDelayMs`
   (`app.js:645-649`). The comment at `app.js:639-644` correctly explains that dividing the
   cumulative totals yields a session average that hides fresh drift; the spec agrees.
2. **The drop-gate on the accommodation raise** — `dropsNow && delayMs > granted + 150`
   (`app.js:719`), and the `lateFrameEvidence` independent signal that replaced gating on
   the biased mean (`app.js:2907-2909`, rationale at `app.js:2893-2906`).
3. **Comparing `granted` rather than the bare base** — `app.js:718`. The comment documents
   the exact failure it fixed: the target walking to the 2200 ms cap in ~19 ticks with
   ~1.1 s of frozen picture. Do not "simplify" this back to `baseTargetMs`.
4. **Latching `lastAppliedTargetMs` only after a receiver accepted the write** —
   `app.js:863-868`. (The manual-mode path at `app.js:3539-3553` fails to do this — finding
   #3 — which is exactly why it is worth preserving in the loop path.)
5. **Video-receivers-only writes** — `app.js:858-862`. Correct per the "larger of the two"
   rule; writing 2200 ms to audio would force audio deceleration and desync.
6. **The `document.hidden` and `player.paused` bail-outs in the supervisor** —
   `app.js:894`, `app.js:905`. Both were added to stop a paused/hidden viewer walking the
   target to the cap and firing rendition switches.
7. **`rebaseThisTick` capturing the drop-pending flag once for both reads** —
   `app.js:2815`, rationale at `app.js:2807-2814`. Reading the flag twice had left the
   tab-return re-baseline as dead code.
8. **The stress-raise ramp-out** — `app.js:1108-1127`. A single-step 350→0 release
   discarded ~5 frames per transition at 30 fps; the 50 ms ramp fixed a visible square-wave
   oscillation.
9. **The freshness test on the drift rejoin** — `avgPlayoutDelayAt < 3000`
   (`app.js:1057-1058`) plus the 3-tick persistence requirement. Without them, three ticks
   containing zero new measurements satisfied "3 consecutive ticks" and forced a full WHEP
   teardown from a single stale reading.
10. **The watchdog reusing the stats loop's snapshot** — `inboundSnapshot`
    (`app.js:3110-3118`) rather than a second `getStats()` walk, with the
    `INBOUND_SNAPSHOT_MAX_AGE_MS` staleness bound.
11. **The `bytesDelta > 5000 && currentDecoded > 0` conjunction** — `app.js:3144`. Only its
    `=== 0` component needs replacing (finding #5); the "packets flowing while decode is
    stalled" semantics are exactly right.
12. **The `Number.isFinite`-guarded stats reads throughout the loop** — Chromium-only
    fields (`framesDiscarded`, `jitterBufferDelay`) are correctly treated as possibly
    absent.

---

## 9. Citation index

| Claim | Source | Local snapshot |
|---|---|---|
| `jitterBufferTarget` IDL, `[[JitterBufferTarget]]` slot, 4000 ms `RangeError`, the "larger of the two" rule, the gradual accel/decel requirement, the 30-second ceiling, the "frames may be dropped" consequence, the DTX note, and the getter-returns-the-slot semantics (all verbatim) | W3C WebRTC-PC, `RTCRtpReceiver` | `research/pc.html`; live: <https://w3c.github.io/webrtc-pc/#dom-rtcrtpreceiver-jitterbuffertarget> |
| WPT coverage for `jitterBufferTarget` | `data-tests` attribute, `research/pc.html` | `research/pc.html` |
| The delta/delta average-delay formula (verbatim) | W3C WebRTC-PC, `jitterBufferTarget` section | `research/pc.html` |
| `jitterBufferDelay` / `jitterBufferEmittedCount` definitions and IDL | W3C WebRTC-Stats, `RTCReceivedRtpStreamStats` | `research/stats.html`; live: <https://w3c.github.io/webrtc-stats/> |
| `jitterBufferTargetDelay` definition, "at the time that the sample was emitted", "divide by `jitterBufferEmittedCount`" (verbatim) | W3C WebRTC-Stats | `research/stats.html` |
| `jitterBufferMinimumDelay` definition, "minimum obtainable jitter buffer delay if no external factors would affect it", "not affected by … `jitterBufferTarget`, AV sync" (verbatim) | W3C WebRTC-Stats | `research/stats.html` |
| `freezeCount` definition, `Max(3 * avg_frame_duration_ms, avg_frame_duration_ms + 150)`, "linear average of durations of last 30 rendered frames" (verbatim) | W3C WebRTC-Stats | `research/stats.html` |
| `totalFreezesDuration` definition (verbatim) | W3C WebRTC-Stats | `research/stats.html` |
| `pauseCount` definition, 5-second boundary, "incremented when a frame is rendered after such a pause" (verbatim) | W3C WebRTC-Stats | `research/stats.html` |
| `totalPausesDuration` definition | W3C WebRTC-Stats | `research/stats.html` |
| `totalInterFrameDelay` / `totalSquaredInterFrameDelay` and the variance formula (verbatim) | W3C WebRTC-Stats | `research/stats.html` |
| `framesDropped` definition, cumulative, "dropped because the frame missed its display deadline" (verbatim) | W3C WebRTC-Stats | `research/stats.html` |
| `framesDiscarded` is **absent** from the specification (0 occurrences) | exhaustive search of the local snapshot | `research/stats.html` |
| `framesReceived`, `decoderImplementation`, `powerEfficientDecoder` | W3C WebRTC-Stats | `research/stats.html` |
| Cumulative-metric convention underlying `framesDropped` | RFC 7004, Appendix A (g), as cited by WebRTC-Stats | — |
| A/V synchronization as the trigger for the larger-of-two rule | RFC 5888, §7, as cited by WebRTC-PC | — |

**Sibling reports, and where this one agrees or differs.** `_research/avsync.md` covers the
A/V-sync and audio-drift surface and reaches the same conclusion that `playoutDelayHint` is
dead code; this report sides with it against `_research/smooth.md:520-522`, which treats the
same property as a real API (§2.3). `_research/smooth.md` covers compositor, frame-pacing
and playback-rate drift; its §10 recommendations (read `mediaTime`, compute `renderRatio`,
call `getVideoPlaybackQuality()`, detect rVFC cadence anomalies) are complementary to §4.5
here and would strengthen the freeze watchdog in §7. No finding in this report contradicts
`_research/smooth.md`; the only disagreement is the `playoutDelayHint` status.
