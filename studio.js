/* ==========================================================================
   Rydius Studio — in-browser broadcaster (WHIP publish to MediaMTX)
   ==========================================================================
   This is the "no OBS install" path. It captures a screen, window or tab with
   getDisplayMedia, mixes a microphone with the captured system/tab audio, and
   publishes the result to the SAME `live` path OBS uses by speaking WHIP
   (RFC 9725) to /stream-api/live/whip. Viewers are unaffected: they keep
   connecting over WHEP exactly as before, and OBS keeps working unchanged.

   Why the browser encodes, rather than WebCodecs
   ----------------------------------------------
   The obvious design — encode with WebCodecs.VideoEncoder and push the
   EncodedVideoChunks into the WebRTC sender — is not possible. There is no
   RTCRtpSender/Transceiver API that accepts encoded chunks; RTCRtpScriptTransform
   is a tap on frames the user agent already produced, not an injection point,
   and MediaStreamTrackGenerator/VideoTrackGenerator accept raw VideoFrames
   (which the browser then re-encodes anyway, costing a double encode). So the
   only correct browser path is getDisplayMedia -> addTrack -> let the browser's
   own hardware encoder produce the RTP. That is what this file does.

   MediaMTX v1.21.1 constraints this file is written against (verified by
   POSTing real offers at the bundled binary, not just from documentation):
     - At most ONE video and ONE audio m-section, and NO data channel: a
       second track or an m=application line fails the whole POST. The studio
       therefore mixes audio down to a single track and never calls
       createDataChannel.
     - Accepted publish video codecs: H.264, AV1, VP9, VP8. Each returned 201
       with a matching answer.
     - Audio must be Opus — the only codec a browser produces here, and the
       only one WebRTC readers can consume. This is also why this path can
       deliver sound where the RTMP/OBS path cannot.
     - POST Content-Type must be application/sdp, and the answer's Location
       must be DELETED to end the session.
     - The 201 is not written until ICE + DTLS complete, so the POST can
       legitimately take ~12s (webrtcSTUNGatherTimeout 2s nested inside
       webrtcHandshakeTimeout 10s). The abort below is deliberately 25s: the
       viewer path's 10s figure is right for WHEP and wrong for WHIP.
     - webrtcAllowOrigins must stay ["*"]. MediaMTX v1.21.1 enforces the
       Origin on every POST, and [] is deny-all that fails silently.
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // --- Configuration ----------------------------------------------------

    // The same path OBS publishes to. `overridePublisher: yes` in mediamtx.yml
    // means the newest publisher wins, so starting here takes the path from a
    // running OBS session — the studio checks for that and warns first.
    const WHIP_PATH = '/stream-api/live/whip';
    const STREAM_PATH = 'live';
    const MEDIAMTX_API_PATH = '/stream-api/v3/paths/list';

    const WHIP_POST_TIMEOUT_MS = 25000;
    // The session DELETE is bounded like the POST: teardown holds the
    // `isTearingDown` re-entrancy guard across this await, so an unbounded
    // request can wedge the whole transport state machine.
    const WHIP_DELETE_TIMEOUT_MS = 5000;
    // The advisory "is someone already publishing?" probe, awaited by the
    // source picker. It never blocks the broadcast (a failure reports "no"), but
    // it must not be able to hang the picker either.
    const PATH_PROBE_TIMEOUT_MS = 5000;
    const ICE_GATHER_TIMEOUT_MS = 8000;
    const STATS_INTERVAL_MS = 1000;

    // Resolutions are requested as `ideal`, never `exact`: a display track
    // cannot be forced to an exact size, and `min`/`exact` throw a TypeError
    // inside getDisplayMedia even though they are legal in applyConstraints.
    const RESOLUTION_MAP = {
        2160: { width: 3840, height: 2160 },
        1440: { width: 2560, height: 1440 },
        1080: { width: 1920, height: 1080 },
        720: { width: 1280, height: 720 },
        480: { width: 854, height: 480 }
    };

    const CODEC_MIME = {
        h264: 'video/H264',
        av1: 'video/AV1',
        vp9: 'video/VP9',
        vp8: 'video/VP8'
    };

    const CODEC_LABEL = {
        h264: 'H.264',
        av1: 'AV1',
        vp9: 'VP9',
        vp8: 'VP8'
    };

    // --- DOM elements -----------------------------------------------------

    const shell = document.getElementById('studio-shell');
    const preview = document.getElementById('studio-preview');
    const previewEmpty = document.getElementById('preview-empty');
    const statusBadge = document.getElementById('studio-status');
    const statusText = document.getElementById('studio-status-text');

    const startBtn = document.getElementById('btn-start');
    const stopBtn = document.getElementById('btn-stop');
    const transportNote = document.getElementById('transport-note');
    const pickSourceBtn = document.getElementById('btn-pick-source');

    const modeButtons = Array.from(document.querySelectorAll('.studio-seg'));
    const sourceInfo = document.getElementById('source-info');
    const sourceInfoIcon = document.getElementById('source-info-icon');
    const sourceInfoText = document.getElementById('source-info-text');

    const micCheckbox = document.getElementById('chk-mic');
    const micGain = document.getElementById('mic-gain');
    const micGainValue = document.getElementById('mic-gain-value');
    const micGainRow = document.getElementById('mic-gain-row');
    const systemAudioCheckbox = document.getElementById('chk-system-audio');
    const systemGain = document.getElementById('system-gain');
    const systemGainValue = document.getElementById('system-gain-value');
    const systemGainRow = document.getElementById('system-gain-row');
    const outgoingLevel = document.getElementById('outgoing-level');
    const audioHint = document.getElementById('audio-hint');

    const codecSelect = document.getElementById('sel-codec');
    const resolutionSelect = document.getElementById('sel-resolution');
    const framerateSelect = document.getElementById('sel-framerate');
    const bitrateSlider = document.getElementById('rng-bitrate');
    const bitrateValue = document.getElementById('bitrate-value');
    const audioBitrateSelect = document.getElementById('sel-audio-bitrate');
    const cbrCheckbox = document.getElementById('chk-cbr');
    const contentHintSelect = document.getElementById('sel-content-hint');

    const meters = document.getElementById('studio-meters');
    const meterBitrate = document.getElementById('meter-bitrate');
    const meterFps = document.getElementById('meter-fps');
    const meterResolution = document.getElementById('meter-resolution');
    const meterCodec = document.getElementById('meter-codec');
    const meterRtt = document.getElementById('meter-rtt');
    const meterKeyframes = document.getElementById('meter-keyframes');

    const toast = document.getElementById('studio-toast');
    const toastText = document.getElementById('studio-toast-text');
    const toastIcon = document.getElementById('toast-icon');
    const toastClose = document.getElementById('toast-close');
    const busy = document.getElementById('studio-busy');
    const busyText = document.getElementById('studio-busy-text');

    // --- Mutable state ----------------------------------------------------

    let displayStream = null;
    let micStream = null;

    // The single audio track handed to the peer connection. Mixing happens in
    // the Web Audio graph; MediaMTX accepts one audio m-section, so the graph
    // output — not the individual sources — is what gets added to the PC.
    let mixedAudioTrack = null;
    let audioContext = null;
    let micSourceNode = null;
    let displayAudioSourceNode = null;
    let micGainNode = null;
    let displayGainNode = null;
    let outgoingAnalyser = null;
    let levelRafId = null;

    let peerConnection = null;
    let videoSender = null;
    let whipSessionUrl = null;

    let selectedMode = 'monitor';
    let statsTimer = null;
    let toastTimer = null;
    let isPublishing = false;
    // True between the user committing to a broadcast and the WHIP session
    // being live. It is the guard for the window that `isPublishing` cannot
    // cover: startPublishing() is async, and without this a second click during
    // the mic prompt or the WHIP POST would start a second broadcast.
    let isStarting = false;
    let isTearingDown = false;

    // Rolling stats state, used to turn cumulative counters into rates.
    let lastStats = null;
    // True while a getStats() call is awaiting, so the 1s interval cannot start
    // a second one that would race the rate baseline.
    let statsInFlight = false;
    let levelData = null;
    // True when the audio graph exists but the browser has blocked it from
    // running, so the published track carries silence. Set by the resume in
    // buildAudioGraph and read once, when the broadcast is announced, so the
    // studio states one consistent verdict instead of a toast that lands after
    // the success message and contradicts it.
    let audioIsSilent = false;
    // ==========================================================================
    // Small UI helpers
    // ==========================================================================

    function setStatus(state, label) {
        if (statusBadge) statusBadge.setAttribute('data-state', state);
        if (statusText) statusText.textContent = label;
    }

    function showToast(message, kind) {
        if (!toast) return;
        if (toastText) toastText.textContent = message;
        toast.hidden = false;
        toast.classList.toggle('is-error', kind === 'error');
        toast.classList.toggle('is-warning', kind === 'warning');
        if (toastIcon) {
            const icon = kind === 'error'
                ? 'fa-circle-exclamation'
                : (kind === 'warning' ? 'fa-triangle-exclamation' : 'fa-circle-info');
            toastIcon.className = `fa-solid ${icon}`;
        }
        // A warning about taking over a running OBS session must not vanish on
        // a timer while the user is still deciding, so warnings persist until
        // dismissed.
        if (toastTimer) clearTimeout(toastTimer);
        if (kind !== 'warning') {
            toastTimer = setTimeout(() => {
                if (toast) toast.hidden = true;
            }, 6000);
        }
    }

    function setBusy(isBusy, message) {
        if (!busy) return;
        busy.hidden = !isBusy;
        busy.setAttribute('aria-hidden', String(!isBusy));
        if (message && busyText) busyText.textContent = message;
    }

    function setTransport(canStart, note) {
        if (startBtn) startBtn.disabled = !canStart;
        if (stopBtn) stopBtn.hidden = !isPublishing;
        if (transportNote && note) transportNote.textContent = note;
    }

    // Paints the filled portion of a range input. WebKit has no ::-moz-range-track
    // equivalent, so the fill has to be a CSS custom property on the element.
    function paintSlider(slider) {
        if (!slider) return;
        const min = Number(slider.min || 0);
        const max = Number(slider.max || 100);
        const value = Number(slider.value);
        const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
        slider.style.setProperty('--studio-fill', `${pct}%`);
    }

    function formatBitrate(bitsPerSecond) {
        if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '0 kbps';
        const kbps = bitsPerSecond / 1000;
        if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`;
        return `${Math.round(kbps)} kbps`;
    }

    function hasSource() {
        // Liveness, not mere presence. A MediaStream whose tracks have been
        // stopped still reports them, and `track.stop()` never fires 'ended' -- so
        // a presence check reports a dead capture as ready, re-enables Start, and
        // the retry publishes a permanently silent video track. Nothing else in
        // this file checked readyState, so this is the only guard.
        if (!displayStream) return false;
        return displayStream.getVideoTracks().some((track) => track.readyState === 'live');
    }

    // ==========================================================================
    // ICE configuration
    // ==========================================================================
    // ICE servers come from the project's own /stream-api/turn, the same
    // endpoint the viewer uses, so there is no second STUN/TURN source to keep
    // in sync and no hardcoded server list in this file.

    let cachedIceServers = null;

    async function getIceServers() {
        if (cachedIceServers) return cachedIceServers;
        // A publisher on this laptop is on loopback or the Tailscale interface,
        // so a slow or absent TURN answer must not block the handshake.
        // 2.5s matches the viewer's budget.
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        try {
            const response = await fetch(window.location.origin + '/stream-api/turn', {
                cache: 'no-store',
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`ICE config request failed: ${response.status}`);
            const data = await response.json();
            cachedIceServers = Array.isArray(data.iceServers) ? data.iceServers : [];
        } catch (err) {
            // STUN-only fallback: with no ICE servers at all, ICE still gathers
            // host candidates, which is all a same-machine publisher needs. A
            // remote publisher degrades to "may not connect", which is strictly
            // better than refusing to start.
            console.warn('[Studio] ICE config unavailable, continuing with host candidates only:', err);
            cachedIceServers = [];
        } finally {
            clearTimeout(timer);
        }
        return cachedIceServers;
    }
    // ==========================================================================
    // Codec selection
    // ==========================================================================
    // Prefers the user's chosen codec and demotes the others instead of
    // filtering them out. Demotion rather than removal is deliberate: if the
    // chosen codec turns out to be unencodable on this machine, the offer still
    // carries a working codec and the broadcast starts on that instead of
    // failing outright. The answer SDP is parsed afterwards to report what was
    // ACTUALLY negotiated, so a mismatch is visible rather than silent.
    function prioritizeCodecs(capabilities, wantedMime) {
        const all = Array.isArray(capabilities && capabilities.codecs) ? capabilities.codecs : [];
        if (!all.length) return all;

        // RTX entries must stay paired with the payload type they protect, so
        // they are matched to the primary codec by their `apt` fmtp rather than
        // reordered independently. Dropping the rtx would cost the viewer its
        // retransmissions, which is what turns a lost packet into frozen video.
        const rtxFor = (payloadType) => all.find((c) => {
            if (!/^video\/rtx$/i.test(c.mimeType)) return false;
            const apt = /apt=(\d+)/i.exec(c.sdpFmtpLine || '');
            return apt && Number(apt[1]) === payloadType;
        });

        const primary = all.filter((c) => !/^video\/(rtx|red|ulpfec|flexfec)$/i.test(c.mimeType));
        const wanted = primary.filter((c) => (c.mimeType || '').toLowerCase() === wantedMime);

        if (!wanted.length) return all;

        // For the wanted mime, prefer the LAST registered variant: browsers list
        // H.264 several times with different profile-level-ids and the final
        // entry is normally the highest-capability one they can encode.
        const chosen = wanted[wanted.length - 1];
        const rtx = rtxFor(chosen.payloadType);
        const head = rtx ? [chosen, rtx] : [chosen];
        const rest = all.filter((c) => c !== chosen && c !== rtx);

        return head.concat(rest);
    }

    function applyCodecPreference(pc, wantedKey) {
        const wantedMime = CODEC_MIME[wantedKey];
        if (!wantedMime) return;

        const transceiver = pc.getTransceivers().find((t) => t.sender && t.sender.track
            && t.sender.track.kind === 'video');
        if (!transceiver) return;

        const capabilities = typeof RTCRtpTransceiver.getCapabilities === 'function'
            ? RTCRtpTransceiver.getCapabilities('video')
            : null;
        const ordered = prioritizeCodecs(capabilities, wantedMime.toLowerCase());
        if (!ordered.length) return;

        try {
            // Throws if the transceiver has already started sending, which is
            // why this runs before createOffer and never after.
            transceiver.setCodecPreferences(ordered);
        } catch (err) {
            console.warn('[Studio] Could not set codec preferences, using browser default:', err);
        }
    }

    // ==========================================================================
    // Audio graph
    // ==========================================================================
    // MediaMTX accepts exactly one audio track, so the microphone and the
    // captured system/tab audio are summed in a Web Audio graph and the graph's
    // MediaStreamAudioDestinationNode output is what gets published. Gain is
    // applied here rather than by muting the source tracks, so a level can be
    // changed live without renegotiating.

    function buildAudioGraph() {
        teardownAudioGraph();

        const sources = [];
        if (micStream) sources.push({ kind: 'mic', stream: micStream });
        if (displayStream && displayStream.getAudioTracks().length) {
            sources.push({ kind: 'display', stream: displayStream });
        }
        if (!sources.length) return null;

        try {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        } catch (err) {
            console.error('[Studio] Could not create AudioContext:', err);
            audioContext = null;
            return null;
        }

        const destination = audioContext.createMediaStreamDestination();
        // An AudioContext created outside a user gesture starts SUSPENDED under
        // Chrome's autoplay policy, and a suspended context still produces a
        // live MediaStreamAudioDestinationNode track — it just carries silence.
        // The broadcast would then go out looking perfectly healthy and
        // audibly empty, which is the worst possible failure mode for this
        // control. The start button is the gesture, but the awaits between the
        // click and here (ICE config, the WHIP POST) can outlive the transient
        // activation, so the state is checked and resumed explicitly.
        //
        // The verdict is STORED rather than toasted here. A toast fired from a
        // promise callback lands AFTER the "Broadcasting ..." message the
        // publish path composes, so it would replace the success message with a
        // stale warning — and, worse, could do so while the success message
        // claimed audio. startPublishing reads `audioIsSilent` once and says one
        // consistent thing.
        if (audioContext.state === 'suspended') {
            audioContext.resume()
                .then(() => {
                    if (audioContext) {
                        audioContext.state === 'running' ? (audioIsSilent = false) : (audioIsSilent = true);
                    }
                    console.log('[Studio] AudioContext resumed, state:', audioContext ? audioContext.state : 'closed');
                })
                .catch((err) => {
                    // Worth recording: the stream is going out silent.
                    console.warn('[Studio] AudioContext could not be resumed:', err);
                    audioIsSilent = true;
                });
        }
        outgoingAnalyser = audioContext.createAnalyser();
        outgoingAnalyser.fftSize = 1024;
        // Short window: the meter is a live readout, and a large FFT would
        // visibly lag behind speech.
        outgoingAnalyser.smoothingTimeConstant = 0.6;
        levelData = new Uint8Array(outgoingAnalyser.fftSize);

        for (const source of sources) {
            try {
                const node = audioContext.createMediaStreamSource(source.stream);
                const gain = audioContext.createGain();
                node.connect(gain);
                gain.connect(destination);
                gain.connect(outgoingAnalyser);

                if (source.kind === 'mic') {
                    micSourceNode = node;
                    micGainNode = gain;
                } else {
                    displayAudioSourceNode = node;
                    displayGainNode = gain;
                }
            } catch (err) {
                // One bad source must not cost the other: a mic that fails to
                // connect still leaves the system audio publishable.
                console.error(`[Studio] Could not route ${source.kind} audio:`, err);
            }
        }

        if (destination.stream.getAudioTracks().length) {
            mixedAudioTrack = destination.stream.getAudioTracks()[0];
        }

        applyGainValues();
        return mixedAudioTrack;
    }

    function applyGainValues() {
        if (micGainNode) {
            micGainNode.gain.value = micCheckbox && micCheckbox.checked
                ? Number(micGain.value) / 100
                : 0;
        }
        if (displayGainNode) {
            displayGainNode.gain.value = systemAudioCheckbox && systemAudioCheckbox.checked
                ? Number(systemGain.value) / 100
                : 0;
        }
    }

    function teardownAudioGraph() {
        stopLevelMeter();
        micSourceNode = null;
        displayAudioSourceNode = null;
        micGainNode = null;
        displayGainNode = null;
        outgoingAnalyser = null;
        levelData = null;
        if (mixedAudioTrack) {
            // The track belongs to the graph; stopping it is what actually ends
            // what the peer connection is sending.
            try { mixedAudioTrack.stop(); } catch (err) { /* already ended */ }
            mixedAudioTrack = null;
        }
        if (audioContext) {
            const context = audioContext;
            audioContext = null;
            context.close().catch(() => {});
        }
    }

    // Drives the outgoing level bar from an AnalyserNode on the mixed graph.
    function startLevelMeter() {
        stopLevelMeter();
        const tick = () => {
            if (!outgoingAnalyser || !levelData) return;
            outgoingAnalyser.getByteTimeDomainData(levelData);
            let peak = 0;
            for (let i = 0; i < levelData.length; i += 1) {
                const amplitude = Math.abs(levelData[i] - 128) / 128;
                if (amplitude > peak) peak = amplitude;
            }
            if (outgoingLevel) {
                // Full-scale is drawn as 100%, and a genuine clip is held at
                // 100% rather than allowed to run off the end of the bar.
                outgoingLevel.style.width = `${Math.min(100, peak * 100)}%`;
            }
            levelRafId = requestAnimationFrame(tick);
        };
        levelRafId = requestAnimationFrame(tick);
    }

    function stopLevelMeter() {
        if (levelRafId) {
            cancelAnimationFrame(levelRafId);
            levelRafId = null;
        }
        if (outgoingLevel) outgoingLevel.style.width = '0%';
    }

    // ==========================================================================
    // WHIP publish (RFC 9725)
    // ==========================================================================
    // The whole handshake, with no library. The order is fixed by the RFC and by
    // MediaMTX's handler: gather ICE fully into the offer (non-trickle, so no
    // PATCH is needed and no candidate can arrive after the answer), POST
    // application/sdp, read Location off the 201, adopt the answer.

    // Resolves when ICE gathering finishes, or rejects on timeout.
    //
    // The listener is attached AFTER setLocalDescription, which is the only
    // ordering that cannot miss candidates: gathering starts inside
    // setLocalDescription and 'complete' can fire before a later-registered
    // listener exists. Re-checking the state on entry closes that race.
    function waitForIceGathering(pc, timeoutMs) {
        return new Promise((resolve, reject) => {
            if (pc.iceGatheringState === 'complete') {
                resolve();
                return;
            }

            let settled = false;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                pc.removeEventListener('icegatheringstatechange', onStateChange);
                pc.removeEventListener('icecandidate', onCandidate);
                fn(value);
            };

            const onStateChange = () => {
                if (pc.iceGatheringState === 'complete') finish(resolve);
            };

            // Some builds never fire 'complete' but do stop emitting. A null
            // candidate is the spec's end-of-gathering signal, so treat it as
            // completion rather than waiting out the full timeout.
            const onCandidate = (event) => {
                if (!event.candidate) finish(resolve);
            };

            const timer = setTimeout(
                () => finish(reject, new Error('ICE gathering did not complete in time')),
                timeoutMs
            );

            pc.addEventListener('icegatheringstatechange', onStateChange);
            pc.addEventListener('icecandidate', onCandidate);
        });
    }

    // Reads the codec MediaMTX actually chose out of the answer SDP, so the UI
    // reports the negotiated codec rather than the requested one. Returns null
    // when it cannot tell, which is a normal outcome handled quietly.
    function readNegotiatedCodec(answerSdp) {
        if (typeof answerSdp !== 'string') return null;
        // Only the video section: the first m=video block, up to the next m=.
        const videoStart = answerSdp.indexOf('m=video');
        if (videoStart === -1) return null;
        const rest = answerSdp.slice(videoStart);
        const nextSection = rest.indexOf('\nm=');
        const section = nextSection === -1 ? rest : rest.slice(0, nextSection);

        const match = /a=rtpmap:(\d+)\s+([^/]+)\//i.exec(section);
        if (!match) return null;
        const name = match[2].trim().toUpperCase();
        return name === 'H264' ? 'H.264' : name;
    }

    async function startPublishing() {
        if (isPublishing) return;
        if (!hasSource()) {
            showToast('Choose a screen, window or tab first.', 'warning');
            return;
        }

        setBusy(true, 'Starting broadcast…');
        setStatus('connecting', 'Connecting');

        try {
            const iceServers = await getIceServers();

            // A fresh connection per broadcast. Reusing a closed PC is a
            // documented way to end up with a half-open session, and the user
            // may have changed sources between broadcasts.
            const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
            peerConnection = pc;

            const videoTrack = displayStream.getVideoTracks()[0];
            // 'detail' biases the encoder toward SPATIAL detail at the expense of
            // temporal detail, so it is a control rather than a constant — a
            // game or a video stream wants the opposite trade. Set from the
            // control on BOTH assignment sites: this one runs after
            // pickSource(), so hardcoding it here silently reverted the
            // operator's choice for every broadcast started from the button.
            if ('contentHint' in videoTrack) videoTrack.contentHint = currentContentHint();

            try {
                videoSender = pc.addTrack(videoTrack, new MediaStream([videoTrack]));
            } catch (err) {
                throw new Error(`could not add the video track (${err.message})`);
            }

            // The graph is built before the offer so the single mixed audio
            // track can join the SAME session: MediaMTX rejects a second audio
            // m-section, and a renegotiation would mean restarting the
            // broadcast, which is exactly the interruption a viewer notices.
            buildAudioGraph();
            // `audioAdded` is what the announcement reads, NOT `mixedAudioTrack`.
            // A track can exist in the graph and still fail to attach: if
            // addTrack throws, mixedAudioTrack is still non-null, and branching
            // on it would announce a broadcast that is carrying no audio as
            // "with audio".
            let audioAdded = false;
            if (mixedAudioTrack) {
                try {
                    pc.addTrack(mixedAudioTrack, new MediaStream([mixedAudioTrack]));
                    audioAdded = true;
                } catch (err) {
                    console.warn('[Studio] Could not add the mixed audio track, going video-only:', err);
                }
            }

            applyCodecPreference(pc, codecSelect.value);

            // ICE failure is the one error the user can actually act on, so it
            // is surfaced instead of being left to time out silently — and the
            // session is actually ended. MediaMTX keeps the path "online" for
            // as long as the publisher connection is alive, so a peer
            // connection that has failed but is not closed leaves the host
            // pushing into a session no one is watching.
            pc.addEventListener('iceconnectionstatechange', () => {
                if (peerConnection !== pc) return;
                if (pc.iceConnectionState === 'failed') {
                    showToast('The connection to the host failed and the broadcast was stopped. Check for something blocking UDP, then start again.', 'error');
                    // keepSource, because the capture is still perfectly good -
                    // the network was not. Without it the user's chosen source
                    // is destroyed and the follow-up setTransport would then
                    // tell them to press a Start button that is disabled with
                    // no source behind it.
                    teardown({ keepSource: true }).then(() => {
                        setStatus('error', 'Failed');
                        setTransport(hasSource(), 'Ready. Press start to try again.');
                    });
                }
            });

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await waitForIceGathering(pc, ICE_GATHER_TIMEOUT_MS);

            if (!pc.localDescription || !pc.localDescription.sdp) {
                throw new Error('no local description was produced');
            }

            setBusy(true, 'Publishing to the stream…');

            // The Opus fmtp is rewritten here, not earlier: this is the last
            // point where the SDP is still ours, since the POST body is built
            // from the rewritten copy below.
            const offerSdp = applyAudioBitrateToSdp(pc.localDescription.sdp);

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), WHIP_POST_TIMEOUT_MS);

            let response;
            try {
                response = await fetch(window.location.origin + WHIP_PATH, {
                    method: 'POST',
                    // Mandatory: MediaMTX answers 400 for any other type.
                    headers: { 'Content-Type': 'application/sdp' },
                    body: offerSdp,
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timer);
            }

            if (response.status !== 201) {
                const detail = await response.text().catch(() => '');
                throw new Error(describeWhipFailure(response.status, detail));
            }

            // Location is the resource that ends the session. The proxy rewrites
            // it onto the /stream-api prefix, and it is only readable because
            // server.js exposes it via Access-Control-Expose-Headers.
            //
            // A missing Location is a hard error, not something to work around:
            // without it there is no resource to DELETE, so the session would
            // live until MediaMTX's read timeout, holding this laptop's upload
            // with nothing able to stop it. Better to refuse the broadcast.
            const sessionLocation = response.headers.get('Location');
            if (!sessionLocation) {
                throw new Error('MediaMTX accepted the publish but returned no session URL, so it could not be ended cleanly.');
            }
            whipSessionUrl = sessionLocation;
            const answerSdp = await response.text();
            await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

            isPublishing = true;
            setBusy(false);
            setStatus('live', 'Live');
            setTransport(false, 'Broadcasting. Viewers are connected.');

            if (meters) meters.hidden = false;
            startLevelMeter();
            startStatsLoop();
            // Apply the user's chosen bitrate/fps to the live sender. Without
            // this the first sample would use the browser's default until they
            // touched a control, which is a different rate than the one shown.
            applyVideoEncoding();

            // Let the audio graph settle before announcing the broadcast, so
            // the message states one final verdict. resume() is only pending
            // when the context was suspended, and a context that is already
            // running needs no wait at all.
            if (audioContext && audioContext.state !== 'running') {
                try {
                    await audioContext.resume();
                } catch (err) {
                    console.warn('[Studio] AudioContext could not be resumed:', err);
                }
                audioIsSilent = !audioContext || audioContext.state !== 'running';
            } else if (!audioContext) {
                audioIsSilent = true;
            } else {
                audioIsSilent = false;
            }

            // The success message is composed LAST, from the settled audio
            // state. Publishing with no sound while the UI says it is
            // broadcasting normally is the failure users report as "the audio
            // is broken" an hour later.
            const negotiated = readNegotiatedCodec(answerSdp);
            const requested = CODEC_LABEL[codecSelect.value] || codecSelect.value;
            const published = negotiated || requested;
            // A codec substitution is a note ON the announcement, never a
            // second toast: showToast writes a single element, so a follow-up
            // call replaces the audio verdict with the codec note and the
            // "NO AUDIO" warning is never seen. One message, one truth.
            const codecNote = negotiated && negotiated !== requested
                ? ` (you asked for ${requested})`
                : '';
            if (!audioAdded) {
                showToast(`Broadcasting ${published}${codecNote} — NO AUDIO. The browser captured no microphone and no system/tab audio.`, 'warning');
            } else if (audioIsSilent) {
                showToast(`Broadcasting ${published}${codecNote} with SILENT audio. The browser is blocking playback — click the page once and start again.`, 'warning');
            } else {
                showToast(`Broadcasting ${published}${codecNote} with audio.`, 'info');
            }
        } catch (err) {
            console.error('[Studio] Failed to start broadcasting:', err);
            await teardown({ keepSource: true });
            setBusy(false);
            setStatus('error', 'Failed');
            setTransport(hasSource(), 'Choose a source to unlock broadcasting.');
            showToast(describeStartError(err), 'error');
        }
    }

    // ==========================================================================
    // Teardown
    // ==========================================================================
    // Reached from three directions, so it MUST be idempotent and safe to call
    // when nothing is running:
    //   1. the user presses Stop
    //   2. the browser's own "Stop sharing" bar ends the capture track
    //   3. a failed start
    // Paths 1 and 2 can both fire for one user action, and `isTearingDown`
    // stops whichever arrives first from re-entering — without that guard the
    // DELETE and the track stop both run twice and the second DELETE 404s.

    async function teardown(options) {
        const keepSource = Boolean(options && options.keepSource);
        if (isTearingDown) return;
        isTearingDown = true;

        try {
            stopStatsLoop();
            stopLevelMeter();

            // End the MediaMTX session first: it is the only step that frees
            // upload bandwidth on the host, so it must happen even if closing
            // the peer connection throws. This path awaits the DELETE (so a
            // failure is visible) rather than firing it blind like pagehide.
            if (whipSessionUrl) {
                const sessionUrl = whipSessionUrl;
                whipSessionUrl = null;
                try {
                    // keepalive so the DELETE still leaves the page if this runs
                    // from the unload handler. The AbortController is not
                    // cosmetic: this is the only network call in the file without
                    // a bound, and a stalled DELETE would hold `isTearingDown`
                    // true forever -- wedging teardown permanently, leaving the UI
                    // stuck mid-transition with no way to recover but reloading.
                    // The session is nulled above, so timing out here cannot cause
                    // a double DELETE.
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), WHIP_DELETE_TIMEOUT_MS);
                    try {
                        await fetch(sessionUrl, { method: 'DELETE', keepalive: true, signal: controller.signal });
                    } finally {
                        clearTimeout(timer);
                    }
                } catch (err) {
                    // MediaMTX also expires the session when the publisher
                    // connection drops, so a failed DELETE is not fatal.
                    console.warn('[Studio] WHIP session DELETE failed (the path frees on disconnect):', err);
                }
            }

            if (peerConnection) {
                const pc = peerConnection;
                peerConnection = null;
                try {
                    // The sender's video track IS the display track (pc.addTrack
                    // in startPublishing), so stopping it here would destroy the
                    // very capture `keepSource` promises to preserve -- and
                    // track.stop() never fires 'ended', so nothing downstream
                    // would ever learn the source died. The caller would then
                    // re-enable Start on a dead source and the retry would
                    // publish a permanently silent m-section. The whole point of
                    // keepSource is "the capture is fine, the network was not".
                    const keptVideoTracks = keepSource && displayStream
                        ? displayStream.getVideoTracks()
                        : [];
                    pc.getSenders().forEach((sender) => {
                        if (!sender.track) return;
                        if (keptVideoTracks.includes(sender.track)) return;
                        sender.track.stop();
                    });
                } catch (err) {
                    console.warn('[Studio] Error stopping senders:', err);
                }
                try {
                    pc.close();
                } catch (err) {
                    console.warn('[Studio] Error closing the peer connection:', err);
                }
            }

            videoSender = null;
            isPublishing = false;
            lastStats = null;

            teardownAudioGraph();
            if (!keepSource) {
                teardownCapture();
                updateSourceUi();
            }

            if (meters) meters.hidden = true;
            resetMeters();
        } finally {
            isTearingDown = false;
        }
    }

    function resetMeters() {
        if (meterBitrate) meterBitrate.textContent = '0 kbps';
        if (meterFps) meterFps.textContent = '0';
        if (meterResolution) meterResolution.textContent = '—';
        if (meterCodec) meterCodec.textContent = '—';
        if (meterRtt) meterRtt.textContent = '— ms';
        if (meterKeyframes) meterKeyframes.textContent = '0';
    }

    // Stops the capture tracks and forgets the streams. The microphone is
    // stopped here too: leaving it live would show a recording indicator to
    // everyone in the room after the broadcast ended.
    function teardownCapture() {
        if (displayStream) {
            displayStream.getTracks().forEach((track) => {
                track.onended = null;
                try { track.stop(); } catch (err) { /* already stopped */ }
            });
            displayStream = null;
        }
        if (micStream) {
            micStream.getTracks().forEach((track) => {
                try { track.stop(); } catch (err) { /* already stopped */ }
            });
            micStream = null;
        }
    }

    // ==========================================================================
    // Error messages
    // ==========================================================================
    // MediaMTX error bodies are terse and sometimes empty, so each status gets
    // a sentence that says what to do rather than repeating the code. 403 in
    // particular is nearly always the v1.21.1 origin check on POST, and that
    // one is worth naming because it is otherwise invisible: the browser shows
    // an opaque CORS failure and MediaMTX logs nothing.

    function describeWhipFailure(status, detail) {
        const body = (detail || '').trim();
        switch (status) {
            case 400:
                return 'MediaMTX rejected the offer as malformed. This browser produced an SDP MediaMTX could not parse.';
            case 401:
            case 403:
                return 'MediaMTX refused the publish (403). This is usually the origin check on webrtcAllowOrigins — it must stay ["*"], never [].';
            case 404:
                return 'MediaMTX has no WHIP endpoint on this path. Is it running?';
            case 405:
                return 'MediaMTX rejected the publish method.';
            case 415:
                return 'MediaMTX refused the Content-Type. WHIP requires application/sdp.';
            case 500:
            case 502:
            case 503:
                return 'The host server could not reach MediaMTX. Is start_host.bat running?';
            default:
                return body
                    ? `MediaMTX refused the publish (${status}): ${body}`
                    : `MediaMTX refused the publish (${status}).`;
        }
    }

    function describeStartError(err) {
        const message = (err && err.message) || String(err);
        if (err && err.name === 'AbortError') {
            return 'The publish handshake timed out. MediaMTX allows about 12s; check that it is running.';
        }
        if (/DataChannel/i.test(message) || /application/i.test(message)) {
            return 'The connection carried something MediaMTX cannot accept. Reload the page and try again.';
        }
        return `Could not start broadcasting: ${message}`;
    }

    // ==========================================================================
    // Source capture
    // ==========================================================================
    // Asks MediaMTX whether something is already publishing. `live` is
    // configured with overridePublisher: yes, so a browser publish silently
    // displaces a running OBS session. Surfacing that BEFORE the publish is the
    // whole point: the alternative is the broadcaster only learning their OBS
    // stream died when viewers start reporting it.
    async function isAlreadyPublishing() {
        try {
            const response = await fetch(window.location.origin + MEDIAMTX_API_PATH, {
                cache: 'no-store',
                // Bounded like every other request in this file. This probe is
                // AWAITED inside pickSource(), so an unbounded stall would hang
                // the source picker with no error and no way forward.
                signal: AbortSignal.timeout(PATH_PROBE_TIMEOUT_MS)
            });
            if (!response.ok) return false;
            const data = await response.json();
            const items = Array.isArray(data.items) ? data.items : [];
            const path = items.find((entry) => entry && entry.name === STREAM_PATH);
            if (!path) return false;
            return Boolean(path.ready || path.online);
        } catch (err) {
            // The probe is advisory. A failure must not block the broadcast, so
            // it reports "no" and lets the user proceed.
            console.warn('[Studio] Could not check for an existing publisher:', err);
            return false;
        }
    }

    async function pickSource() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            showToast('This browser cannot capture a screen. Chrome, Edge or another Chromium browser is required.', 'error');
            return;
        }

        // Stop a previous capture before opening a new picker: the user is
        // replacing the source, and two live display tracks would mean two
        // capture indicators and a doubled encode if both were added.
        if (displayStream) {
            teardownAudioGraph();
            teardownCapture();
            displayStream = null;
            updateSourceUi();
        }

        // `ideal` alone is only a REQUEST: a browser is free to ignore it, and
        // this one routinely does. That made the Frame rate and Resolution
        // controls purely advisory — selecting 15 fps on a loaded machine still
        // produced 60, and nothing on screen said otherwise. `max` is the
        // constraint that actually caps, and unlike `min`/`exact` (which a
        // display track cannot satisfy, surfacing as OverconstrainedError at
        // capture time) it is legal here, so both keys are set: `ideal` asks for
        // the value, `max` guarantees no more than it.
        const width = RESOLUTION_MAP[resolutionSelect.value];
        const requestedFps = Number(framerateSelect.value) || 30;
        const videoConstraints = {
            frameRate: { ideal: requestedFps, max: requestedFps }
        };
        if (width) {
            videoConstraints.width = { ideal: width.width, max: width.width };
            videoConstraints.height = { ideal: width.height, max: width.height };
        }

        // The hints below only bias the picker; the user always chooses. They
        // are Chrome-desktop features and are simply ignored elsewhere.
        const constraints = {
            video: Object.assign({}, videoConstraints, {
                displaySurface: selectedMode,
                surfaceSwitching: 'include',
                selfBrowserSurface: 'exclude'
            }),
            // System/tab audio is offered by the picker itself. The user may
            // leave it unticked, so the resolved stream is the only authority
            // on whether it exists.
            audio: { systemAudio: 'include' }
        };

        let stream;
        try {
            stream = await navigator.mediaDevices.getDisplayMedia(constraints);
        } catch (err) {
            reportCaptureError(err);
            return;
        }

        const videoTracks = stream.getVideoTracks();
        if (!videoTracks.length) {
            stream.getTracks().forEach((track) => track.stop());
            showToast('No video track was returned by the picker.', 'error');
            return;
        }

        displayStream = stream;
        const videoTrack = videoTracks[0];
        if ('contentHint' in videoTrack) videoTrack.contentHint = currentContentHint();

        // The user can end the share from the browser's own bar without ever
        // touching this page. `ended` is the ONLY signal for that — calling
        // stop() ourselves does not fire it — so this is what keeps the UI and
        // the MediaMTX session from outliving the share.
        videoTrack.onended = () => {
            if (isTearingDown) return;
            handleCaptureEnded();
        };

        // The picker can hand back a different surface than the mode the user
        // selected, so the label reports the real one.
        describeSource(videoTrack);
        // The capture rate is the browser's to decide, so report what it
        // actually settled on rather than what was asked for.
        reportAchievedFrameRate(videoTrack);

        if (preview) {
            preview.srcObject = stream;
            // Autoplay of a muted local preview is allowed; the rejection is
            // still caught because a policy change must not break capture.
            preview.play().catch((err) => {
                console.warn('[Studio] Preview autoplay was blocked:', err);
            });
        }
        if (shell) shell.classList.add('has-source');

        // Audio availability is only knowable after the picker resolves.
        syncAudioAvailability();

        setStatus('capturing', 'Ready to go live');
        setTransport(true, 'Ready. Press start when you are.');

        if (await isAlreadyPublishing()) {
            showToast('Something is already publishing to this stream. Going live here will replace it.', 'warning');
            setTransport(true, 'Another publisher is live — starting will replace it.');
        }
    }

    // Turns a getDisplayMedia rejection into something actionable. Each name
    // below is a distinct real cause with a distinct user action, and collapsing
    // them into "capture failed" is what makes this API so frustrating to debug.
    function reportCaptureError(err) {
        const name = (err && err.name) || '';
        switch (name) {
            case 'NotAllowedError':
                // Also fires when the picker is simply dismissed, which is not an
                // error worth a red banner.
                showToast('Screen sharing was cancelled or blocked. Allow it in the site settings, then try again.', 'warning');
                break;
            case 'NotFoundError':
                showToast('No capture source is available on this device.', 'error');
                break;
            case 'NotReadableError':
                showToast('The screen could not be read — it may be locked, or another app is using it exclusively.', 'error');
                break;
            case 'AbortError':
                showToast('The capture was interrupted before it started.', 'warning');
                break;
            case 'InvalidStateError':
                showToast('The page is not allowed to capture. Reload the page and press start again.', 'error');
                break;
            case 'TypeError':
                // This is the min/exact constraint trap, not a permission
                // problem, and saying so saves a wild goose chase.
                showToast('The browser rejected the capture constraints (min/exact are not allowed here).', 'error');
                break;
            default:
                console.warn('[Studio] Unexpected capture error:', err);
                showToast(`Could not start the capture: ${(err && err.message) || 'unknown error'}.`, 'error');
        }
    }

    // The picker can return a different surface than the mode button suggests,
    // and the user can switch surfaces mid-share. Reporting the real one keeps
    // the label honest instead of claiming "Screen" while a window is shared.
    function describeSource(videoTrack) {
        if (!videoTrack) return;
        const settings = typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
        const surface = settings.displaySurface;

        const label = surface === 'monitor' ? 'Entire screen'
            : surface === 'window' ? 'Application window'
            : surface === 'browser' ? 'Browser tab'
            : 'Screen source';

        if (sourceInfo) sourceInfo.hidden = false;
        if (sourceInfoText) {
            const dims = settings.width && settings.height ? ` — ${settings.width}×${settings.height}` : '';
            sourceInfoText.textContent = label + dims;
        }
        if (sourceInfoIcon) sourceInfoIcon.className = 'fa-solid fa-circle-check';
        if (sourceInfo) sourceInfo.classList.remove('is-warning');
    }

    // Encoder content hint. 'detail' tells the encoder this is screen content
    // where spatial sharpness (text) matters more than motion smoothness, which
    // is right for most desktops and wrong for a game or a video. It biases the
    // encoder AWAY from spending bits on frame rate, so it is exposed as a
    // control rather than hardcoded. Safe when the control is absent: 'detail'
    // is the previous behaviour, so an older page keeps working.
    function currentContentHint() {
        return contentHintSelect && contentHintSelect.value === 'motion' ? 'motion' : 'detail';
    }

    // The capture track's real settings, read back from the browser rather than
    // assumed from the controls. A constraint is a request: when the machine
    // cannot deliver the requested rate the browser picks its own, and the UI
    // has to say so rather than keep showing what was ASKED for. This is the
    // difference between "I set 60 and got 15" and a mystery.
    //
    // Measured after a delay, not immediately: right after the picker resolves,
    // getSettings() tends to echo the constraints that were just applied rather
    // than a settled capture rate, so a t=0 reading would never detect the
    // shortfall it exists to report.
    function reportAchievedFrameRate(videoTrack, delayMs = 1200) {
        if (!videoTrack || typeof videoTrack.getSettings !== 'function') return;
        setTimeout(() => {
            // The track can be replaced or stopped while this is pending.
            if (!displayStream || !displayStream.getVideoTracks().includes(videoTrack)) return;
            const settings = videoTrack.getSettings();
            const achieved = Number(settings.frameRate);
            if (!Number.isFinite(achieved) || achieved <= 0) return;

            const requested = Number(framerateSelect ? framerateSelect.value : 0);
            // Only complain about a real shortfall. `max` now caps the rate, so
            // a large gap means the browser clamped below the request (a busy
            // machine, or a source that cannot produce that fast), which is
            // exactly the case that used to be invisible.
            if (Number.isFinite(requested) && requested > 0 && achieved < requested * 0.9) {
                console.log(`[Studio] Capture is running at ${achieved}fps, below the requested ${requested}fps.`);
                showToast(`This source is only capturing at ${Math.round(achieved)} fps, not the ${requested} fps you asked for. `
                    + 'A busy machine or a mostly-static source is the usual cause — try a lower resolution or frame rate.',
                'warning');
            }
            // Keep the source label truthful about what is really being captured.
            if (sourceInfoText) {
                const label = sourceInfoText.textContent.split(' — ')[0];
                const dims = settings.width && settings.height ? ` — ${settings.width}×${settings.height}` : '';
                sourceInfoText.textContent = `${label}${dims} @ ${Math.round(achieved)} fps`;
            }
        }, delayMs);
    }

    // The system-audio checkbox can only be honoured if the picker actually
    // returned an audio track. Chrome lets the user untick it, and there is no
    // other signal, so this is the authoritative check.
    function syncAudioAvailability() {
        const hasDisplayAudio = Boolean(displayStream && displayStream.getAudioTracks().length);
        if (systemAudioCheckbox) {
            systemAudioCheckbox.disabled = !hasDisplayAudio;
            if (!hasDisplayAudio) systemAudioCheckbox.checked = false;
        }
        if (systemGain) systemGain.disabled = !hasDisplayAudio;
        if (systemGainRow) systemGainRow.style.opacity = hasDisplayAudio ? '1' : '0.45';

        const note = getPlatformAudioNote(hasDisplayAudio);
        if (audioHint && note) audioHint.textContent = note;
    }

    // Whole-system audio is not available everywhere, and telling the user why
    // is more useful than a silently video-only stream.
    function getPlatformAudioNote(hasDisplayAudio) {
        if (!hasDisplayAudio) {
            if (navigator.platform && /Mac/i.test(navigator.platform)) {
                return 'System audio was not shared. Chrome can capture tab audio on macOS, but not whole-system audio — share a tab, or use a microphone.';
            }
            return 'No system or tab audio was shared. Tick "Share tab audio" / "Share system audio" in the picker, or use a microphone.';
        }
        return 'System audio is being captured and mixed with the microphone.';
    }

    // The browser's own "Stop sharing" bar fired. This is a user action, not an
    // error, so the UI returns to idle and the WHIP session is ended.
    function handleCaptureEnded() {
        if (isTearingDown) return;
        teardown().then(() => {
            setStatus('idle', 'Stopped');
            setTransport(false, 'Sharing stopped. Choose a source to broadcast again.');
            showToast('Sharing stopped from the browser.', 'warning');
        });
    }

    // ==========================================================================
    // Live encoder controls
    // ==========================================================================
    // Every one of these applies to a RUNNING sender via the standard runtime
    // controls, so nothing here renegotiates: changing a setting must not drop
    // the stream for every connected viewer. Failures are reported rather than
    // swallowed, because a silently-unapplied bitrate is how a broadcast ends
    // up saturating a hotspot uplink and stuttering for everyone.

    // maxBitrate in bits/second, plus the frame-rate cap. CBR is approximated by
    // pinning a maxBitrate and setting the degradation preference to hold
    // framerate; true CBR is a property of a dedicated encoder, not of
    // RTCRtpSender, which is why the UI describes it as a constant-bitrate
    // target rather than a guarantee.
    async function applyVideoEncoding() {
        if (!videoSender) return;
        try {
            const params = videoSender.getParameters();
            if (!params.encodings || !params.encodings.length) {
                params.encodings = [{}];
            }
            const targetKbps = Number(bitrateSlider.value) || 6000;
            params.encodings[0].maxBitrate = targetKbps * 1000;
            const fps = Number(framerateSelect.value) || 30;
            params.encodings[0].maxFramerate = fps;
            // This is the only part of the "constant bitrate" control the
            // browser actually exposes. maxBitrate is a ceiling, not a target:
            // a still screen will send far less either way. What the toggle
            // really changes is what the encoder gives up when the link
            // tightens.
            if ('degradationPreference' in params) {
                if (cbrCheckbox && cbrCheckbox.checked) {
                    // Hold framerate and spend the bitrate on it: for screen
                    // content a dropped frame is a dropped line of text, so
                    // resolution is the thing that gives way, and only if the
                    // link cannot otherwise cope.
                    params.degradationPreference = 'maintain-framerate';
                } else {
                    // Variable mode: give up frame rate rather than sharpness, so
                    // motion stays smooth and text may soften on a busy screen.
                    params.degradationPreference = 'maintain-resolution';
                }
            }
            await videoSender.setParameters(params);
        } catch (err) {
            console.warn('[Studio] Could not apply the encoder settings:', err);
            showToast('This browser would not apply that encoder setting live. Restart the broadcast to use it.', 'warning');
        }
    }

    // Resolution is a capture constraint, not a sender parameter, so it goes
    // through applyConstraints on the live track. `max` (not just `ideal`) is
    // what makes the control real — see pickSource for why an ideal-only
    // constraint is advisory.
    async function applyResolution() {
        if (!displayStream) return;
        const track = displayStream.getVideoTracks()[0];
        if (!track) return;
        const entry = RESOLUTION_MAP[resolutionSelect.value];
        if (!entry) return; // "Match source" leaves the track alone.

        try {
            await track.applyConstraints({
                width: { ideal: entry.width, max: entry.width },
                height: { ideal: entry.height, max: entry.height }
            });
        } catch (err) {
            // Non-fatal: a resolution the capture cannot reach is worth saying
            // out loud, but the broadcast continues at whatever it reached.
            console.warn('[Studio] Could not apply the resolution constraint:', err);
            showToast(`This source could not be forced to ${entry.width}×${entry.height}; it stays at the size the system chose.`, 'warning');
        }
    }

    // Audio bitrate is carried in the Opus fmtp line of the offer, so it can only
    // be chosen BEFORE the SDP is sent. It is applied by rewriting the local
    // description after setLocalDescription and before the POST — the same
    // non-trickle moment where the audio section is still ours to edit.
    //
    // `maxaveragebitrate` is the parameter MediaMTX's own reference publisher
    // sets, and `stereo=1;sprop-stereo=1` is what makes MediaMTX record the
    // track as 2-channel (its to_stream.go keys the channel count off exactly
    // that substring). Dropping either is how a broadcast ends up mono, or with
    // the browser's default Opus rate regardless of what this control says.
    function applyAudioBitrateToSdp(sdp) {
        const targetBps = Number(audioBitrateSelect ? audioBitrateSelect.value : 128000);
        if (!Number.isFinite(targetBps) || targetBps <= 0) return sdp;

        const lines = sdp.split('\r\n');

        // Collect the payload type that actually names opus. Matching on the
        // fmtp line alone would also catch H.264's, which is why the rtpmap is
        // checked first.
        let opusPayloadType = null;
        for (const line of lines) {
            if (!line.startsWith('a=rtpmap:')) continue;
            if (!/ opus\/48000/i.test(line)) continue;
            opusPayloadType = line.slice('a=rtpmap:'.length).split(' ')[0];
            break;
        }
        if (opusPayloadType === null) return sdp;

        return lines.map((line) => {
            if (!line.startsWith(`a=fmtp:${opusPayloadType} `)) return line;
            return `a=fmtp:${opusPayloadType} minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=${targetBps}`;
        }).join('\r\n');
    }

    // Audio bitrate cannot change on a live WHIP session, so a mid-broadcast
    // change is explained and reverted rather than silently ignored.
    function explainAudioBitrateChange() {
        if (isPublishing) {
            showToast('Audio bitrate is fixed for the life of a WHIP session. It applies on the next broadcast.', 'info');
            if (audioBitrateSelect) audioBitrateSelect.value = '128000';
        }
    }

    // ==========================================================================
    // Publish statistics
    // ==========================================================================
    // Read from the SENDER's outbound-rtp stats, which is the only place that
    // reports what is actually leaving this machine. A publisher reading
    // inbound-rtp (what the viewer page does) would report nothing at all,
    // because nothing is arriving.

    function startStatsLoop() {
        stopStatsLoop();
        statsTimer = setInterval(updateStats, STATS_INTERVAL_MS);
        updateStats();
    }

    function stopStatsLoop() {
        if (statsTimer) {
            clearInterval(statsTimer);
            statsTimer = null;
        }
        // statsInFlight is deliberately NOT cleared here. A getStats() may still
        // be awaiting, and clearing the flag would let the next loop start a
        // second one - reintroducing the very race the flag exists to prevent.
        // The pending call clears it itself on the way out.
    }

    async function updateStats() {
        if (!peerConnection) return;
        // getStats is async and the interval can fire again before the previous
        // call resolves. Two overlapping calls would each move the rate
        // baseline, so the later result could be measured against a baseline
        // the earlier one already replaced — producing a negative or wildly
        // wrong rate, and in the worst case rewinding the baseline so the next
        // sample measures against an OLDER point.
        if (statsInFlight) return;
        statsInFlight = true;
        const pc = peerConnection;
        let report;
        try {
            report = await pc.getStats();
        } catch (err) {
            // A getStats failure during teardown is normal, not worth logging.
            statsInFlight = false;
            return;
        }
        // The connection may have been replaced or torn down while the call
        // was in flight; a report for a dead connection must not be applied.
        if (peerConnection !== pc) {
            statsInFlight = false;
            return;
        }
        statsInFlight = false;

        let outboundVideo = null;
        let candidatePair = null;

        report.forEach((stat) => {
            if (stat.type === 'outbound-rtp' && stat.kind === 'video') outboundVideo = stat;
            if (stat.type === 'candidate-pair' && (stat.nominated || stat.state === 'succeeded')) {
                candidatePair = stat;
            }
        });

        if (outboundVideo) {
            // One snapshot drives both meters. These two rates MUST be derived
            // from the same pair of samples: computing the bitrate first and
            // then asking for the frame rate would have the bitrate update the
            // baseline out from under the frame rate, leaving it dividing by a
            // zero interval and reporting "—" forever.
            const rates = computeRates(outboundVideo);
            if (meterBitrate) meterBitrate.textContent = formatBitrate(rates.bitrate);
            if (meterFps) {
                meterFps.textContent = rates.fps === null ? '—' : String(Math.round(rates.fps));
            }

            if (outboundVideo.frameWidth && outboundVideo.frameHeight && meterResolution) {
                meterResolution.textContent = `${outboundVideo.frameWidth}×${outboundVideo.frameHeight}`;
            }
            if (meterCodec && outboundVideo.codecId) {
                meterCodec.textContent = describeCodecId(outboundVideo.codecId);
            }
            // keyFramesEncoded is cumulative; the counter is what the operator
            // watches to confirm the GOP interval is being honoured.
            if (meterKeyframes && typeof outboundVideo.keyFramesEncoded === 'number') {
                meterKeyframes.textContent = String(outboundVideo.keyFramesEncoded);
            }
        }

        // RTT from the nominated pair. currentRoundTripTime is in seconds; a
        // null simply means the pair has not completed a probe yet.
        if (candidatePair && meterRtt) {
            const rttSeconds = typeof candidatePair.currentRoundTripTime === 'number'
                ? candidatePair.currentRoundTripTime
                : null;
            meterRtt.textContent = rttSeconds === null ? '— ms' : `${Math.round(rttSeconds * 1000)} ms`;
        }
    }

    // Both rates need the delta between two samples: the counters are
    // cumulative since the session started, so a raw reading would show the
    // average over all elapsed time and settle rather than track the current
    // rate. They are computed together from ONE baseline and ONE update, so
    // neither can consume the other's previous sample.
    //
    // Returns fps: null on the very first sample (there is no interval yet) and
    // a real number from then on.
    function computeRates(stat) {
        const totalBytes = stat.bytesSent;
        const totalFrames = stat.framesSent || 0;
        const now = stat.timestamp;

        const previous = lastStats;
        lastStats = { bytes: totalBytes, timestamp: now, frames: totalFrames };

        if (typeof totalBytes !== 'number' || !previous) {
            return { bitrate: 0, fps: null };
        }

        // Two samples can carry the same timestamp (a stats call that returns
        // nothing new), and dividing by a zero interval is how a meter ends up
        // showing Infinity or NaN.
        const elapsed = (now - previous.timestamp) / 1000;
        if (!(elapsed > 0)) {
            return { bitrate: 0, fps: null };
        }

        return {
            bitrate: Math.max(0, ((totalBytes - previous.bytes) * 8) / elapsed),
            fps: Math.max(0, (totalFrames - previous.frames) / elapsed)
        };
    }

    // The codecId is an internal identifier. Anything unrecognised is shown
    // as-is rather than guessed at.
    function describeCodecId(codecId) {
        if (typeof codecId !== 'string') return '—';
        if (/H264|AVC/i.test(codecId)) return 'H.264';
        if (/AV1/i.test(codecId)) return 'AV1';
        if (/VP9/i.test(codecId)) return 'VP9';
        if (/VP8/i.test(codecId)) return 'VP8';
        if (/opus/i.test(codecId)) return 'Opus';
        return codecId;
    }

    // ==========================================================================
    // Microphone
    // ==========================================================================
    // Requested lazily, on the first broadcast attempt rather than on page
    // load: a permission prompt before the user has done anything reads as the
    // site being pushy, and on a page that is only sometimes used to broadcast
    // it is also simply wrong.
    //
    // The processing constraints are OFF by default. Echo cancellation and
    // noise suppression are tuned for a voice call in a quiet room; applied to
    // a broadcast mic next to the speakers playing that same audio, they pump
    // and gate the output. The OBS instructions on the watch page give the same
    // guidance for the same reason.

    async function requestMicrophone() {
        if (!micCheckbox || !micCheckbox.checked) {
            if (micStream) {
                micStream.getTracks().forEach((track) => track.stop());
                micStream = null;
            }
            return null;
        }
        if (micStream) return micStream;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;

        try {
            micStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 2,
                    sampleRate: 48000
                },
                video: false
            });
        } catch (err) {
            const name = (err && err.name) || '';
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                showToast('Microphone permission was denied. The stream will publish without a mic.', 'warning');
            } else if (name === 'NotFoundError') {
                showToast('No microphone was found. The stream will publish without audio.', 'warning');
            } else {
                showToast(`The microphone could not be opened: ${(err && err.message) || 'unknown error'}.`, 'warning');
            }
            if (micCheckbox) micCheckbox.checked = false;
            if (micGainRow) micGainRow.style.opacity = '0.45';
            micStream = null;
        }
        return micStream;
    }

    // ==========================================================================
    // UI wiring
    // ==========================================================================

    function updateSourceUi() {
        const present = hasSource();
        if (shell) shell.classList.toggle('has-source', present);
        if (!present) {
            if (preview) preview.srcObject = null;
            if (sourceInfo) sourceInfo.hidden = true;
            if (previewEmpty) previewEmpty.hidden = false;
        } else if (previewEmpty) {
            previewEmpty.hidden = true;
        }
    }

    function initModeSelector() {
        // Keeps the roving tabindex in the markup in sync with the checked
        // segment. A role="radiogroup" must be a single tab stop with arrow
        // keys moving within it; without this, clicking "Window" would leave
        // "Screen" as the only element with tabindex="0", so Tab would jump
        // back to the segment that is no longer selected.
        const syncRovingTabindex = () => {
            modeButtons.forEach((button) => {
                button.tabIndex = button.classList.contains('active') ? 0 : -1;
            });
        };

        // Returns true when the selection was actually applied. The arrow-key
        // handler below depends on this: while a broadcast is running
        // selectMode() bails out with a toast, and moving focus to a segment
        // that stayed unselected would leave the radiogroup's single tab stop
        // pointing at a different button than the focused one.
        const selectMode = (button) => {
            // Same reason as the pick-source button: switching mode
            // re-opens the picker, which tears down the current capture.
            if (isPublishing || isStarting) {
                showToast('Stop the broadcast before changing what is shared.', 'info');
                return false;
            }
            selectedMode = button.dataset.mode || 'monitor';
            modeButtons.forEach((other) => {
                const isActive = other === button;
                other.classList.toggle('active', isActive);
                other.setAttribute('aria-checked', String(isActive));
            });
            syncRovingTabindex();
            // Re-picking is the only way to change the surface, since
            // getDisplayMedia has no way to retarget an existing track.
            if (hasSource()) pickSource();
            return true;
        };

        modeButtons.forEach((button, index) => {
            button.addEventListener('click', () => selectMode(button));

            // Arrow keys, as the radiogroup pattern requires. Home/End jump to
            // the ends. Right/Down and Left/Up both work, because a horizontal
            // and a vertical arrow are both conventional for a segmented row
            // depending on how it is laid out.
            button.addEventListener('keydown', (event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                let next = null;
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    next = modeButtons[(index + 1) % modeButtons.length];
                } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    next = modeButtons[(index - 1 + modeButtons.length) % modeButtons.length];
                } else if (event.key === 'Home') {
                    next = modeButtons[0];
                } else if (event.key === 'End') {
                    next = modeButtons[modeButtons.length - 1];
                }
                if (!next) return;
                event.preventDefault();
                // Only follow focus when the change actually took, so focus
                // never lands on a segment that is still aria-checked=false.
                if (selectMode(next)) next.focus();
            });
        });

        syncRovingTabindex();
    }

    function initEncoderControls() {
        // The value label and the painted track move together, and the encoding
        // is applied live so the operator can find the ceiling of their uplink
        // by watching the meters rather than guessing.
        if (bitrateSlider) {
            paintSlider(bitrateSlider);
            bitrateSlider.addEventListener('input', () => {
                if (bitrateValue) bitrateValue.textContent = `${bitrateSlider.value} kbps`;
                paintSlider(bitrateSlider);
                applyVideoEncoding();
            });
        }

        if (framerateSelect) {
            framerateSelect.addEventListener('change', () => {
                applyVideoEncoding();
                // The capture track has its own frame rate, and the sender cap
                // alone would let the capture run hotter than the encode. `max`
                // is what actually caps it — see pickSource.
                if (hasSource()) {
                    const track = displayStream.getVideoTracks()[0];
                    const fps = Number(framerateSelect.value) || 30;
                    track.applyConstraints({ frameRate: { ideal: fps, max: fps } })
                        .then(() => reportAchievedFrameRate(track))
                        .catch((err) => console.warn('[Studio] Frame rate constraint rejected:', err));
                }
            });
        }

        if (resolutionSelect) {
            resolutionSelect.addEventListener('change', () => {
                applyResolution();
            });
        }

        if (contentHintSelect) {
            contentHintSelect.addEventListener('change', () => {
                // contentHint is a MediaStreamTrack attribute, so writing it is
                // legal at any time. Whether Chrome re-tunes an ALREADY-RUNNING
                // encoder from it is not something this code can promise, so the
                // message says "applies on the next broadcast" rather than
                // claiming a live re-tune it cannot verify.
                if (isPublishing) {
                    const track = displayStream && displayStream.getVideoTracks()[0];
                    if (track && 'contentHint' in track) track.contentHint = currentContentHint();
                    showToast('Content type applied to the running broadcast. If the encoder was already running, start a new broadcast to be certain it took effect.', 'info');
                    return;
                }
                if (hasSource()) {
                    const track = displayStream.getVideoTracks()[0];
                    if (track && 'contentHint' in track) track.contentHint = currentContentHint();
                }
            });
        }

        if (codecSelect) {
            codecSelect.addEventListener('change', () => {
                if (isPublishing) {
                    // The codec is baked into the offer, and MediaMTX accepts
                    // one video m-section, so switching means a new session.
                    showToast('Codec is fixed for a WHIP session. It applies on the next broadcast.', 'info');
                    codecSelect.value = 'h264';
                }
            });
        }

        if (audioBitrateSelect) {
            audioBitrateSelect.addEventListener('change', explainAudioBitrateChange);
        }

        if (cbrCheckbox) {
            cbrCheckbox.addEventListener('change', () => {
                // Re-applies the degradation preference on the live sender; the
                // bitrate ceiling itself is unchanged by the toggle.
                applyVideoEncoding();
            });
        }
    }

    function initAudioControls() {
        const bindGain = (slider, valueNode) => {
            if (!slider) return;
            paintSlider(slider);
            slider.addEventListener('input', () => {
                if (valueNode) valueNode.textContent = `${slider.value}%`;
                paintSlider(slider);
                applyGainValues();
            });
        };
        bindGain(micGain, micGainValue);
        bindGain(systemGain, systemGainValue);

        if (micCheckbox) {
            micCheckbox.addEventListener('change', () => {
                if (isPublishing) {
                    // Gain is live, but joining or leaving the graph would need
                    // a renegotiation, so the honest answer is to apply the
                    // level now and the source change on the next broadcast.
                    showToast('Mic source changes apply on the next broadcast; the level is live.', 'info');
                }
                applyGainValues();
            });
        }

        if (systemAudioCheckbox) {
            systemAudioCheckbox.addEventListener('change', () => {
                if (isPublishing) {
                    showToast('System audio changes apply on the next broadcast; the level is live.', 'info');
                }
                applyGainValues();
            });
        }
    }

    function initTransport() {
        if (pickSourceBtn) {
            pickSourceBtn.addEventListener('click', () => {
                // Re-picking tears the current capture down, and while live that
                // is the track the peer connection is publishing. Left
                // unguarded it kills the outgoing video mid-broadcast, orphans
                // the WHIP session (the PC keeps a dead track), and leaves a
                // Start button that looks enabled but is a no-op because
                // isPublishing is still true.
                //
                // isStarting matters just as much: the WHIP POST window is 25s
                // and the Start button is disabled throughout, so "Choose what
                // to share" is exactly what a user reaches for next. Re-picking
                // then ends both tracks the connection was already given, and
                // the studio goes on to report Live while sending nothing.
                if (isPublishing || isStarting) {
                    showToast('Stop the broadcast before choosing a different source.', 'warning');
                    return;
                }
                pickSource();
            });
        }

        if (startBtn) {
            startBtn.addEventListener('click', async () => {
                // The guard has to cover the await below, not just the click.
                // requestMicrophone() shows a permission prompt and resolves
                // asynchronously, and isPublishing is still false for that
                // whole window, so a second click would start a SECOND
                // broadcast: two peer connections, two WHIP sessions, and only
                // one of them ever torn down.
                if (isPublishing || isStarting) return;
                isStarting = true;
                // The button is disabled for the duration so the state is
                // visible, not just guarded.
                if (startBtn) startBtn.disabled = true;
                try {
                    // The mic prompt belongs to the moment the user commits,
                    // not to page load, so it is requested here.
                    await requestMicrophone();
                    if (isPublishing) return;
                    await startPublishing();
                } finally {
                    isStarting = false;
                }
            });
        }

        if (stopBtn) {
            stopBtn.addEventListener('click', async () => {
                await teardown();
                setStatus('idle', 'Stopped');
                setTransport(hasSource(), 'Stopped. Press start to broadcast again.');
                showToast('Broadcast stopped.', 'info');
            });
        }

        if (toastClose) {
            toastClose.addEventListener('click', () => {
                if (toast) toast.hidden = true;
            });
        }
    }
    // ==========================================================================
    // Unload and visibility
    // ==========================================================================
    // Leaving the page with a live WHIP session would leave MediaMTX holding a
    // publisher that sends into a receiver nobody reads, burning upload until
    // it times out. `pagehide` is used rather than `beforeunload` because it is
    // the one that actually fires on mobile and on bfcache navigations.

    // Releasing the MediaMTX session is split out so the unload path and the
    // ordinary teardown share it. Nulling the URL BEFORE issuing the DELETE is
    // what makes it idempotent: pagehide can fire more than once (bfcache
    // navigations in particular), and a second DELETE to an already-freed
    // session is a 404 that would mask a real failure.
    function releaseWhipSessionSync() {
        if (!whipSessionUrl) return;
        const sessionUrl = whipSessionUrl;
        whipSessionUrl = null;
        // fetch returns a promise, so a try/catch around the CALL cannot catch
        // a failed request — only a synchronous throw. The rejection has to be
        // handled on the promise or it surfaces as an unhandled rejection,
        // which is the opposite of what this comment claims.
        fetch(sessionUrl, { method: 'DELETE', keepalive: true })
            .catch(() => { /* the connection dropping frees the path anyway */ });
    }

    window.addEventListener('pagehide', () => {
        // Synchronous and best-effort: an await here would not complete during
        // unload, so the DELETE and the PC close are both fired without waiting.
        // The local state is reset as well, not just the network session: the
        // page can be restored from the bfcache (which fires pagehide and then
        // pageshow on the SAME document), and coming back with isPublishing
        // still true and the stats timer still running would leave the UI
        // claiming a broadcast that no longer exists.
        releaseWhipSessionSync();
        stopStatsLoop();
        stopLevelMeter();
        isPublishing = false;
        isStarting = false;
        videoSender = null;
        lastStats = null;
        teardownCapture();
        if (peerConnection) {
            try { peerConnection.close(); } catch (err) { /* already closed */ }
            peerConnection = null;
        }
    });

    // Restoring from the bfcache re-runs scripts without reloading the page, so
    // the studio arrives here with a dead peer connection and no session. It
    // has to reconcile rather than assume the state it left behind is real.
    window.addEventListener('pageshow', () => {
        if (isPublishing) return;
        setStatus('idle', 'Ready');
        setTransport(hasSource(), hasSource()
            ? 'Ready. Press start to broadcast again.'
            : 'Choose a source to unlock broadcasting.');
    });

    // A backgrounded tab is a weak signal that the broadcaster has stepped away.
    // Nothing is torn down here — a browser can be backgrounded by accident, and
    // killing a live broadcast over it would be worse than the waste.
    document.addEventListener('visibilitychange', () => {
        if (!isPublishing) return;
        if (document.hidden) {
            console.log('[Studio] Tab backgrounded; the broadcast continues.');
        } else {
            // Coming back is the right moment to confirm the session is still
            // real rather than assuming it.
            updateStats();
        }
    });

    // ==========================================================================
    // Initialisation
    // ==========================================================================

    function init() {
        initModeSelector();
        initEncoderControls();
        initAudioControls();
        initTransport();

        // Prime the painted slider tracks and labels so the page does not render
        // with empty sliders for its first frame.
        if (bitrateValue && bitrateSlider) bitrateValue.textContent = `${bitrateSlider.value} kbps`;
        if (micGainValue && micGain) micGainValue.textContent = `${micGain.value}%`;
        if (systemGainValue && systemGain) systemGainValue.textContent = `${systemGain.value}%`;
        resetMeters();

        // Warn if the browser cannot do this at all, before the user configures
        // everything and only then discovers it. There is no getDisplayMedia on
        // any mobile platform, so this also covers "opened this on a phone".
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            setStatus('error', 'Unsupported');
            if (pickSourceBtn) pickSourceBtn.disabled = true;
            setTransport(false, 'This browser cannot capture a screen. Use Chrome, Edge or another Chromium browser on a computer.');
            showToast('Screen capture is not available in this browser. Use Chrome, Edge or another Chromium browser on a computer.', 'error');
            return;
        }

        if (window.RTCPeerConnection === undefined) {
            setStatus('error', 'Unsupported');
            if (pickSourceBtn) pickSourceBtn.disabled = true;
            showToast('WebRTC is not available in this browser.', 'error');
            return;
        }

        setStatus('idle', 'Ready');
        setTransport(false, 'Choose a source to unlock broadcasting.');

        // Advisory only: it only changes the note under the start button, so a
        // failure here must not block the page from being used.
        isAlreadyPublishing().then((already) => {
            if (already && !isPublishing) {
                setTransport(false, 'Another publisher is live. Choose a source to take over.');
            }
        });
    }

    init();
});
