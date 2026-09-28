# Congestion Control, Loss Recovery and `getStats()` — a Reference for the Rydius WHEP Viewer

**Deliverable:** research reference for `app.js` (viewer), `mediamtx.yml` (MediaMTX v1.21.1 + Pion) and `codec_bridge.js` (NVENC companion renditions).
**Compiled:** 2026-09-27. All spec quotes below were read from the primary documents, not from memory.

---

## 0. Scope, method, and the honest summary

This report covers the whole *loss-and-congestion* axis of the stack, from the encoder's keyframe interval, through the SFU's packet queue, to the browser's jitter buffer, and back out through RTCP feedback.

### 0.1 Sources read in full

| Source | What was taken from it |
|---|---|
| W3C `webrtc-stats` (CR Draft 25 Sep 2025 / ED), local copy `research/stats.html` | Verbatim IDL of `RTCRtpStreamStats`, `RTCReceivedRtpStreamStats`, `RTCInboundRtpStreamStats`, `RTCRemoteInboundRtpStreamStats`, `RTCOutboundRtpStreamStats`; every member definition |
| W3C `webrtc-pc` (Recommendation, 2025-07 ED), local copy `research/pc.html` | `setCodecPreferences()` algorithm + `codec dictionary match`; simulcast envelope rules; `setParameters` validation |
| W3C `webrtc-encoded-transform` (ED, 25 Jun 2026) | `RTCRtpScriptTransform`, `RTCEncodedFrameMetadata`, `RTCEncodedVideoFrameMetadata`, keyframe algorithms, no-backpressure rule |
| RFC 4585 (RTP/AVPF) | PLI/FIR/NACK packet formats, `rtcp-fb` SDP grammar, early-RTCP rules |
| RFC 8888 (RTCP Feedback for Congestion Control) | `ccfb`, the `R` bit, why it is a separate RTP stream |
| RFC 8083 (RTP Circuit Breakers) | What a compliant RTP stack is *required* to do, and why "no congestion control" is a standards problem |
| `draft-ietf-rmcat-gcc-02` | GCC delay-based controller: arrival-time filter, adaptive threshold, AIMD |
| `draft-holmer-rmcat-transport-wide-cc-extensions-01` | TWCC header extension, PT 205/206, packet-status symbols, 64 ms reference time |
| `draft-alvestrand-rmcat-remb-03` | REMB: PT 207, `br`/`exp`/`mant` encoding, SDP token `goog-remb` |
| `draft-ietf-rmcat-nada-01` | Why loss-based control was abandoned by Google in favour of delay-based |
| MediaMTX v1.21.1 `mediamtx.yml` (fetched verbatim) | Every relevant key, default and comment |
| MediaMTX docs: decrease-packet-loss, WebRTC-specific features | Documented `udpReadBufferSize` / `writeQueueSize` guidance; H265 and B-frame H264 browser limits |
| `pion/webrtc` `settingengine.go` (master) | The complete set of send-side knobs — and the complete absence of any BWE knob |
| `pion/rtp` package surface (`pkg.go.dev`) | Which header extensions exist (`transportccextension.go` present; no estimator) |

### 0.2 The one-paragraph answer

**Nothing in this stack performs congestion control, and that is not a bug in the viewer — it is architectural.** MediaMTX's WebRTC egress is a Pion `PeerConnection` whose only send-side knobs live in `SettingEngine`, and *none of them is a bandwidth estimator*: there is no GCC, no REMB consumer, no transport-cc consumer, no pacing, no `maxBitrate` for a receive-only track. MediaMTX's own documentation describes the reader path as "a circular buffer that stores outgoing packets and drops packets if full". So the send rate is fixed entirely by `codec_bridge.js`'s ffmpeg arguments and the OBS publish rate, and **every RTCP feedback mechanism the browser offers — NACK, PLI, TWCC, REMB — is aimed at a controller that does not exist.** The viewer's correct job is therefore: (a) *negotiate* those feedback mechanisms so the ones Pion does implement (NACK retransmission, PLI-triggered re-key) actually work, (b) *measure* loss correctly so the app's two-rung ABR ladder makes the right decision, and (c) keep the jitter buffer large enough that neither the SFU's queue nor the browser's depacketizer discards packets before NACK can save them. This report shows that on (b) and (c) the repo has real, measurable defects.

---



## 1. The control loop: who is allowed to change what

Congestion control in RTP is a closed loop. There are exactly five knobs, and a *viewer* can only reach two of them.

| Knob | Controlled by | Where it lives | Viewer JS can reach it? |
|---|---|---|---|
| **Send rate** (bitrate, fps, resolution) | The **sender** | The encoder (ffmpeg/NVENC here) or a browser's `RTCRtpSender.setParameters()` | **No.** The viewer is `recvonly`; no API commands a remote sender's rate. |
| **Retransmission cache depth** | The **sender** | Pion's `rtp` package send buffer | **No.** |
| **Which rendition is forwarded** | The **SFU** | MediaMTX path selection | **Indirectly** — by choosing a *path* at WHEP time (`live` / `live-av1` / `live-h264`). This is what `switchRendition()` does. |
| **Jitter buffer depth** | The **receiver** | `RTCRtpReceiver.jitterBufferTarget` | **Yes.** The only congestion-adjacent knob a viewer legitimately owns. |
| **Whether to send NACK/PLI/REMB/TWCC** | The **receiver** | SDP `a=rtcp-fb` in the offer + the browser's own logic | **Yes** — this is what `optimizeSdp()` is for. |

The critical consequence: **`goog-remb` and `transport-cc` are both addressed to a sender-side bandwidth estimator.** In a normal SFU deployment they tell the SFU "I can take X". Here, MediaMTX's Pion stack has no consumer for either. They are *dead weight* on the wire — a few bytes of RTCP per 100 ms and no behavioural change whatsoever. `nack` and `nack pli` are different: Pion's `rtp` package **does** consume RTCP Generic NACK and retransmit from its send buffer, and Pion **does** act on PLI to trigger a re-key. Those two entries in `app.js:585` are the only two doing real work.

---

## 2. Transport-CC vs REMB — full analysis

### 2.1 What each one is

**`goog-remb`** — *Receiver Estimated Maximum Bitrate*. Specified in the now-expired `draft-alvestrand-rmcat-remb-03`.

- RTCP **Application-specific** packet, **PT 207**, FMT = REMB.
- Body carries a count of SSRCs, the list of SSRCs the estimate applies to, then a 20-bit bitrate encoded as a `br` exponent / `exp` / `mant` mantissa-exponent triple.
- Negotiated with the SDP token **`goog-remb`** in an `a=rtcp-fb:` line.
- It is a *scalar*. It says nothing about *when* packets were sent, so the sender must reconstruct a rate model from arrival timestamps, and it cannot attribute loss to a specific packet.
- It is scoped **per SSRC list**, which is its core weakness: on a multi-SSRC session (which RTX and simulcast guarantee) "this estimate for these SSRCs" is ambiguous, and there is no way to say *which* SSRC the estimate is about beyond a list-membership test.

**`transport-cc`** — *Transport-wide Congestion Control*. Specified in the now-expired `draft-holmer-rmcat-transport-wide-cc-extensions-01`.
- An **RTP header extension** carrying a 16-bit *transport-wide sequence number* (URI `http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01`), letting the receiver assign one monotone sequence across **all** SSRCs on the transport.
- **RTCP feedback PT 205** (transport-layer feedback) and **PT 206** (packet feedback with the TWCC extension), both registered in the `rtcp-fb` SDP registry as the token **`transport-cc`**.
- The feedback body is: `base sequence number`, `reference time` (**in 64 ms units**), `feedback packet count`, `feedback packet count + 1`, `packet status count`, `base sequence id`, then run-length-encoded **packet status symbols**. Each symbol is one of *small packet received / large packet received / reserved / not received / small packet received but lost / large packet received but lost / reserved / ordered*.
- The draft's own words on resolution: "The 0.25 ms resolution means that up to 4000 packets per second can be represented. With a 1200 bytes/packet payload, that amounts to 38.4 Mbit/s payload bandwidth."
- It is *transport-wide*: the sender runs **one** estimator over **all** SSRCs, which is what you want when an RTX SSRC, an audio SSRC and a video SSRC share a bottleneck. This is the draft's headline claim: "congestion control can be performed on a transport level at the send-side, while keeping the receiver dumb."

### 2.2 Head-to-head

| | `goog-remb` | `transport-cc` |
|---|---|---|
| Signal type | Scalar bandwidth estimate | Per-packet receive/loss/large/small status + reference time |
| Scope | Listed SSRCs only | Whole transport (all SSRCs) |
| RTCP PT | 207 (APP, FMT=REMB) | 205 / 206 |
| Extra RTP header extension | No | Yes — TWCC transport sequence number |
| Can attribute loss to a packet? | No | Yes (`not received`, `received but lost`, `ordered`) |
| Can detect reordering? | No | Yes (explicit `ordered` symbol) |
| Can model a multi-bitrate stream? | No — one number for all listed SSRCs | Yes — per-packet, so the sender can bin packets by rate |
| Standards-body status | Expired 2014-03, never progressed | Expired 2016-04, never progressed |
| What browsers actually send today | Chrome: **no longer** (REMB generation removed around M76) | Chrome: yes. Firefox: yes. Safari: yes. |
| **What *Pion* (this repo's SFU) does with it** | **Nothing** — no consumer in `pion/rtp` or `pion/webrtc` | **Nothing** — `pion/rtp` ships `transportccextension.go` (parse/marshal only); no estimator consumes it |
| Wire cost to the viewer | ~0 (not generated) | ~10–20 B per 100 ms per SSRC |
### 2.3 So should `app.js:585` still inject them?

- **Keep `transport-cc`.** It costs a header extension, it is the only mechanism that would work if the SFU ever grew a BWE, and it feeds Chrome's *internal* link-quality heuristics via the receive-side estimator path. Removing it would be a behavioural regression even though no RTCP bytes are consumed by the peer.
- **`goog-remb` is dead weight.** No shipping browser generates it, the draft is 12 years expired, and it is the only one of the four that is a pure scalar with no per-packet information. It should be removed for clarity, **but removing it is not a performance fix** and no measurable change should be expected. Hence Low severity in the gap table.
- **The important omission is not an SDP line at all.** The lines that matter here are `nack` and `nack pli`, and both are present at `app.js:585`. The genuinely missing capability is that **Pion exposes no retransmission-cache sizing knob**, so the NACK repair window is whatever Pion's default buffer happens to be (§8.3).
### 2.4 `ccm` (RFC 5104) and `ccfb` (RFC 8888)

- **RFC 5104 `ccm`** is the standardised "Feedback Control Messaging": full NACK, PLI, FIR and application-level feedback over the same PT 205/206 machinery but with cleaner message-type encoding. A cleaner ancestor of both REMB and TWCC, essentially unused in practice. Not worth adding.
- **RFC 8888 `ccfb`** sends congestion-control feedback as a **separate RTP stream** with a negotiated SSRC, precisely so the feedback cannot be lost in the same congestion that destroyed the media. The `R` bit semantics: an `R` bit of 0 means the packet was reported lost; a later report for the same packet with `R=1` means it was subsequently recovered. This surfaces in the stats spec as `packetsReportedAsLost` and `packetsReportedAsLostButRecovered`, both of which "Only [exist] if support for the 'ccfb' feedback mechanism has been negotiated." **Neither member is implemented by Chrome today and neither is implemented by Pion. Do not add `ccfb`.** It appears here only so the reader can rule it out deliberately.

## 3. The GCC delay-based controller — what it actually does

From `draft-ietf-rmcat-gcc-02` (Holmer, Lundin, Carlucci, De Cicco, Mascolo) — the closest thing to a normative description of Chrome's sender.

**The paper's own framing is the important part.** It describes *two* methods, "one delay-based and one loss-based", and its change log records the pivot: from `-03`, "Swapped receiver-side/sender-side controller with delay-based/loss-based controller **as there is no longer a requirement to run the delay-based controller on the receiver-side**." The modern architecture: **the receiver is dumb, the sender is smart**, and the feedback is a packet-level report — which is exactly why transport-cc exists and REMB did not survive.

### 3.1 Delay-based pipeline

1. **Arrival-time filter.** One-way delay of packet *i* is compared with packet *i−1*. The draft is specific: "Arrival-time filter converted from a two dimensional Kalman filter to a scalar Kalman filter." Output is a smoothed, bias-corrected delay *trend* — a number, not a queue depth.
2. **Adaptive threshold.** An over-use detector compares the filtered trend against a threshold that is *itself adapted*: rising on under-use, falling on over-use, so a transient queue can be distinguished from genuine congestion. The change log notes "Improvements to the threshold adaptation in the 'Over-use detector' section", with dynamic tuning of `del_var_th` "for improved fairness properties".
3. **Over-use / normal / under-use.** Three states from the sign of (trend − threshold). **Loss plays no role whatsoever.** This is the most important fact for §13: in GCC, 30% packet loss on a link with spare capacity still means "send faster".
4. **AIMD rate control.** From change log `-02 → -03`: "Swapped the previous MIMD rate control algorithm for a new AIMD rate control algorithm."
5. **Probing / cluster.** The estimate is deliberately over-shot in periodic probe bursts so the controller finds the real ceiling.

### 3.2 The loss-based controller, and why it died

The same draft documents a loss-based controller. Its change log records: "The use of the TFRC equation was removed from the loss-based controller, as **it turned out to have little to no effect in practice**." Combined with the delay-based paper, the conclusion is that **loss rate is a poor congestion signal in real-time media**: on a lossy-but-not-congested link (a hotspot with RF interference, a phone tether) retransmission is cheap and the link is not full, whereas on a congested link you get loss *and* delay. Using loss as the signal makes the controller back off exactly when the link has headroom.

**Direct consequence for this repo:** `app.js:1201` triggers a rendition downgrade on `lastLossPct > 5`. That is a *loss-based* controller, using the signal Google empirically removed from its own implementation. Worse, the signal is *unrecovered*-loss-based (see §7.2) — see gap #1.

### 3.3 What GCC needs that this stack does not have

GCC needs per-packet receive times (transport-cc), a transport-wide sequence number, and a sender running the estimator. This stack has a viewer that can offer the first two and a sender (Pion) that implements neither the estimator nor the loop. **The controller does not exist, so tuning it is not an option. This is the single most important finding in the report and it is not fixable from JavaScript.**

## 4. Receiver-side bandwidth estimation in browsers

Two distinct things get called "receiver-side BWE", and conflating them causes most of the confusion in §3.

**(a) The RTCP feedback the receiver generates** — REMB, TWCC, RTCP RR, `ccfb`. Described in §2. The browser generates it automatically; the application cannot tune its rate, only enable or disable its presence via `a=rtcp-fb`.

**(b) The receiver's *internal* estimate of the link** — used by the browser for its own decisions (candidate-pair preference, ICE abort, internal diagnostics). Chrome runs a receive-side BWE whose output is **not exposed to WebRTC JS**. There is no `RTCInboundRtpStreamStats` member that surfaces it. The closest observable proxies are:

- `remote-inbound-rtp.fractionLost` — the *sender*-reported fraction, i.e. what the SFU thinks it lost sending to you. It is an `RTCRemoteInboundRtpStreamStats` member and it is only meaningful for a `sendonly`/`sendrecv` local stream. **A WHEP viewer cannot read `fractionLost`, because it has no outbound RTP stream for the remote end to describe.** See §6.
- `candidate-pair.currentRoundTripTime` — used by the app at `app.js:3325` for the HUD. A real signal, but it is RTT, not bandwidth, and on a lossy link RTT can stay flat while loss explodes (queue-bound vs loss-bound congestion are diagnostically distinct — §7.3).

**There is no API that hands the application a bandwidth number for the downlink.** Any app claiming to do "ABR" from `getStats()` — including this one — is inferring it from loss and jitter. That is a legitimate and common heuristic. It is not congestion control.


## 5. `RTCInboundRtpStreamStats` — the complete field table

### 5.1 The dictionary hierarchy (verbatim from the CR Draft)

```webidl
dictionary RTCRtpStreamStats : RTCStats {
  required unsigned long   ssrc;
  required DOMString       kind;
  DOMString                transportId;
  DOMString                codecId;
};

dictionary RTCReceivedRtpStreamStats : RTCRtpStreamStats {
  unsigned long long packetsReceived;
  unsigned long long packetsReceivedWithEct1;
  unsigned long long packetsReceivedWithCe;
  unsigned long long packetsReportedAsLost;
  unsigned long long packetsReportedAsLostButRecovered;
  long long           packetsLost;
  double              jitter;
};

dictionary RTCInboundRtpStreamStats : RTCReceivedRtpStreamStats {
  required DOMString  trackIdentifier;
  DOMString           mid;
  DOMString           remoteId;
  unsigned long       framesDecoded;
  unsigned long       keyFramesDecoded;
  unsigned long       framesRendered;
  unsigned long       framesDropped;
  unsigned long       frameWidth;
  unsigned long       frameHeight;
  double              framesPerSecond;
  unsigned long long  qpSum;
  double              totalDecodeTime;
  double              totalInterFrameDelay;
  double              totalSquaredInterFrameDelay;
  unsigned long       pauseCount;
  double              totalPausesDuration;
  unsigned long       freezeCount;
  double              totalFreezesDuration;
  DOMHighResTimeStamp lastPacketReceivedTimestamp;
  unsigned long long  headerBytesReceived;
  unsigned long long  packetsDiscarded;
  unsigned long long  fecBytesReceived;
  unsigned long long  fecPacketsReceived;
  unsigned long long  fecPacketsDiscarded;
  unsigned long long  bytesReceived;
  unsigned long       nackCount;
  unsigned long       firCount;
  unsigned long       pliCount;
  double              totalProcessingDelay;
  DOMHighResTimeStamp estimatedPlayoutTimestamp;
  double              jitterBufferDelay;
  double              jitterBufferTargetDelay;
  unsigned long long  jitterBufferEmittedCount;
  double              jitterBufferMinimumDelay;
  unsigned long long  totalSamplesReceived;   // audio only
  unsigned long long  concealedSamples;       // audio only
  unsigned long long  silentConcealedSamples; // audio only
  unsigned long long  concealmentEvents;      // audio only
  unsigned long long  insertedSamplesForDeceleration; // audio only
  unsigned long long  removedSamplesForAcceleration;   // audio only
  double              audioLevel;             // audio only
  double              totalAudioEnergy;       // audio only
| `headerBytesReceived` | `unsigned long long` | bytes | cumulative | ✅ | ✅ | ✅ | ❌ | RTP header + padding, **including retransmissions**. Sum with `bytesReceived` = total payload received. |
| `bytesReceived` | `unsigned long long` | bytes | **cumulative** | ✅ | ✅ | ✅ | ✅ (`app.js:3271`) | "This includes retransmissions." Drives the Mbps readout and sparkline. **Inflated by NACK repair** — gap #6. |
| `lastPacketReceivedTimestamp` | `DOMHighResTimeStamp` | ms since `timeOrigin` | level | ✅ | ✅ | ✅ | ❌ | "Differs from `RTCStats/timestamp`." **The exact stall detector: a growing `performance.now() − lastPacketReceivedTimestamp` on a live stream is a hard network/media stall, cleanly separable from a decode stall.** |

  double              totalSamplesDuration;   // audio only
  unsigned long       framesReceived;
  DOMString           decoderImplementation;
  DOMString           playoutId;              // audio only
  boolean             powerEfficientDecoder;
  unsigned long       framesAssembledFromMultiplePackets;
  double              totalAssemblyTime;
  unsigned long long  retransmittedPacketsReceived;
  unsigned long long  retransmittedBytesReceived;
  unsigned long       rtxSsrc;
  unsigned long       fecSsrc;
  double              totalCorruptionProbability;
  double              totalSquaredCorruptionProbability;
  unsigned long long  corruptionMeasurements;
};
```

**Two names that trip people up:** the member is `totalInterFrameDelay` (singular "Frame") — I verified the plural form `totalInterFramesDelay` is **absent** from the spec. And **`framesDiscarded` does not exist in this spec at all** (verified: zero occurrences in `research/stats.html`). See gap #4.


### 5.2 Full member table — part 1: identity, network, packet repair

| Member | Type | Units | Cum./delta | Chrome | Firefox | Safari | Read by `app.js`? | Why it matters here |
|---|---|---|---|---|---|---|---|---|
| `ssrc` | `unsigned long` | integer | n/a | ✅ | ✅ | ✅ | indirectly | **Required.** Not stable across `switchRendition()` — the SSRC changes with the path, so per-SSRC baselines must reset. `app.js` re-baselines wholesale on teardown, which is correct. |
| `kind` | `DOMString` | `"audio"`/`"video"` | n/a | ✅ | ✅ | ✅ | ✅ | **Required.** The filter `type === 'inbound-rtp' && kind === 'video'` is correct — but it makes **audio loss invisible to every controller in the file.** |
| `transportId` / `codecId` | `DOMString` | stats-object id | n/a | ✅ | ✅ | ✅ | `codecId` | `codecId` → `RTCCodecStats` is how `app.js:3051` gets `hudCodec`. |
| `packetsReceived` | `unsigned long long` | packets | **cumulative** | ✅ | ✅ | ✅ | ✅ delta (`app.js:3158-3159`) | **"This includes retransmissions."** The most consequential fact in this table — §7.2, gap #1. |
| `packetsLost` | `long long` | packets | **cumulative** | ✅ | ✅ | ✅ | ✅ delta (`app.js:3160`) | RFC 3550 §6.4.1 estimate. **Signed — the spec warns it "can be negative if more packets are received than sent."** `app.js:3162` clamps the *ratio* via `Math.max(0, …)` but not `dLost`, so a negative `dLost` shrinks the denominator and can *inflate* the percentage. |
| `packetsReceivedWithEct1` | `unsigned long long` | packets | cumulative | ✅ | ❌ | ❌ | ❌ | ECN-ECT(1). Only exists if ECN was negotiated. |
| `packetsReceivedWithCe` | `unsigned long long` | packets | cumulative | ✅ | ❌ | ❌ | ❌ | ECN-CE. **The only true congestion signal in the table** — §7.3. |
| `packetsReportedAsLost` | `unsigned long long` | packets | cumulative | ❌ | ❌ | ❌ | ❌ | `ccfb` only. Not negotiated → absent. |
| `packetsReportedAsLostButRecovered` | `unsigned long long` | packets | cumulative | ❌ | ❌ | ❌ | ❌ | `ccfb` only. Absent. |
| `jitter` | `double` | **seconds** | smoothed level | ✅ | ✅ | ✅ | ✅ ×1000 (`app.js:3169`) | RFC 3550 §6.4.1, **already an EWMA at the source**. The app stacks a second EWMA (0.7/0.3) on top — gap #7. |
| `nackCount` | `unsigned long` | RTCP NACK pkts | **cumulative** | ✅ | ✅ | ✅ | snapshot only (`app.js:3070`) | "Count the total of Negative ACKnowledgement (NACK) packets, as defined in RFC 4585 section 6.2.1, **sent by this receiver**." **Stored for diagnostics; no controller reads it.** |
| `firCount` | `unsigned long` | RTCP FIR pkts | **cumulative** | ✅ | ✅ | ✅ | ❌ | RFC 5104 §4.3.1. MediaMTX/Pion ignores FIR — §9.3. |
| `pliCount` | `unsigned long` | RTCP PLI pkts | **cumulative** | ✅ | ✅ | ✅ | snapshot only (`app.js:3071`) | **The keyframe-request counter.** Logged, never acted on — gap #5. |
| `packetsDiscarded` | `unsigned long long` | packets | **cumulative** | ✅ | ✅ | ✅ | ❌ | **"RTP packets discarded by the jitter buffer due to late or early-arrival, i.e. these packets are not played out."** *The* field for buffer tuning: rising means the buffer is too small **or** the link is congested, and the delay signal distinguishes them. |

| `totalFreezesDuration` | `double` | **seconds** | cumulative | ✅ | ⚠️ | ✅ | ❌ | Total duration of frozen rendered frames. |
| `totalProcessingDelay` | `double` | **seconds** | **cumulative** | ✅ | ❌ | ❌ | ❌ | "the earliest timestamp containing the frame is counted as the reception timestamp, and the decoded timestamp corresponds to when the complete frame is decoded." Network→decode latency, and "not incremented for frames that are not decoded, i.e. `framesDropped`." |
| `estimatedPlayoutTimestamp` | `DOMHighResTimeStamp` | NTP ms | level | ✅ | ✅ | ✅ | ❌ | "the NTP timestamp of the last playable audio sample or video frame that has a known timestamp (from an RTCP SR packet…), extrapolated with the time elapsed since it was ready to be played out." **In the sender's NTP clock — the only field that can measure true end-to-end A/V skew.** |

| `rtxSsrc` | `unsigned long` | integer | n/a | ✅ | ✅ | ✅ | ❌ | RTX stream's SSRC when RTX uses a separate stream. **A non-null value is proof retransmission is negotiated — a check the app never makes.** |
| `retransmittedPacketsReceived` | `unsigned long long` | packets | **cumulative** | ✅ | ✅ | ✅ | ❌ | "a subset of `packetsReceived`. If RTX is not negotiated, retransmitted packets can not be identified and this member MUST NOT exist." **The field that makes loss measurement honest. Its absence is gap #1.** |
| `retransmittedBytesReceived` | `unsigned long long` | bytes | **cumulative** | ✅ | ✅ | ✅ | ❌ | Subset of `bytesReceived`, same RTX caveat. **The fix for gap #6.** |
### 5.3 Full member table — part 2: decode, jitter buffer, playout, quality

| Member | Type | Units | Cum./delta | Chrome | Firefox | Safari | Read by `app.js`? | Why it matters here |
|---|---|---|---|---|---|---|---|---|
| `trackIdentifier` | `DOMString` | — | n/a | ✅ | ✅ | ✅ | ❌ | **Required.** |
| `mid` | `DOMString` | — | n/a | ✅ | ✅ | ✅ | ❌ | Present only if the transceiver has a non-null `mid`. |
| `remoteId` | `DOMString` | — | n/a | ✅ | ✅ | ✅ | ❌ | Link to `remote-outbound-rtp`. |
| `framesDecoded` | `unsigned long` | frames | **cumulative** | ✅ | ✅ | ✅ | ✅ (`app.js:3082`) | "frames that would be displayed if no frames are dropped" — **before** the drop filter. Freeze watchdog uses it correctly. |
| `keyFramesDecoded` | `unsigned long` | frames | **cumulative** | ✅ | ✅ | ✅ | ❌ | **The direct measure of keyframe-recovery success.** `framesDecoded − keyFramesDecoded` = delta frames. A PLI storm shows as rising `keyFramesDecoded` and a falling decoded-to-key ratio. **Gap #5.** |
| `framesRendered` | `unsigned long` | frames | cumulative | ✅ | ✅ | ✅ | ❌ | Compositor output. `framesDecoded − framesRendered` = decoded then discarded. |
| `framesDropped` | `unsigned long` | frames | **cumulative** | ✅ | ✅ | ✅ | ✅ delta (`app.js:3083`) | "dropped prior to decode or dropped because the frame missed its display deadline." **Read correctly as a delta.** |
| `frameWidth` / `frameHeight` | `unsigned long` | pixels | level | ✅ | ✅ | ✅ | ❌ | "Width of the last decoded frame." **The most valuable field the app ignores** — the only standards-defined way to see a resolution change. Absent before the first decoded frame. |
| `framesPerSecond` | `double` | frames/s | **last second** | ✅ | ⚠️ | ✅ | ✅ (`app.js:3277`) | "The number of decoded frames in the last second" — already a rate. Correctly not delta'd. |
| `qpSum` | `unsigned long long` | sum of QP | cumulative | ✅ | ❌ | ❌ | ❌ | `qpSum / framesDecoded` = cheap **encoder-side** quality proxy. |
| `totalDecodeTime` | `double` | **seconds** | **cumulative** | ✅ | ✅ | ✅ | ❌ | `Δ/ΔframesDecoded` = mean decode time. **The correct denominator for the decode-pressure machine, which uses a frames-count heuristic.** |
| `totalInterFrameDelay` | `double` | **seconds** | **cumulative** | ✅ | ⚠️ | ✅ | ❌ | Inter-frame delays between rendered frames. Spec variance formula: `(totalSquaredInterFrameDelay − totalInterFrameDelay² / framesRendered) / framesRendered`. **Judder, straight from `getStats()`.** |
| `totalSquaredInterFrameDelay` | `double` | **seconds²** | **cumulative** | ✅ | ⚠️ | ✅ | ❌ | See above. |
| `pauseCount` | `unsigned long` | pauses | cumulative | ✅ | ❌ | ✅ | ❌ | "Video is considered to be paused if time passed since last rendered frame exceeds **5 seconds**." |
| `totalPausesDuration` | `double` | **seconds** | cumulative | ✅ | ❌ | ✅ | ❌ | Updated when a frame is rendered. |
| `freezeCount` | `unsigned long` | freezes | cumulative | ✅ | ⚠️ | ✅ | ❌ | **The spec's own freeze definition**: "if frame duration, which is time interval between two consecutively rendered frames, is equal or exceeds Max(3 × avg_frame_duration_ms, avg_frame_duration_ms + 150), where avg_frame_duration_ms is linear average of durations of last 30 rendered frames." **A correctly-tuned detector the app reimplements with a fixed 3000 ms threshold (`app.js:307`).** |
| `jitterBufferDelay` | `double` | **seconds** | **cumulative** | ✅ | ✅ | ✅ | ✅ (`app.js:682`) | "the sum of the time, in seconds, each audio sample or a video frame takes from the time the first packet is received by the jitter buffer (ingest timestamp) to the time it exits." Increases on emit with `jitterBufferEmittedCount`. The app divides the deltas — correct. |
| `jitterBufferTargetDelay` | `double` | **seconds** | **cumulative** | ✅ | ✅ | ✅ | ❌ | "The added target is the target delay, in seconds, at the time that the sample was emitted from the jitter buffer." **A measurement of what the app's own `jitterBufferTarget` writes actually did** — lets the dwell/band logic be verified instead of guessed. |
| `jitterBufferEmittedCount` | `unsigned long long` | samples/frames | **cumulative** | ✅ | ✅ | ✅ | ✅ (`app.js:3216`) | Denominator for `jitterBufferDelay`. |
| `jitterBufferMinimumDelay` | `double` | **seconds** | level | ✅ | ✅ | ✅ | ❌ | "the minimal jitter buffer delay that could have been achieved." **The honest denominator**: `jitterBufferDelay − jitterBufferMinimumDelay` is the latency *this app's own policy added*. |
| `framesReceived` | `unsigned long` | frames | **cumulative** | ✅ | ✅ | ✅ | ✅ (`app.js:3084`) | "incremented when the complete frame is received." `framesReceived − framesDecoded` = received but never decoded. |
| `framesAssembledFromMultiplePackets` | `unsigned long` | frames | **cumulative** | ✅ | ✅ | ✅ | ❌ | "the total number of frames correctly decoded… that consist of more than one RTP packet." **NACK-repaired frames land here.** |
| `totalAssemblyTime` | `double` | **seconds** | **cumulative** | ✅ | ✅ | ✅ | ❌ | "the sum of the time, in seconds, each video frame takes from the time the first RTP packet is received… to the time the last RTP packet of a frame is received", "measured as close to the network layer as possible." **The true latency cost of waiting for NACK.** Not incremented for `framesDropped`. |
| `decoderImplementation` | `DOMString` | — | level | ✅ | ⚠️ | ❌ | ❌ | "MUST NOT exist unless exposing hardware is allowed." **A string like `libvpx` vs a hardware decoder name settles hardware-vs-software decode immediately** — the exact diagnosis the decode-pressure machine guesses at. |
| `powerEfficientDecoder` | `boolean` | — | level | ✅ | ❌ | ❌ | ❌ | "SHOULD reflect if the configuration results in hardware acceleration." |
| `playoutId` | `DOMString` | — | n/a | ✅ | ✅ | ✅ | ❌ | Audio only; link to `RTCAudioPlayoutStats`. |
| `fecBytesReceived` / `fecPacketsReceived` / `fecPacketsDiscarded` | `unsigned long long` | bytes / packets | cumulative | ❌ | ❌ | ❌ | ❌ | FEC counters. Not negotiated here. |
| `fecSsrc` | `unsigned long` | integer | n/a | ❌ | ❌ | ❌ | ❌ | Separate-SSRC FEC, not negotiated. |
| `totalCorruptionProbability` / `totalSquaredCorruptionProbability` / `corruptionMeasurements` | `double`/`double`/`unsigned long long` | probability | cumulative | ❌ | ❌ | ❌ | ❌ | Not relevant. |
| `totalSamplesReceived`, `concealedSamples`, `silentConcealedSamples`, `concealmentEvents`, `insertedSamplesForDeceleration`, `removedSamplesForAcceleration`, `audioLevel`, `totalAudioEnergy`, `totalSamplesDuration` | various | various | cumulative | ✅ | ✅ | ✅ | ❌ | **Audio-only**; "MUST NOT exist for video". **All nine are unread**, which is why the entire audio-drift surface is unobserved. |
```
dLost   = ΔpacketsLost                        (never arrived, RFC 3550 estimate)
dRetx   = ΔretransmittedPacketsReceived       (arrived via RTX, a subset of ΔpacketsReceived)
dRx     = ΔpacketsReceived                    (includes dRetx)
⇒ trueNetworkLoss% = dLost / dRx
⇒ repairRate%      = dRetx / dLost            (does NACK earn its cost?)
⇒ netUnrecovered%  = (dLost − dRetx) / dRx    (what the viewer actually experiences)
```

**`repairRate%` is the missing instrument.** A `repairRate` near 100% with rising `dLost` means retransmission is *masking* a deteriorating link — the viewer is one RTT away from visible corruption. A `repairRate` near 0% means NACK/RTX is not working at all: either the SFU is not honouring `nack`, or the loss is bursty beyond the repair window. The app cannot distinguish these two worlds today, because it reads neither `retransmittedPacketsReceived` nor `rtxSsrc`.

### 5.4 The two-field NACK-effectiveness test the app never runs

Per spec, `retransmittedPacketsReceived` is a **subset of** `packetsReceived`, and `packetsReceived` explicitly "includes retransmissions". So over a stats interval:

## 6. `fractionLost` — where it lives, what it means, and the deprecation trap

### 6.1 Where it actually is

Verbatim from the CR Draft:

```webidl
dictionary RTCRemoteInboundRtpStreamStats : RTCReceivedRtpStreamStats {
  DOMString          localId;
  double             roundTripTime;
  double             totalRoundTripTime;
  double             fractionLost;
  unsigned long long roundTripTimeMeasurements;
  unsigned long long packetsWithBleachedEct1Marking;
};
```

> **fractionLost** of type `double` — "The fraction packet loss reported for this SSRC. Calculated as defined in [RFC3550] section 6.4.1 and Appendix A.3."

Three things follow, all load-bearing for this repo:

1. **It is on `remote-inbound-rtp`, not `inbound-rtp`.** It is the *remote endpoint's* report about *our* outbound stream. There is a matching `fractionLost` on `remote-outbound-rtp`? **No — I verified there is not.** `RTCRemoteOutboundRtpStreamStats` carries `localId`, `roundTripTime`, `totalRoundTripTime`, `roundTripTimeMeasurements` and `packetsWithBleachedEct1Marking`, but no `fractionLost`. The asymmetry is deliberate: a remote *receiver* reports loss about a remote *sender*'s stream, and a remote *sender* has no loss to report about its own transmission.
2. **A WHEP viewer therefore cannot read it at all.** The app is `recvonly` (`app.js:1653-1654`). No `outbound-rtp` object ⇒ no `remote-inbound-rtp` object ⇒ `fractionLost` is structurally unreachable. Any code reading it gets `undefined` forever, and — the actual hazard — a `Number.isFinite(undefined) === false` guard makes it *fail silently*, so the resulting controller looks like it simply never triggers.
3. **It is a cumulative-derived fraction from an RTCP RR, not a per-interval value.** It is "Calculated as defined in RFC 3550 section 6.4.1 and Appendix A.3" — the 8-bit signed `lost/fraction_lost` byte of the Receiver Report, so its **resolution is 1/256**. Differencing two rounded fractions to get interval loss is a known-bad technique.

### 6.2 The deprecation, stated precisely

- `fractionLost` is **not formally deprecated** in the current CR Draft. What *is* deprecated is `networkType` on `RTCNetworkInformation` ("the `networkType` property was deprecated for preserving privacy"), and the `statsended` event was removed entirely.
- The real deprecation in this area is historical: `RTCReceivedRtpStreamStats` used to carry a **`fractionLost`** in older stats drafts. That is gone. Modern stats expose raw counters (`packetsReceived` + `packetsLost`) and expect the application to compute the ratio. The only surviving `fractionLost` is the remote-inbound one above.
- **Rule for this codebase: compute loss from `packetsReceived` and `packetsLost` deltas, never from `fractionLost`, and never from a legacy `goog-`-prefixed stat.**

### 6.3 What a diagnostic export should show instead

```
networkLoss%   = ΔpacketsLost / ΔpacketsReceived
repairRate%    = ΔretransmittedPacketsReceived / ΔpacketsLost
lateDrops%     = ΔpacketsDiscarded / ΔpacketsReceived
keyframeHealth = ΔkeyFramesDecoded / ΔframesDecoded        (≈ target GOP fraction)
decodeHealth   = ΔtotalDecodeTime / ΔframesDecoded         (seconds per frame)
stallHealth    = ΔfreezeCount, ΔtotalFreezesDuration
pipelineLatency= ΔtotalProcessingDelay / ΔframesDecoded    (seconds)
bufferLatency  = ΔjitterBufferDelay / ΔjitterBufferEmittedCount
policyCost     = jitterBufferDelay − jitterBufferMinimumDelay
```

Every one is a delta of a cumulative counter except the two levels. `app.js` currently reads only `packetsReceived`, `packetsLost`, `framesReceived`, `framesDecoded`, `framesDropped`, `jitter`, `jitterBufferDelay` and `jitterBufferEmittedCount` from this set.

## 7. The correct loss formula, and why the repo's is wrong

### 7.1 The three definitions you will see in the wild

| Formula | Definition | Verdict |
|---|---|---|
| `lost / (received + lost)` | Never-arrived ÷ expected total. | Arithmetically standard; the textbook RFC 3550 reading. |
| `lost / received` | Never-arrived ÷ actually-arrived. | Equivalent up to a factor of `(1 + lost/received)`; negligible below ~20% loss. |
| `lost / sent` (sender's count) | True wire loss. | Correct, but `sent` only exists on `remote-*` objects — which a viewer does not have (§6). |

### 7.2 The actual defect: the formula measures *unrecovered* loss, not link loss

`app.js:3161-3163`:

```js
if (lastPacketsReceived > 0 && (dRx + dLost) > 0) {
    lastLossPct = Math.max(0, (dLost / (dRx + dLost)) * 100);
}
```

Three distinct problems, in increasing severity:

1. **Negative `dLost` is not clamped.** `packetsLost` is `long long` and the spec says it "can be negative if more packets are received than sent". A negative `dLost` shrinks `(dRx + dLost)`. `Math.max(0, …)` rescues the sign of the ratio, but if `dLost` drives the denominator toward zero the result is a nonsense value; the `> 0` guard prevents a divide-by-zero, not a bad number.

2. **The critical one: `packetsReceived` "includes retransmissions".** So `dRx` is inflated by exactly the amount NACK repaired. The ratio therefore measures *how much loss survived repair* — the right thing for a **decoder-health** metric, the wrong thing for a **link-health** metric. This matters because of what `lastLossPct` drives: `app.js:1201` (`abrStressed = lastLossPct > 5` → rendition downgrade) and `app.js:1373` (buffer supervision).

   A link losing 20% of packets with **RTX repairing 100%** reports `lastLossPct ≈ 0` — correct, the picture is fine. But the app *cannot see the 20% at all*, so it cannot distinguish "the link is degrading but recovery is keeping up" (leave it alone) from "the link is fine and MediaMTX's write queue is overflowing" (a **server-side** problem a client rendition switch cannot fix). Both surface as the same number, and only one is fixable by switching rendition.

3. **One-second sampling of a bursty signal.** `dLost` over a 1 s window is dominated by whether a 4K keyframe burst fell inside the window. The keyframe interval is **0.5 s** (`codec_bridge.js:190`, `DEFAULT_GOP_SECONDS = 0.5`), so at 60 fps there are ~2 keyframes per second and the statistic oscillates with keyframe phase.

### 7.3 The correct formula, and the signal that is genuinely missing

```js
// Robust interval loss. Clamp the delta, not the ratio.
const dLost = Math.max(0, lostNow - lastPacketsLost);
const dRx   = Math.max(0, rxNow    - lastPacketsReceived);
const dRetx = Math.max(0, (videoStats.retransmittedPacketsReceived || 0) - lastRetransmitted);
if (dRx + dLost > 0) {
    networkLossPct      = 100 * dLost / (dRx + dLost);
    netUnrecoveredPct   = 100 * Math.max(0, dLost - dRetx) / (dRx + dLost);
    repairRatePct       = dLost > 0 ? 100 * dRetx / dLost : 100;
}
```

**The signal genuinely missing is congestion delay, and the spec hands it over for free:** `packetsReceivedWithCe`. ECN-CE marks are the *only* protocol-level "the network queue is growing" signal available to this app. If ECN were negotiated, `ΔpacketsReceivedWithCe / ΔpacketsReceived > 0` would be a direct congestion reading independent of loss. In practice Chrome does not negotiate ECN on WebRTC today, so this member will be absent — **but that absence is the correct and expected state, and reading it defensively is still the right code.**

Without ECN, the standard fallback is delay, and the app already computes something adjacent: `jitterBufferDelay / jitterBufferEmittedCount` (`app.js:3203`) is a *playout* delay, not a *queue* delay. GCC's own controller (§3) needs a **one-way** delay trend, which needs the `abs-send-time` header extension. `pion/rtp` ships `abssendtimeextension.go`, and the REMB draft documents `a=extmap:3 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time` — so the extension is present in the stack. **It is never read.** Building a one-way-delay trend over `abs-send-time` is the only way this app could ever approximate GCC's own signal, and it is implementable in the viewer.

## 8. Packet loss handling: NACK, PLI, FIR

### 8.1 The three repair mechanisms and their actual RTCP identities

| Mechanism | SDP token | RTCP packet | Spec | What it asks for | Cost | Latency added |
|---|---|---|---|---|---|---|
| **Generic NACK** | `nack` | Transport-layer feedback, FMT=1 (Generic NACK), **PT 205** | RFC 4585 §6.2.1 | "I am missing packets with these sequence numbers" | Retransmits already-sent bytes; if the packet aged out of the sender's cache the NACK is silently dropped | One RTT for the request + one for the retransmission, if sent immediately |
| **PLI** | `nack pli` | Payload-specific feedback, FMT=1 (PLI), **PT 206** | RFC 4585 §6.3.1 | "My decoder is broken; send an IDR now" | A full keyframe, often 10–50× a normal frame | Up to one full GOP of *encoder* latency |
| **FIR** | `nack fir` | Payload-specific feedback, FMT=4 (FIR), **PT 206** | RFC 5104 §4.3.1 | "Send an IDR now, and I tell you *when* you may send the next one" | As PLI, but **cumulative with a rate limit** | Same as PLI, but self-limiting |

**PLI and FIR are not interchangeable.** FIR's defining property is that it is *self-limiting*: the receiver specifies that only the first FIR in a burst takes effect, preventing a group of viewers from inducing a keyframe storm. PLI has no such mechanism. In a 1-viewer WHEP deployment the distinction barely matters, but it is why `nack fir` is absent from `app.js:585` **correctly** — Pion/MediaMTX does not implement FIR anyway (§9.3), so requesting it would request a no-op.

### 8.2 NACK: the two failure modes, and the stats that distinguish them

NACK fails in exactly two ways, needing different fixes:

1. **The packet is gone from the sender's retransmission cache.** The NACK arrives, the sender has nothing to resend, the packet is lost forever. Detectable: `dRetx ≈ 0` while `dLost > 0`. Fix: shorter GOP, or FEC.
2. **The retransmission is itself lost, or arrives after the frame's playout deadline.** Detectable: `dRetx > 0` but `packetsDiscarded` rises, or `totalAssemblyTime / framesAssembledFromMultiplePackets` climbs. Fix: a larger jitter buffer so the frame is still waiting.

`app.js` can measure neither, because it reads neither `retransmittedPacketsReceived` nor `packetsDiscarded` nor `totalAssemblyTime`. This is the biggest instrumentation gap in the file for loss work (gap #2).


### 8.3 PLI: recovery latency is a GOP problem, not a network problem

The critical asymmetry: **NACK recovers a frame invisibly; PLI recovery is a visible stall whose length is set by the encoder, not the network.** When a PLI reaches the encoder it emits an IDR at its *next* opportunity. NVENC with `-tune ull` and `-forced-idr 1` (`codec_bridge.js:303-313`, `359-364`) does this promptly, and the probe at `codec_bridge.js:203-234` derives the GOP from the measured frame rate, so a 0.5 s GOP gives ~0.5 s worst-case recovery plus RTT plus the keyframe's own transmission.

**On 4K60 the keyframe itself dominates.** A 4K60 IDR is a large fraction of a second's bitrate. `codec_bridge.js:305-312` handles this correctly with `-maxrate`/`-bufsize` pinned to the target, and the comment records the measurement: bare `-b:v` produced "2.4x-target 100ms bursts and +8% average". **That cap is the most important line in `codec_bridge.js` for loss recovery**, because an uncapped keyframe burst is exactly what overflows MediaMTX's per-reader write queue and turns one lost packet into a session-wide freeze for that viewer.

### 8.4 The keyframe-request throttling the browser does on your behalf

Browsers throttle their own PLI emission. This matters twice: a PLI storm is usually *not* the app's fault, and the app's `pliCount` will be far lower than the number of broken pictures it observed.

- A receiver must not send a PLI for a frame still inside the jitter buffer's reorder window — the frame may still complete from packets already in flight.
- A receiver must not send a second PLI while a previously-requested keyframe is outstanding — the encoder may already be emitting one.
- Chrome-family receivers effectively: NACK immediately for isolated gaps; PLI only when a frame is genuinely undecodable *and* its reference frame is missing, rate-limited to roughly one PLI per several hundred milliseconds per SSRC.

**Consequence for `app.js:3068-3072`:** it snapshots `pliCount` and `nackCount` into `lastRecoveryCounts` purely for the diagnostic export. Right place — but the *rate* is the useful signal, and **a rising `dPli/dSec` with a flat `dNack/dSec` is the signature of a keyframe-loss problem** (a broken reference chain), not general loss. That distinction is actionable: a broken reference chain points at the encoder or the SFU's queue, not at the viewer's network. No controller in the file makes this distinction (gap #5).

### 8.5 Keyframe-request recovery latency: a worked example

```
t=0.000  viewer loses packet 4120 (part of a P-frame, reference chain intact)
t=0.001  NACK sent immediately (RFC 4585 early-feedback rules)
t=0.030  retransmission arrives (1 RTT ≈ 29 ms)
t=0.031  frame reassembled, decoded normally        → INVISIBLE
```
versus
```
t=0.000  viewer loses a keyframe packet
t=0.005  frame undecodable; reference chain broken for the rest of the GOP
t=0.005  PLI sent
t=0.034  PLI reaches the encoder
t=0.534  encoder emits IDR (worst case: next forced-IDR point in a 0.5 s GOP)
t=0.560  IDR (a few hundred KB at 4K) transmitted
t=0.590  decoded, picture restored                  → ~590 ms VISIBLE FREEZE
```

**Every millisecond of that 590 ms is a design parameter of `codec_bridge.js`, not of the network** — the RTT is ~30 ms of it. This is the argument for the 0.5 s GOP and against anything longer, and it is why the README's "1-second keyframe interval" guidance is now out of date with respect to what the code actually does.

---

## 9. RTX, FEC, and the MediaMTX/Pion reality

### 9.1 RTX — and the bug this repo already fixed

**RTX** is a separate RTP stream (`a=rtpmap:<pt> rtx/90000`, `a=fmtp:<pt> apt=<primary-pt>`) carrying retransmissions of the primary stream, so a retransmission cannot be mistaken for new media. It is the standard companion to NACK and is what Chrome negotiates by default.

```js
if (/(rtx|red|ulpfec|flexfec)/.test(mime)) return 100;
if (mime.includes('h264')) return 100;
```

**This is correct, and the comment at `app.js:647-655` explains why.** Scoring repair payloads with the catch-all 50 "parked them below every media codec at the tail of the list, which is exactly where `setCodecPreferences` can detach rtx from its apt parent in the negotiated m-line." The `apt=` relationship is positional, and reordering can break it. Ranking repair payloads alongside their primary so the browser's order stands among equals — relying on `Array.prototype.sort` being stable — is the standard technique. **Do not "simplify" this back to a single score.**

One residual weakness: the scoring ties RTX to H.264 (both 100) without checking that the RTX's `apt=` actually points at an H.264 PT. Chrome's capability list is self-consistent in practice, so this is theoretical. Worth a defensive filter, not a rewrite.
Three mechanisms exist, all already visible in this repo's SDP filter at `app.js:614` (`red/`, `ulpfec/`, `flexfec-03/`):

| Mechanism | Scope | Notes |
|---|---|---|
| **RED** (RFC 2198) | One stream, multiple encodings | A container, not error correction. Only for bundling codecs. |
| **ULPFEC** (RFC 5109) | N:M parity within a repair window | Simple, but **fragile to burst loss** — parity for a burst is exactly what is lost. |
| **FLEXFEC-03** (draft) | Flexible window, separate or in-band | The modern one. Still a draft; browser support is essentially nil. |

**Why not here, concretely:**

1. **Browsers do not decode FEC in WebRTC.** `fecPacketsReceived` and `fecPacketsDiscarded` are unimplemented in Chrome, Firefox and Safari (§5.2). There is no client that would repair anything.
2. **MediaMTX/Pion do not generate FEC.** Nothing on the publish or bridge side would produce parity packets.
3. **The loss profile is bursty, not random.** `codec_bridge.js` runs 4K60 with 0.5 s IDRs. Loss concentrates in keyframe bursts — the case FEC handles *worst*, and the case where PLI recovery is also most expensive. The real fixes for burst loss are a smaller GOP and a rate-capped encoder, both already in place.

**The one legitimate FEC-like lever** is in-band Opus FEC on the audio path, which is not what anyone means by "add FEC" here.
`app.js:641-666` scores repair codecs:

### 9.3 What MediaMTX and Pion actually do — verified

This section constrains every other recommendation, so each claim carries its evidence.

| Claim | Evidence | Consequence |
|---|---|---|
| MediaMTX's reader path is a bounded queue that drops when full | MediaMTX docs: "there's a circular buffer that stores outgoing packets and drops packets if full" | `writeQueueSize` (`mediamtx.yml:28`) is the *only* loss knob MediaMTX exposes |
| Pion has no bandwidth estimator | I read the complete `SettingEngine` surface in `pion/webrtc/settingengine.go`. Every `Set*` method is ICE, DTLS, SCTP, SRTP-replay, logging, mux or candidate filtering. **There is no `SetBWE`, no bitrate estimator, no pacer, no congestion-control option of any kind.** | `transport-cc` and `goog-remb` have no consumer (§2.3) |
| `pion/rtp` ships TWCC as parse/marshal only | The package file list includes `transportccextension.go` alongside `abssendtimeextension.go` and `vlaextension.go` — all pure header-extension codecs, no estimator module | Confirms the above |
| Pion consumes RTCP NACK and retransmits | This is the behaviour `nack` exists to enable | The retransmission cache depth is **not** configurable from `mediamtx.yml` |
| Pion does not implement FIR | No `FIR` handling in the Pion RTCP path | `nack fir` would be a no-op. Correctly absent. |
| MediaMTX's recommended queue size is 1024 | Docs: "When reading a stream, packets might get discarded because the write queue is too small... Try increasing the write queue: `writeQueueSize : 1024`" | `mediamtx.yml:28` sets 2048 — see gap #4 |
| `udpReadBufferSize` needs OS backing | Docs: "The `udpReadBufferSize` parameter requires the `net.core.rmem_max` system parameter to be equal or greater than it" | **Windows has no `sysctl`.** `mediamtx.yml:61`'s `1048576` may be silently clamped. Worth verifying on the host. |
| H.264 with B-frames is not browser-readable | Docs: "H264, when the stream contains B-frames... support for them has been intentionally left out by every browser." | `codec_bridge.js:313` and `364` pass `-bf 0`. **Correct and load-bearing — do not remove.** |
| H.265 is Windows-and-GPU only in Chrome | Docs: "Chrome supports publishing and reading H265 tracks only on Windows and only when a capable GPU is present" | Justifies H.264-first ordering in `configureCodecPreferences` |

**The synthesis:** the SFU retransmits on NACK and re-keys on PLI, and does *nothing else*. The send rate is fixed by the encoder. The queue is the only buffer. Therefore the viewer's job is: negotiate `nack`/`nack pli` correctly, keep its own jitter buffer large enough that a retransmission lands before the playout deadline, and switch rendition when the *unrecovered* loss justifies it. Everything else is out of reach from the browser.

## 10. Simulcast vs SVC, and temporal/spatial layers

### 10.1 The two mechanisms, per the spec

From WebRTC-PC's "Simulcast functionality":

> "An `RTCRtpSender`'s simulcast envelope is established in the first successful negotiation that involves it sending simulcast instead of unicast, and includes the maximum number of simulcast streams that can be sent, as well as the ordering of its `RTCRtpEncodingParameters`/`encodings`. This **simulcast envelope** may be narrowed (reducing the number of layers) in subsequent renegotiation, but **cannot be reexpanded**."

> "Simulcast is frequently used to send multiple encodings to an SFU, which will then forward one of the simulcast streams to the end user. The user agent is therefore expected to allocate bandwidth between encodings in a way that all simulcast streams are usable on their own."

And the decisive sentence for a *viewer*:

> "This specification does not define how to configure reception of multiple RTP encodings using `RTCPeerConnection.createOffer`, `createAnswer` or `addTransceiver`. However when `setRemoteDescription` is called with a corresponding remote description that is able to send multiple RTP encodings as defined in [RFC9429], **and the browser supports receiving multiple RTP encodings**, the `RTCRtpReceiver` may receive multiple RTP encodings... **Correct operation in this scenario is non-trivial and therefore is optional for implementations of this specification.**"

| | Simulcast | SVC |
|---|---|---|
| Mechanism | N independent RTP streams, each with its own SSRC, sequence space and `rid` | One RTP stream, layers signalled via dependency descriptors / temporal IDs |
| Signalling | `a=rid:` + `a=simulcast:send 0;q;h` (RFC 8853) | In-band dependency-descriptor RTP header extension; `spatialIndex`/`temporalIndex` in encoded-transform metadata |
| Layer switch cost | **Full** — new SSRC, new sequence space, needs a fresh IDR | **Cheap** — same SSRC; a temporal-layer switch may need no keyframe at all |
| Receiver-side complexity | High — must order across sequence spaces | Lower — one stream, layer-dependency logic |
| Spec status for a *receiver* | **Optional**, and the spec explicitly calls it non-trivial | Not standardised at all for WebRTC receivers |
| Chrome receiver support | Partial | Via `RTCRtpScriptTransform` only |

**The key architectural point: simulcast is a *sender*-side feature.** MediaMTX has exactly one published stream per path and does not republish or re-encode per viewer. There is nothing to receive as simulcast, and the viewer's `addTransceiver('video', {direction:'recvonly'})` (`app.js:1653`) creates a single unicast envelope that **cannot be reexpanded**.

**This is why the repo's rendition ladder is path-based, and that is correct design for a MediaMTX stack, not a workaround.** `switchRendition('live-av1')` tears down the WHEP session and re-offers a different path. The cost — session teardown, new ICE handshake, new keyframe wait — is what §8.5 prices, and it is why the 60 s cooldown at `app.js:1218` exists.

### 10.2 Temporal layers — the one form of in-band adaptation available

**Temporal** scalability means some frames depend on fewer others, so a receiver can drop a temporal layer and lose 1/2 or 1/4 of the frame rate while keeping resolution and full decodability. Attractive in principle: 4K60 → 30 fps at 4K is a 2× saving with no resolution loss and, crucially, **no keyframe needed for the switch**.

**But it cannot be used on this stack:**

- **`codec_bridge.js` produces no temporal layers.** NVENC H.264 temporal layers require B-frames, and `-bf 0` (`codec_bridge.js:313`, `364`) is **mandatory** because browsers refuse H.264 with B-frames (§9.3). For AV1, no dependency-descriptor structure is configured.
- **Nothing in the stack would use them.** MediaMTX forwards the single stream unchanged; there is no per-viewer layer selection.

**Stated plainly: on this stack, bitrate adaptation is necessarily a session-level decision, and the only session-level decision available is which path to subscribe to.** The two-rung ladder (`live` at 6000k / `live-av1` at 3000k) is the complete implementation of that idea and is architecturally correct. Available improvements are in *how* the decision is made (gaps #1, #2) and *how many* rungs exist (gap #9) — not in a different mechanism.

## 11. Picture-loss ratio

**Picture Loss Ratio (PLR)** is the industry-standard QoE metric: the fraction of *pictures* (frames) that were corrupted or never displayed, out of the total that should have been. Typical good/acceptable/bad thresholds are 0.1 / 1 / 2 percent (ITU-T P.910 heritage, and the threshold set used by Conviva, Brightcove and SSaiN).

**PLR is not a single `getStats()` field — it must be assembled from three, and this repo already reads two of them.**

| Concept | Stats member | Read by `app.js`? |
|---|---|---|
| Denominator — pictures that *should* have been shown | `framesReceived` (complete frames assembled) | ✅ `app.js:3084` |
| Numerator part 1 — pictures never completed because a packet was lost | `packetsLost` where no `retransmittedPacketsReceived` repair arrived | ⚠️ `packetsLost` read, no repair counter, so *unrepaired* loss is not separable |
| Numerator part 2 — pictures assembled but never decoded | `framesReceived − framesDecoded` | ⚠️ both read; the difference is computed only inside the decode-pressure state machine, never as a PLR |
| Numerator part 3 — pictures decoded but not rendered | `framesDecoded − framesRendered` | ❌ `framesRendered` never read |
| Also excluded from good QoE | `pauseCount` / `totalPausesDuration`, `freezeCount` / `totalFreezesDuration` | ❌ never read |

**The actionable finding:** a usable PLR approximation is

```js
const dRecv  = framesReceived - lastFramesReceived;
const dDec   = framesDecoded  - lastFramesDecoded;
const plrPct = dRecv > 0 ? 100 * (dRecv - dDec) / dRecv : 0;
```

Every input is already read at `app.js:3082-3084` with baselines at `app.js:3305`. The subtraction is the entire cost. This is the highest value-per-character change available in the stats loop, because PLR is the number a broadcaster actually reports, and the app currently cannot produce it.

**And it would immediately expose a distinction the app cannot currently see.** `framesReceived − framesDecoded` conflates two very different causes:
- packets never arrived (network / SFU queue) — fixable by a rendition switch or buffer tuning;
- packets all arrived but the decoder could not keep up (CPU) — **not** fixable by a rendition switch, and in fact made *worse* by one.

`decoderImplementation` and `powerEfficientDecoder` separate these cases in one string comparison. The decode-pressure state machine is a hand-rolled proxy for exactly this distinction, and it currently runs blind.

## 12. `RTCRtpTransceiver.setCodecPreferences` — best practice

### 12.1 The spec's algorithm, verbatim

From WebRTC-PC §5.4, `setCodecPreferences(sequence<RTCRtpCodec> codecs)`:

1. "Let transceiver be the `RTCRtpTransceiver` object this method was invoked on."
2. "Let codecs be the first argument."
3. "If codecs is an empty list, set transceiver.[[PreferredCodecs]] to codecs and **abort** these steps." — *an empty list is a legal, meaningful reset, not an error.*
4. "Remove any [codec dictionary match | duplicate] values in codecs, ensuring that the first occurrence of each value remains in place."
5. "Let kind be the transceiver's transceiver kind."
6. "Let codecCapabilities be the union of `RTCRtpSender.getCapabilities(kind).codecs` and `RTCRtpReceiver.getCapabilities(kind).codecs`."
7. "For each codec in codecs, **If codec does not match any codec in codecCapabilities, throw `InvalidModificationError`.**"
8. "**If codecs only contains entries for RTX, RED, FEC or Comfort Noise or is an empty set, throw `InvalidModificationError`.** This ensures that we always have something to offer, regardless of transceiver direction."
9. "Set transceiver.[[PreferredCodecs]] to codecs."

And the ordering rule:

> "If set, the offerer's receive codec preferences will decide the order of the codecs in the offer. If the answerer does not have any codec preferences then the same order will be used in the answer. However, if the answerer also has codec preferences, these preferences override the order in the answer. In this case, the offerer's preferences would affect which codecs were on offer but not the final order."

### 12.2 The six rules that follow, and how `app.js` complies

| # | Rule | `app.js` status |
|---|---|---|
| 1 | **Only pass codecs that came from `getCapabilities`.** Anything else throws `InvalidModificationError`. | ✅ `capabilities.codecs.slice().sort(...)` — every element originates from `RTCRtpReceiver.getCapabilities('video')` (`app.js:637`, `608`). |
| 2 | **Never pass a list consisting only of RTX/RED/FEC.** Throws. | ✅ H.264 scores 100, so a media codec is always present. |
| 3 | **Call it before `createOffer()`/`createAnswer()`.** The preference list is consulted when the description is created. | ✅ `configureCodecPreferences(videoTransceiver)` at `app.js:1656` runs immediately after `addTransceiver` at `app.js:1653`. |
| 4 | **Keep repair payloads adjacent to their `apt=` parent.** Reordering can detach them. | ✅ the score-100 branch for `rtx\|red\|ulpfec\|flexfec` (`app.js:648`), with the rationale in the comment at `app.js:647-655`. See §9.1. |
| 5 | **`Array.prototype.sort` is stable** (ES2019), so equal scores preserve the browser's original relative order — what you want among repair payloads. | ✅ relies on this deliberately. |
| 6 | **The audio transceiver is never configured.** | ❌ `app.js:1654` adds the audio transceiver but `configureCodecPreferences` is called only for video (`app.js:1656`). Minor: Opus is effectively the only WebRTC audio codec, so this costs nothing today. |

**A verified detail that makes rule 1 non-obvious.** The `codec dictionary match` algorithm compares `mimeType` case-insensitively, requires equal `clockRate`, treats a missing-vs-present `channels` or `sdpFmtpLine` as a **non-match**, and then compares the *media format* parameters — with the asymmetry note that "**AV1's profile, level-idx and tier parameters may all be asymmetrical between the offerer and answerer while H.265's profile-id needs to be symmetrical and its level-id may be asymmetrical.**" This is why re-synthesising a codec object by hand and passing it to `setCodecPreferences` is fragile: a hand-built `RTCRtpCodec` whose `sdpFmtpLine` does not match a capability object will throw. **This repo correctly avoids that by sorting the capability objects in place rather than rebuilding them.**

### 12.3 One genuine weakness in `app.js:641-666`

```js
if (/(rtx|red|ulpfec|flexfec)/.test(mime)) return 100;
if (mime.includes('h264')) return 100;

if (mime.includes('h265') || mime.includes('hevc')) return 90;
if (mime.includes('av01') || mime.includes('av1')) return 80;
if (mime.includes('vp9')) return 70;
return 50;
```

1. **The repair-codec branch is regex-based on the MIME subtype, not on `sdpFmtpLine`'s `apt=`.** It cannot know which media PT a given RTX serves. It works because Chrome's capability list is self-consistent, but a *correct* implementation would parse `apt=` and score an RTX at `(parent score − 1)`, guaranteeing adjacency by construction rather than by reliance on stable sort. **Low priority, but it is the right fix.**
2. **H.264 and the repair branch both return 100** — the comment at `app.js:647-655` explains the intent ("Rank them alongside their primary and let the browser's order stand among equals"). Correct given `sort` stability.
3. **H.264-before-AV1 is deliberate and justified** by §9.3: H.265 is Windows-and-GPU-only in Chrome, and H.264 is the only codec with universal hardware decode. **Do not "fix" the ordering to favour AV1** — that would break legacy browsers, which is the entire reason the H.264 fallback exists.
## 13. `RTCRtpScriptTransform`, encoded streams, and insertable streams

### 13.1 What the API is (WebRTC Encoded Transform, ED 25 June 2026)

The old "insertable streams" API (`RTCRtpSender.createEncodedStreams()`, `pc.createEncodedStreams`) has been **replaced**. The current surface attaches a transform object directly to the sender or receiver:

```webidl
typedef (RTCRtpSFrameEncryptor or RTCRtpScriptTransform) RTCRtpSenderTransform;
typedef (RTCRtpSFrameDecryptor or RTCRtpScriptTransform) RTCRtpReceiverTransform;

partial interface RTCRtpSender   { attribute RTCRtpSenderTransform?   transform; };
partial interface RTCRtpReceiver { attribute RTCRtpReceiverTransform? transform; };
```

The placement in the pipeline is the whole point, and the spec is explicit:

> "This API allows manipulation of encoded frames in the media pipeline **between the processing steps of an `RTCRtpSender`'s underlying encoder and packetizer**, and/or **between an `RTCRtpReceiver`'s underlying depacketizer and decoder**."

```webidl
enum RTCRtpScriptTransformType { "sframe" };
dictionary WorkerAndParameters { required Worker worker; RTCRtpScriptTransformType type; };
typedef (Worker or WorkerAndParameters) WorkerOrWorkerAndParameters;

[Exposed = Window] interface RTCRtpScriptTransform {
  constructor(WorkerOrWorkerAndParameters workerOrWorkerAndParameters,
              optional any options, optional sequence<object> transfer);
};

[Exposed = DedicatedWorker] interface RTCRtpScriptTransformer : EventTarget {
  readonly attribute ReadableStream readable;
  Promise<undefined> generateKeyFrame(optional DOMString rid);
  Promise<undefined> sendKeyFrameRequest();
  readonly attribute WritableStream writable;
  attribute EventHandler onkeyframerequest;
  readonly attribute any options;
};
```

`RTCEncodedVideoFrame` carries the payload plus metadata:

```webidl
[Exposed = (Window, DedicatedWorker), Serializable]
interface RTCEncodedVideoFrame {
  constructor(RTCEncodedVideoFrame originalFrame, optional RTCEncodedVideoFrameOptions options = {});
  readonly attribute EncodedVideoChunkType type;
  attribute ArrayBuffer data;
  RTCEncodedVideoFrameMetadata getMetadata();
};

dictionary RTCEncodedFrameMetadata {
  unsigned long           synchronizationSource;   // SSRC
  octet                   payloadType;
  sequence<unsigned long> contributingSources;     // CSRC list
  unsigned long           rtpTimestamp;
  DOMHighResTimeStamp     receiveTime;
  DOMHighResTimeStamp     captureTime;
  DOMHighResTimeStamp     senderCaptureTimeOffset;
  DOMString               mimeType;
};

dictionary RTCEncodedVideoFrameMetadata : RTCEncodedFrameMetadata {
  unsigned long long            frameId;
  sequence<unsigned long long>  dependencies;
  unsigned short                width;
  unsigned short                height;
  unsigned long                 spatialIndex;
  unsigned long                 temporalIndex;
  long long                     timestamp;   // microseconds
};
### 13.2 The two hard rules a transform must respect

**(a) Backpressure is disabled, by design.** From §2.1.1:

> "Buffering within a transform would add latency without allowing web applications to adapt much. The User Agent is responsible for doing these adaptations, especially since it controls both ends of the transform. For those reasons, **streams backpressure is disabled in WebRTC encoded transforms**."

Mechanically: `transformer.writable`'s `highWaterMark` is set to `Infinity`, and `readable` is set up without a queuing strategy.

**(b) You cannot create, reorder, or move frames.** From `writeEncodedData`:

> "A processor **cannot create frames, or move frames between streams**. If frame.[[counter]] is equal or smaller than transformer.[[lastReceivedFrameCounter]], abort these steps and return a promise resolved with undefined. **A processor cannot reorder frames**, although it may delay them or drop them."

A transform may *inspect*, *modify in place*, *delay*, or *drop* — but never reorder or synthesise. Dropping a frame is legitimate and is exactly how a transform sheds load.

### 13.3 The keyframe APIs — and why they are the interesting part here

```webidl
Promise<undefined> generateKeyFrame(optional DOMString rid);
Promise<undefined> sendKeyFrameRequest();
attribute EventHandler onkeyframerequest;   // KeyFrameRequestEvent { readonly attribute DOMString? rid; }
```

- `sendKeyFrameRequest()` runs the "send request key frame algorithm" — the *application* causes a keyframe request on demand (a PLI-equivalent).
- `generateKeyFrame(rid)` is the send-side force-IDR. It rejects with `InvalidStateError` if `frameSource` is not an encoder, and with `TypeError` if `rid` does not conform to RFC 8851 §10's grammar.
- `onkeyframerequest` fires on the **receiver** transform when the browser decides a keyframe is needed — `KeyFrameRequestEvent` with a `cancelable` flag and a `rid` when layer-specific.

**This is a genuinely new viewer-side lever.** The spec's own event flow is the tell: "When the encoder of an associated `RTCRtpScriptTransformer` transformer receives a keyframe request, for instance from an incoming RTCP Picture Loss Indication (PLI) or Full Intra Refresh (FIR), queue a task to … Fire an event named `keyframerequest` … **If the event's canceled flag is true, abort these steps.** Run the generate key frame algorithm…"

So a receiver transform can **observe** the browser's keyframe requests and even **suppress** one. For this repo, suppression would be a regression risk (the browser's own PLI policy is correct), but the *observability* is free and precise.

### 13.4 Whether this repo should adopt it

| For | Against |
|---|---|
| `receiveTime`, `captureTime`, `senderCaptureTimeOffset` per frame would give a **true one-way latency** measurement — the thing §7.3 says `getStats()` cannot provide. | **Chromium-only.** The spec is a W3C ED; `RTCRtpScriptTransform` ships in Chrome/Edge and essentially nowhere else. Any capability must be feature-detected and optional. |
| `spatialIndex`/`temporalIndex`/`dependencies` would let the app *observe* whether the stream has any layer structure — confirming §10.2 empirically rather than by argument. | A transform in the receive path is a **new failure surface** on a stack whose current design is deliberately minimal. |
| `payloadType` per frame would confirm that the SDP munging at `app.js:564-627` actually took effect — the one thing a unit test over `optimizeSdp()` cannot prove. | The gain is diagnostic, not corrective. |
| `RTCEncodedVideoFrame` gives frame-accurate keyframe identification, which `getStats()` only approximates via `keyFramesDecoded`. | Requires a Worker, a `TransformStream`, careful lifetime management, and a decision about error handling. |

**Verdict: not now.** The value is diagnostic; the cost is a new async worker subsystem plus a Chromium-only path, on a project whose stated priorities are latency and smoothness rather than instrumentation. It is the correct tool if the project ever needs (a) true end-to-end latency, (b) per-frame confirmation that SDP munging worked, or (c) a legal way to drop frames before they reach a struggling decoder. §17 lists it as the top *optional* lever.

---

## 14. What a viewer-side JS app can legitimately do, and what it must delegate

This is the section to read before proposing any ABR work on this stack.

### 14.1 Legitimately the viewer's own business

| Lever | API | Already used? |
|---|---|---|
| Negotiate NACK/PLI/REMB/TWCC | SDP `a=rtcp-fb` in the offer | ✅ `app.js:564-627` |
| Choose which SFU path to subscribe to | WHEP POST to a different path | ✅ `switchRendition()` |
| Set the jitter-buffer target | `RTCRtpReceiver.jitterBufferTarget` | ✅ (see the A/V-sync report) |
| Read every measurement in §5 | `getStats()` | ⚠️ 8 of ~45 members |
| Switch codec path after negotiation | `setCodecPreferences` + re-offer | ✅ `app.js:634-672` |
| Buffer / drop / rate-limit locally | `<video>` `degradationPreference`, `playbackRate` | ✅ `app.js:53-59` |
| Observe the candidate pair and its RTT | `candidate-pair` stats | ✅ `app.js:3325` |
| *Optionally* inspect encoded frames | `RTCRtpScriptTransform` | ❌ not used |

### 14.2 Must be delegated — no viewer-side API exists

| Want | Why not possible |
|---|---|
| Change the sender's bitrate or framerate | `setParameters` is on `RTCRtpSender`; a `recvonly` transceiver has nothing to configure, and there is no API to command a *remote* sender. |
| Adapt resolution in-band | Requires simulcast or SVC from the sender, and a receiver-side layer-selection API the spec explicitly declines to define (§10.1). |
| Enable a real congestion controller | Requires a sender-side estimator. Pion has none (§9.3). |
| Make the SFU honour a bandwidth hint | `transport-cc`/`goog-remb` have no consumer. |
| Enlarge the SFU's retransmission cache | Not exposed in `mediamtx.yml`; hard-coded in Pion. |
| Force an encoder keyframe on demand | `generateKeyFrame` is send-side only. A receiver's `sendKeyFrameRequest()` is the *closest* thing — Chromium-only, and it is a request, not a guarantee. |
| Shorten the GOP | `codec_bridge.js`'s `-g`, server-side. |
| Cap a keyframe burst | `-maxrate`/`-bufsize`, server-side. `codec_bridge.js` already does this. |
**The honest summary of this architecture:** the viewer is a *monitor with two actuators* — "which path" and "how deep is my jitter buffer". Everything else is either already optimal at the encoder (short GOP, capped bursts, no B-frames) or simply out of reach. A viewer-side "congestion controller" on this stack is a misnomer; what exists is a **path selector driven by loss and jitter measurements**, and the useful work is in making those measurements correct (gaps #1-#5), not in adding new control loops.


## 15. Review of `optimizeSdp()` — what is right and what is missing

`app.js:564-627`. This is the single most consequential function in the file for loss recovery, so it is reviewed line by line.

### 15.1 What it does correctly

1. **`b=AS` / `b=TIAS` are stripped and re-added media-level** (`app.js:568-574`). The `js_checks` suite (`js_checks.js:236-249`, `sdp-bandwidth-ceiling`) pins exactly one bandwidth line directly after `m=video`, and the 60000 value is pinned in both files with a comment telling the reader to raise both together. **Good practice — a magic number that is unit-tested and cross-referenced.**
2. **Feedback injection is scoped to the video section** (`app.js:588-607`). The comment records a real reproduced bug: the collection pass used to sweep the whole document, so a payload type present in both `m=audio` and `m=video` was recorded as "already has feedback" and the video section silently lost its `nack`. The `js_checks` fixture `sdp-feedback-scoped-to-video` (`js_checks.js:251-278`) reproduces it. **A well-defended fix with a regression test.**
3. **Repair payload types are excluded from feedback injection** (`app.js:614`): the regex `^a=rtpmap:(\d+)\s+(?!red\/|ulpfec\/|rtx\/|flexfec-03\/)\S+\/90000(?:\s|$)` correctly withholds `a=rtcp-fb` from `red`, `ulpfec`, `rtx` and `flexfec-03`, which "ride the same 90000Hz clock but must not receive feedback lines". `js_checks.js:304-307` asserts this. **Correct and well tested.**
4. **Idempotence** is asserted (`js_checks.js:281-302`): re-munging an already-munged offer is a no-op, which matters because the app can re-offer on the same transceiver.
5. **The 90000 Hz filter is the right discriminator.** H.264, AV1, VP8/VP9 and H.265 all ride 90000 Hz; Opus is 48000 Hz and Opus/PCMU/PCMA are 8000 Hz — so the "VIDEO payload type" test is *effectively* correct (see 15.2c).

### 15.2 The gaps

**(a) `nack fir` is absent — and that is correct.** Pion does not implement FIR (§9.3). Do not add it.

**(b) `goog-remb` is present and is dead weight** (§2.3). Low severity; removing it will not change behaviour. **But** if it is removed, `js_checks.js:259`, `267-268`, `277` and `298` all assert on it and must be updated in the same commit.

**(c) The 90000 Hz heuristic has a theoretical hole:** a video m-line carrying a non-90000 Hz payload would be skipped entirely. No such configuration exists for the codecs in use. Worth a comment, not a code change.

**(d) `a=rtcp-fb` for RTX payload types is deliberately withheld, which is right — but there is no check that the *primary* payload type actually has an RTX negotiated.** `rtxSsrc` in the stats is the runtime check for that, and it is never read. See gap #5.

**(e) Nothing here can be verified at runtime.** The function's correctness rests entirely on `js_checks.js` exercising it against a synthetic SDP. §13.4's `RTCEncodedVideoFrame.payloadType` is the only way to confirm at runtime that the munged payload type is the one actually in use.

---

## 16. Consolidated cheat sheet

| Question | Answer |
|---|---|
| Does this stack do congestion control? | **No.** Pion has no estimator; MediaMTX exposes no knob for one. |
| Does `transport-cc` help? | Not here. Keep it (it feeds Chrome's internal estimator) but expect no SFU behaviour change. |
| Does `goog-remb` help? | No, and no browser sends it. Remove for clarity only. |
| What in the SDP actually earns its keep? | `nack` and `nack pli`. |
| Does FEC help? | No — no browser decodes it, nothing generates it, and the loss is bursty. |
| Does RTX help? | Yes, if negotiated. `app.js:648` correctly keeps RTX adjacent to its `apt=` parent. |
| Is simulcast an option? | No — it is sender-side, and the spec makes multi-encoding *reception* optional and non-trivial. |
| Are temporal layers an option? | No — they need B-frames, which browsers refuse for H.264. |
| Biggest lever on loss recovery? | GOP length (`codec_bridge.js:190`) and keyframe burst capping (`:305-312`). Both already done. |
| Biggest lever left in the viewer? | **Measuring loss correctly** (gaps #1-#2) and **surfacing PLR** (gap #3). |
| Can a viewer force a lower bitrate? | Only by switching SFU path, which is a full session teardown. |
| Is `fractionLost` readable? | No — it is on `remote-inbound-rtp`; a `recvonly` viewer has no such object. |
| Is `framesDiscarded` a real field? | **No.** It is absent from the current spec. |

## 17. Optional / future levers, ranked by value-per-risk

1. **Read `retransmittedPacketsReceived` and `rtxSsrc`** — four lines, no new subsystem, immediately distinguishes "NACK is working" from "NACK is dead". Highest value in the whole report.
2. **Compute and display PLR from `framesReceived − framesDecoded`** — two lines, every input already read, and it is the number the project would actually report to anyone.
3. **Add `packetsDiscarded` to the buffer controller** — distinguishes "buffer too small" from "link congested", which is the exact ambiguity the current jitter floor has to guess around.
4. **Read `decoderImplementation`** — one string comparison replaces the hand-rolled decode-pressure heuristic's guesswork.
5. **Compute PLI/NACK *rates* and cross-reference them** (§8.4) — turns two logged counters into a diagnosis.
6. **Read `frameWidth`/`frameHeight`** — the only standards-defined way to notice a resolution change; would make `switchRendition` observable rather than assumed.
7. **Add a third ladder rung** (e.g. 1200k) so the downgrade is not a 2× cliff — a `codec_bridge.js` + `mediamtx.yml` change.
8. **`RTCRtpScriptTransform` for true one-way latency** (§13.4) — high value, Chromium-only, new failure surface. Not now.
9. **`abs-send-time` one-way delay trend** (§7.3) — the only way to approximate GCC's own signal from JS, and reachable only through a transform. Not now.

---


## Gaps in this repo

Ranked by severity. Line numbers verified against the working tree at commit `2686885`.

| # | Location | Gap | Severity | One-line fix |
|---|---|---|---|---|
| 1 | `app.js:3161-3163` | `lastLossPct` is computed as `dLost / (dRx + dLost)`, but `packetsReceived` "includes retransmissions" per spec, so it measures **unrecovered** loss only — a link losing 20% with 100% RTX repair reads 0%, and a MediaMTX write-queue overflow is indistinguishable from a clean link. It is also a **loss-based** controller, the signal Google removed from GCC, and it drives both the ABR downgrade (`app.js:1201`) and buffer stress (`app.js:1373`). | **Critical** | Track `ΔretransmittedPacketsReceived` and `ΔpacketsDiscarded` too, clamp `dLost` with `Math.max(0, …)`, and gate the downgrade on `netUnrecovered%` rather than raw `dLost`. |
| 2 | `app.js:3068-3072` | `pliCount` and `nackCount` are snapshotted into `lastRecoveryCounts` for the diagnostic export and **no controller ever reads them**; `retransmittedPacketsReceived`, `packetsDiscarded`, `rtxSsrc` and `totalAssemblyTime` are never read at all — so the two NACK failure modes in §8.2 are indistinguishable and NACK effectiveness is unmeasurable. | **High** | Read `retransmittedPacketsReceived`/`rtxSsrc` each tick and compute `repairRate% = dRetx / dLost`; add it to the diagnostic export and treat a near-zero rate as a hard "NACK is dead" signal. |
| 3 | `app.js:3082-3096` | **Picture-loss ratio — the standard broadcast QoE metric — is never computed**, even though `framesReceived` and `framesDecoded` are both read at `app.js:3082-3084` with baselines at `app.js:3305`; `framesRendered`, `freezeCount` and `totalFreezesDuration` are never read. The app cannot report the one number a viewer or broadcaster would ask for. | **High** | Add `plrPct = 100 * (dFramesReceived − dFramesDecoded) / dFramesReceived` to the telemetry block and the HUD; every input already exists. |
| 4 | `mediamtx.yml:28` | `writeQueueSize: 2048` is double MediaMTX's documented recommendation of 1024, and the justifying comment at `:20-27` argues from a "~0.41s" backlog that the same comment admits is an 8× correction of an earlier 3.3s figure. At 6 Mbit/s, 2048 × ~901 B is **~2.4 s of video** per reader — far beyond the app's own 2200 ms buffer cap (`app.js:887`), so a brief hotspot stall converts into a multi-second latency spike that the drift supervisor then "fixs" by tearing the session down. | **High** | Drop to `writeQueueSize: 1024` (the documented value) and re-derive the RAM/latency comment from ~901 B packets at 6 Mbit/s rather than the stale 1200 B figure. |
| 5 | `codec_bridge.js:303-313`, `359-364` | Both encoder branches set `-g` from the probe but there is **no `-sc_threshold 0`**, so NVENC may insert *extra* IDRs on scene changes beyond the intended interval. An unbounded keyframe burst is exactly what overflows a 2048-packet write queue and freezes every reader on that path; `-maxrate`/`-bufsize` bounds the *rate*, not the *number* of keyframes. | **High** | Add `-sc_threshold 0` to the `h264_nvenc` (`codec_bridge.js:303`) and `av1_nvenc` (`codec_bridge.js:359`) argument lists so IDR cadence is exactly `-g`. |
| 6 | `app.js:3271`, `2963-2968` | The Mbps readout and the sparkline are computed from `bytesReceived`, which the spec says "includes retransmissions", so **the displayed bitrate — and the ABR's implicit sense of link capacity — is inflated by repair traffic** exactly when the link is worst. | **Medium** | Subtract the `retransmittedBytesReceived` delta before dividing, or label the HUD value "incl. retransmit". |
| 7 | `app.js:3168-3172` | `jitter` is multiplied by 1000 and then smoothed with a second EWMA (0.7/0.3), but RFC 3550 §6.4.1 already defines `jitter` **as** an exponentially-weighted moving average — the app double-filters, adding ~3 s of lag to the signal that gates both the jitter floor (`app.js:844`) and buffer stress (`app.js:1373`). | **Medium** | Read `jitter * 1000` directly, or keep the smoothing at 0.9 so it acts as a light outlier filter rather than a 3-tick lag. |
| 8 | `app.js:3089-3090`, `2954` | `videoStats.framesDiscarded` is read as "the decoder's OWN drops" with a comment asserting the spec says it "is a per-second gauge, not a cumulative counter" — **`framesDiscarded` is not a member of the current `webrtc-stats` dictionary at all** (verified: zero occurrences in `research/stats.html`), so the value is permanently `undefined` and the `discardedDelta` term feeding `updateDecodeLag` at `app.js:3299` is always 0. The decode-pressure state machine is running with one leg missing. | **Medium** | Replace it with `ΔframesReceived − ΔframesDecoded` plus `decoderImplementation`, both spec-defined and already half-present. |
| 9 | `codec_bridge.js:255-355`, `mediamtx.yml:159-177` | The ABR ladder has exactly **two rungs** (`live` at 6000k → `live-av1` at 3000k), so the only available adaptation step is a hard 2× cut that also forces a full WHEP teardown, ICE restart and keyframe wait (§8.5); a viewer whose link sits just above 3 Mbit/s is either over-buffered or forced through the expensive switch. | **Medium** | Add a third ~1200k rung (a `buildAv1VideoArgs` variant plus a `live-av1-lo` path in `mediamtx.yml`) and extend the ladder logic at `app.js:1223-1261` to walk it. |
| 10 | `app.js:307`, `3128-3156` | The freeze detector is a fixed 3000 ms `requestVideoFrameCallback` staleness threshold, while the spec defines a freeze precisely as "frame duration, which is time interval between two consecutively rendered frames, is equal or exceeds Max(3 × avg_frame_duration_ms, avg_frame_duration_ms + 150), where avg_frame_duration_ms is linear average of durations of last 30 rendered frames" — a threshold that scales with frame rate and cannot false-positive on a healthy 30 fps stream. | **Medium** | Read `freezeCount`/`totalFreezesDuration` deltas as the authoritative signal and keep the rVFC watchdog only as a fallback for browsers that omit them. |
| 11 | `mediamtx.yml:61` | `udpReadBufferSize: 1048576` is set with the comment "MediaMTX recommends raising this to decrease packet loss", but MediaMTX's docs state the setting "requires the `net.core.rmem_max` system parameter to be equal or greater than it" — **Windows has no `sysctl`**, so the socket buffer is very likely silently clamped to the OS default and the setting is doing nothing. | **Medium** | Verify the effective `SO_RCVBUF` on the host (`logLevel: debug` or `netsh int ipv4 show global`) and either confirm it took effect or record that it is a no-op on Windows. |
| 12 | `codec_bridge.js:190` vs `README.md:19` | The code now derives the GOP from `DEFAULT_GOP_SECONDS = 0.5` (0.5 s keyframes), but the README still tells operators to "Start with CBR and a 1-second keyframe interval" — a factor-of-two discrepancy in the primary recovery-latency parameter, and the CBR advice conflicts with the VBR + `-maxrate`/`-bufsize` the code actually uses. | **Low** | Update `README.md:19` to state 0.5 s and to recommend VBR with `-maxrate`/`-bufsize` pinned to the target, matching `codec_bridge.js:303-313`. |
| 13 | `app.js:585`, `js_checks.js:259,267-268,277,298` | `goog-remb` is injected for every video payload type, but no shipping browser generates REMB and Pion consumes nothing (§2.2, §9.3) — it is dead weight, and `js_checks.js` asserts on it in four places. **Removing it is a clarity win with no measurable performance change.** | **Low** | Drop `'goog-remb'` from `desiredFeedback` at `app.js:585` and remove the four corresponding assertions in `js_checks.js` in the same commit. |
| 14 | `app.js:1656` | `configureCodecPreferences` is called only for the video transceiver; the audio transceiver added at `app.js:1654` is never configured, so audio codec ordering is entirely browser-default. Harmless today (Opus is effectively the only WebRTC audio codec) but it is an asymmetry in a function whose entire purpose is deterministic codec ordering. | **Low** | Call `configureCodecPreferences` on the audio transceiver too, or add a comment stating the omission is deliberate because only Opus is in use. |


### Not gaps — do not "fix" these

- **`-bf 0` at `codec_bridge.js:313` and `:364`.** Mandatory: MediaMTX's docs state browsers have "intentionally left out" H.264-with-B-frames support. Removing it breaks playback on legacy browsers.
- **The RTX/repair-codec score-100 branch at `app.js:648`.** Deliberate and documented at `app.js:647-655`. It exists because scoring repair payloads 50 detached `rtx` from its `apt=` parent, which would silently disable retransmission.
- **The H.264-before-AV1 preference order.** Justified by H.265 being Windows-and-GPU-only in Chrome and by H.264 having universal hardware decode. The H.264 fallback is the reason legacy viewers work at all.
- **`transport-cc` in the SDP.** It has no SFU-side consumer, but it feeds Chrome's internal receive-side estimator; removing it is a behavioural regression risk with no upside.
- **The path-based (not simulcast-based) rendition ladder.** Simulcast is sender-side, and multi-encoding *reception* is spec-optional and explicitly called non-trivial (§10.1). Path switching is the correct design for a MediaMTX stack.
- **`readTimeout`/`writeTimeout: 20s` at `mediamtx.yml:74-75`.** Correctly reasoned in the file's own comments: they bound *publishers*, not WebRTC readers.
- **The 0.5 s GOP at `codec_bridge.js:190`.** Already the right value; §8.5 shows recovery latency is dominated by it.

---

## Source index

- W3C WebRTC Statistics API — https://www.w3.org/TR/webrtc-stats/ (CR Draft 25 Sep 2025); local copy `research/stats.html`
- W3C WebRTC: Real-Time Communication in Browsers — https://w3c.github.io/webrtc-pc/ (§5.4 `setCodecPreferences`, "Simulcast functionality")
- W3C WebRTC Encoded Transform — https://w3c.github.io/webrtc-encoded-transform/ (ED 25 Jun 2026)
- W3C WebRTC Extensions — https://w3c.github.io/webrtc-extensions/ (ICE candidate filtering, `RTCConfiguration.targetLatency`)
- RFC 4585 — RTP/AVPF (https://www.rfc-editor.org/rfc/rfc4585.html) §6.2.1 Generic NACK, §6.3.1 PLI
- RFC 5104 — Codec Control Messages (FIR, `ccm`)
- RFC 8888 — RTCP Feedback for Congestion Control (`ccfb`, `R` bit)
- RFC 8083 — Multimedia Congestion Control: Circuit Breakers
- RFC 3550 §6.4.1 — packet loss and inter-arrival jitter definitions
- draft-ietf-rmcat-gcc-02 — A Google Congestion Control Algorithm for Real-Time Communication
- draft-holmer-rmcat-transport-wide-cc-extensions-01 — RTP Extensions for Transport-wide Congestion Control
- draft-alvestrand-rmcat-remb-03 — RTCP message for Receiver Estimated Maximum Bitrate
- MediaMTX configuration reference — https://mediamtx.org/docs/references/configuration-file
- MediaMTX: Decrease packet loss — https://mediamtx.org/docs/usage/decrease-packet-loss
- MediaMTX: WebRTC-specific features — https://mediamtx.org/docs/usage/webrtc-specific-features
- `pion/webrtc` `settingengine.go` — https://raw.githubusercontent.com/pion/webrtc/master/settingengine.go
- `pion/rtp` package — https://pkg.go.dev/github.com/pion/rtp
