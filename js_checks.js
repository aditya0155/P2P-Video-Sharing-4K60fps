'use strict';

/*
 * Unit checks for the browser-only logic inside app.js.
 *
 * app.js is written as one big DOMContentLoaded callback and never exports
 * anything, so the pure functions under test are extracted from the source by
 * name (brace/string aware) and evaluated in a `vm` context that carries stub
 * globals. That way the tests always exercise the real shipped code instead of
 * a copy that could silently drift.
 *
 * Usage:  node js_checks.js <case>   |   node js_checks.js --list
 * Driven by run_tests.py, which reports one unittest case per check here.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

/* --------------------------------------------------------------------------
   Assertion helpers
   -------------------------------------------------------------------------- */

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
    const same = actual === expected
        || (typeof actual === 'object' && typeof expected === 'object' && actual !== null && expected !== null
            && JSON.stringify(actual) === JSON.stringify(expected));
    if (!same) {
        throw new Error(`${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
}

// Counts whole lines so that `a=rtcp-fb:96 nack` is not confused with
// `a=rtcp-fb:96 nack pli` when checking for duplicates.
function countLine(lines, line, expected, label) {
    const count = lines.filter((entry) => entry === line).length;
    if (count !== expected) {
        throw new Error(`${label}: expected ${expected} occurrence(s) of line ${JSON.stringify(line)}, found ${count}`);
    }
}

/* --------------------------------------------------------------------------
   Source extraction (string / template / comment aware)
   -------------------------------------------------------------------------- */

function skipString(src, i) {
    const quote = src[i];
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === '\\') {
            j += 2;
            continue;
        }
        if (quote === '`' && c === '$' && src[j + 1] === '{') {
            j = matchingBrace(src, j + 1) + 1;
            continue;
        }
        if (c === quote) return j + 1;
        j++;
    }
    throw new Error(`unterminated ${quote === '`' ? 'template' : 'string'} literal at index ${i}`);
}

function skipComment(src, i) {
    if (src[i + 1] === '/') {
        const nl = src.indexOf('\n', i);
        return nl === -1 ? src.length : nl;
    }
    if (src[i + 1] === '*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) throw new Error('unterminated block comment');
        return end + 2;
    }
    return -1;
}

function matchingBrace(src, openIndex) {
    if (src[openIndex] !== '{') throw new Error(`expected "{" at index ${openIndex}`);
    let depth = 0;
    let i = openIndex;
    while (i < src.length) {
        const c = src[i];
        if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
            const next = skipComment(src, i);
            if (next !== -1) { i = next; continue; }
        }
        if (c === '"' || c === "'" || c === '`') {
            i = skipString(src, i);
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
        i++;
    }
    throw new Error(`unbalanced braces starting at index ${openIndex}`);
}

function extractFunction(name, source = APP_SOURCE) {
    const header = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
    const match = header.exec(source);
    if (!match) throw new Error(`function ${name}() was not found in app.js`);

    // Walk past the parameter list.
    let i = match.index + match[0].length - 1;
    let depth = 0;
    while (i < source.length) {
        const c = source[i];
        if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); continue; }
        if (c === '(') depth++;
        else if (c === ')') {
            depth--;
            if (depth === 0) { i++; break; }
        }
        i++;
    }
    while (i < source.length && /\s/.test(source[i])) i++;
    if (source[i] !== '{') throw new Error(`${name}(): function body does not start with "{"`);

    const end = matchingBrace(source, i);
    return source.slice(match.index, end + 1);
}

function extractConst(name, source = APP_SOURCE) {
    const header = new RegExp(`const\\s+${name}\\s*=\\s*`);
    const match = header.exec(source);
    if (!match) throw new Error(`const ${name} was not found in app.js`);

    const start = match.index + match[0].length;
    let depth = 0;
    let i = start;
    while (i < source.length) {
        const c = source[i];
        if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
            const next = skipComment(source, i);
            if (next !== -1) { i = next; continue; }
        }
        if (c === '"' || c === "'" || c === '`') { i = skipString(source, i); continue; }
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ';' && depth === 0) break;
        i++;
    }
    return source.slice(start, i).trim();
}

function evaluateConst(name) {
    return vm.runInNewContext(`(${extractConst(name)})`, {}, { filename: `app.js#${name}` });
}

function compileFunction(name, sandbox) {
    const source = extractFunction(name);
    const context = vm.createContext(sandbox, { name: `app.js#${name}` });
    const fn = vm.runInContext(`(${source})`, context, { filename: `app.js#${name}` });
    if (typeof fn !== 'function') throw new Error(`${name} did not evaluate to a function`);
    return { fn, sandbox: context };
}

function quietConsole() {
    return { log() {}, warn() {}, error() {}, info() {} };
}

module.exports = { APP_SOURCE, assert, assertEqual, countLine, extractFunction, extractConst, evaluateConst, compileFunction, quietConsole };

/* --------------------------------------------------------------------------
   Shared fixtures
   -------------------------------------------------------------------------- */

// Realistic recvonly browser offer: CRLF line endings, stale bandwidth lines,
// a H264 pair (one already carrying feedback), an H264 pair with none, and an
// audio section that must never be touched.
const SAMPLE_SDP = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0 1',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97',
    'c=IN IP4 0.0.0.0',
    'b=AS:300000',
    'b=TIAS:300000000',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:password',
    'a=fingerprint:sha-256 AA:BB:CC',
    'a=setup:actpass',
    'a=mid:0',
    'a=recvonly',
    'a=rtcp-fb:96 nack',
    'a=rtcp-fb:96 transport-cc',
    'a=rtpmap:96 H264/90000',
    'a=fmtp:96 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
    'a=rtpmap:97 H264/90000',
    'a=fmtp:97 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640034',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'c=IN IP4 0.0.0.0',
    'a=rtcp:9 IN IP4 0.0.0.0',
    'a=mid:1',
    'a=recvonly',
    'a=rtpmap:111 opus/48000/2',
    'a=rtcp-fb:111 transport-cc',
    ''
].join('\r\n');

function compileOptimizeSdp() {
    const { fn } = compileFunction('optimizeSdp', { console: quietConsole() });
    return fn;
}

function sectionOf(lines, startMarker, endMarker) {
    const start = lines.findIndex((line) => line.startsWith(startMarker));
    const end = lines.findIndex((line) => line.startsWith(endMarker));
    assert(start !== -1, `sample SDP is missing ${startMarker}`);
    assert(end > start, `sample SDP is missing ${endMarker} after ${startMarker}`);
    return { start, end, lines: lines.slice(start, end) };
}

/* --------------------------------------------------------------------------
   Cases
   -------------------------------------------------------------------------- */

const cases = {
    // SDP munging is the single most fragile transform in the player: a line in
    // the wrong media section is accepted by the browser but silently ignored
    // by the answerer, which shows up as "connects but streams at a trickle".
    'sdp-bandwidth-ceiling'() {
        const optimizeSdp = compileOptimizeSdp();
        const out = optimizeSdp(SAMPLE_SDP);
        const lines = out.split('\r\n');
        const video = sectionOf(lines, 'm=video', 'm=audio');

        assertEqual(video.lines[1], 'b=AS:60000', 'b=AS:60000 must be the line directly after m=video');
        countLine(lines, 'b=AS:60000', 1, 'exactly one bandwidth line must survive');
        assert(!lines.some((line) => line.startsWith('b=AS:') && line !== 'b=AS:60000'),
            'stale b=AS lines must be stripped');
        assert(!lines.some((line) => line.startsWith('b=TIAS:')), 'stale b=TIAS must be stripped');
        assert(out.includes('a=ice-ufrag:abcd') && out.includes('profile-level-id=640034'),
            'session and fmtp lines must be preserved');
    },

    'sdp-feedback-scoped-to-video'() {
        const optimizeSdp = compileOptimizeSdp();
        const out = optimizeSdp(SAMPLE_SDP);
        const lines = out.split('\r\n');
        const video = sectionOf(lines, 'm=video', 'm=audio');
        const audio = lines.slice(lines.findIndex((l) => l.startsWith('m=audio')));

        for (const payloadType of ['96', '97']) {
            for (const feedback of ['nack', 'nack pli', 'goog-remb', 'transport-cc']) {
                countLine(video.lines, `a=rtcp-fb:${payloadType} ${feedback}`, 1,
                    `video section must hold exactly one feedback line for payload type ${payloadType}`);
            }
        }
        for (const payloadType of ['96', '97']) {
            const rtpmapIndex = video.lines.indexOf(`a=rtpmap:${payloadType} H264/90000`);
            assert(rtpmapIndex !== -1, `missing a=rtpmap:${payloadType}`);
            for (const feedback of ['nack pli', 'goog-remb']) {
                const line = `a=rtcp-fb:${payloadType} ${feedback}`;
                const index = video.lines.indexOf(line);
                assert(index > rtpmapIndex, `${line} must be injected after its rtpmap line, not appended elsewhere`);
            }
        }

        countLine(audio, 'a=rtcp-fb:111 transport-cc', 1, 'audio feedback line must not be duplicated');
        assert(!audio.some((l) => l.startsWith('b=AS:')), 'b=AS leaked into the audio section');
        assert(!audio.join('\r\n').includes('a=rtcp-fb:111 nack'), 'audio section must not gain video feedback');
        assert(!audio.join('\r\n').includes('goog-remb'), 'goog-remb must never land in the audio section');
    },

    'sdp-idempotent-and-audio-only-safe'() {
        const optimizeSdp = compileOptimizeSdp();
        const once = optimizeSdp(SAMPLE_SDP);
        assertEqual(optimizeSdp(once), once, 'optimizeSdp must be idempotent (offers can be re-munged)');

        const audioOnly = [
            'v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', ''
        ].join('\r\n');
        assertEqual(optimizeSdp(audioOnly), audioOnly, 'audio-only SDP must come back untouched');

        const vp9Only = [
            'v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 98', 'b=AS:1000', 'a=rtpmap:98 VP9/90000', ''
        ].join('\r\n');
        const vp9Out = optimizeSdp(vp9Only);
        assert(vp9Out.includes('b=AS:60000'), 'video bandwidth ceiling must still be applied to non-H264 video');
        // Every true video payload type needs NACK/PLI/transport-cc feedback:
        // a lost packet on a VP9/AV1 stream must be recoverable exactly like
        // on H264, or the decoder discards frames until the next keyframe.
        for (const feedback of ['nack', 'nack pli', 'goog-remb', 'transport-cc']) {
            countLine(vp9Out.split('\r\n'), `a=rtcp-fb:98 ${feedback}`, 1,
                `video feedback must reach non-H264 payload types (${feedback})`);
        }
        assertEqual(optimizeSdp(vp9Out), vp9Out, 'VP9 feedback injection must also be idempotent');

        // Retransmission-request containers are not media formats: rtx/red/
        // ulpfec payload types ride the 90000 clock but must not gain
        // rtcp-fb lines (the muxed feedback belongs to the media PT only).
        const rtxSdp = [
            'v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=rtpmap:96 H264/90000',
            'a=rtpmap:97 rtx/90000', ''
        ].join('\r\n');
        const rtxOut = optimizeSdp(rtxSdp);
        assert(!rtxOut.includes('a=rtcp-fb:97'), 'rtx payload types must not receive feedback lines');
        countLine(rtxOut.split('\r\n'), 'a=rtcp-fb:96 nack', 1,
            'the media payload type still gets its feedback');
    },
};

/* --------------------------------------------------------------------------
   Stream polling / reconnect state machine
   -------------------------------------------------------------------------- */

function makePollSandbox(options = {}) {
    const calls = { fetch: [], ui: [], connect: 0, schedule: 0, json: 0, messages: [] };
    const replies = (options.replies || []).slice();
    const sandbox = {
        isConnected: Boolean(options.isConnected),
        isConnecting: Boolean(options.isConnecting),
        reconnectAttempts: options.reconnectAttempts ?? 0,
        renditionWaitPolls: 0,
        renditionWaitWarned: false,
        window: { location: { origin: 'http://127.0.0.1:3000' } },
        console: quietConsole(),
        updateUIState(state) { calls.ui.push(state); },
        schedulePoll() { calls.schedule++; },
        connectStream() { calls.connect++; },
        addSystemMessage(text) { calls.messages.push(text); },
        async fetch(url, init) {
            calls.fetch.push({ url, init: init || {} });
            const next = replies.shift();
            if (next instanceof Error) throw next;
            if (!next) throw new Error('fetch called more times than the scenario provides');
            return {
                status: next.status,
                ok: next.ok,
                async json() {
                    calls.json++;
                    if (next.payload instanceof Error) throw next.payload;
                    return next.payload;
                }
            };
        }
    };
    // Real path-selection helpers, extracted from app.js like every other case.
    // browserSupportsAv1/browserSupportsH265 get an RTCRtpReceiver stub only
    // when the scenario models a capable viewer; without it, the typeof-guard
    // returns false (the browser-support default).
    sandbox.chooseStreamPath = compileFunction('chooseStreamPath', { console: quietConsole() }).fn;
    const rtcSandbox = { console: quietConsole() };
    const rtcCodecs = [];
    if (options.av1Capable) rtcCodecs.push({ mimeType: 'video/AV1' });
    if (options.h265Capable) rtcCodecs.push({ mimeType: 'video/H265' });
    if (rtcCodecs.length) {
        rtcSandbox.RTCRtpReceiver = {
            getCapabilities: () => ({ codecs: rtcCodecs })
        };
    }
    sandbox.browserSupportsAv1 = compileFunction('browserSupportsAv1', rtcSandbox).fn;
    sandbox.browserSupportsH265 = compileFunction('browserSupportsH265', rtcSandbox).fn;
    // The Media Capabilities probe runs on the real navigator in a browser;
    // scenarios pin the outcome (null keeps the capability-list behavior).
    sandbox.probeAv1DecodeSmooth = async () => (options.av1Smooth === undefined ? null : options.av1Smooth);
    const { fn, sandbox: context } = compileFunction('pollStreamStatus', sandbox);
    return { run: () => fn(), calls, context };
}

Object.assign(cases, {
    // The player decides "is the host live?" from the MediaMTX paths API: a
    // ready publisher starts WebRTC, anything else paints offline and keeps
    // probing. Getting this wrong means a connect loop against a dead stream.
    'poll-connects-when-publisher-ready'() {
        const { run, calls } = makePollSandbox({
            replies: [{ status: 200, ok: true, payload: { items: [{ name: 'live', ready: true, online: true }] } }]
        });
        return run().then(() => {
            assertEqual(calls.fetch.length, 1, 'exactly one probe request');
            assertEqual(calls.fetch[0].url, 'http://127.0.0.1:3000/stream-api/v3/paths/list', 'probe URL');
            assertEqual(calls.fetch[0].init.cache, 'no-store', 'the probe must bypass the HTTP cache');
            assertEqual(calls.connect, 1, 'a ready publisher must start exactly one connection attempt');
            assertEqual(calls.ui, [], 'a live answer must not paint an offline state');
            assertEqual(calls.schedule, 0, 'no extra poll may be scheduled while connecting');
        });
    },

    'poll-offline-when-publisher-missing'() {
        const scenarios = [
            { label: 'path present but not ready', payload: { items: [{ name: 'live', ready: false, online: false }] } },
            { label: 'path absent entirely', payload: { items: [{ name: 'other', ready: true }] } },
            { label: 'empty path list', payload: { items: [] } },
            { label: 'unexpected payload shape', payload: {} }
        ];
        return scenarios.reduce((chain, scenario) => chain.then(() => {
            const { run, calls } = makePollSandbox({ replies: [{ status: 200, ok: true, payload: scenario.payload }] });
            return run().then(() => {
                assertEqual(calls.connect, 0, `${scenario.label}: must not start WebRTC`);
                assertEqual(calls.ui, ['offline'], `${scenario.label}: must show offline`);
                assertEqual(calls.schedule, 1, `${scenario.label}: must schedule the next probe`);
            });
        }), Promise.resolve());
    },

    'poll-offline-when-mediamtx-unreachable'() {
        const entries = [
            { label: 'proxy 502 (MediaMTX down)', reply: { status: 502, ok: false, payload: new Error('no body parsed') } },
            { label: 'network error', reply: new Error('connection refused') }
        ];
        return entries.reduce((chain, entry) => chain.then(() => {
            const { run, calls } = makePollSandbox({ replies: [entry.reply] });
            return run().then(() => {
                assertEqual(calls.connect, 0, `${entry.label}: must not start WebRTC`);
                assertEqual(calls.ui, ['offline'], `${entry.label}: must show offline`);
                assertEqual(calls.schedule, 1, `${entry.label}: must keep the poll loop alive`);
                assertEqual(calls.json, 0, `${entry.label}: must not try to parse an error body`);
            });
        }), Promise.resolve());
    },

    'poll-skipped-while-connected-or-connecting'() {
        const connected = makePollSandbox({ isConnected: true });
        const connecting = makePollSandbox({ isConnecting: true });
        return Promise.all([connected.run(), connecting.run()]).then(() => {
            assertEqual(connected.calls.fetch.length, 0, 'probe must be skipped while connected');
            assertEqual(connecting.calls.fetch.length, 0, 'probe must be skipped while connecting');
            assertEqual(connected.calls.connect + connecting.calls.connect, 0, 'no connect while already active');
            assertEqual(connected.calls.schedule + connecting.calls.schedule, 0, 'no extra polls while already active');
        });
    },

    // Backoff after a mid-stream drop: 1s, 2s, 4s then capped at the 5s poll
    // interval, and reset to 1s once the stream ends for real or recovers.
    'poll-backoff-grows-and-caps'() {
        const delays = [];
        const sandbox = {
            streamActiveCheckTimeout: null,
            reconnectAttempts: 0,
            POLL_INTERVAL_MS: evaluateConst('POLL_INTERVAL_MS'),
            pollStreamStatus() {},
            clearTimeout() {},
            setTimeout(callback, delay) { delays.push(delay); return delays.length; },
            console: quietConsole()
        };
        const { fn, sandbox: context } = compileFunction('schedulePoll', sandbox);
        for (let i = 0; i < 5; i++) fn();

        assertEqual(sandbox.POLL_INTERVAL_MS, 5000, 'poll interval constant');
        assertEqual(delays, [1000, 2000, 4000, 5000, 5000],
            'backoff must grow 1s/2s/4s and cap at the poll interval');
        assertEqual(context.reconnectAttempts, 3, 'backoff exponent must stop growing at 3');

        context.reconnectAttempts = 0;
        fn();
        assertEqual(delays[5], 1000, 'a reset counter must restart the fast 1s retry');
    },

    // After an unexpected drop the viewer must be re-probed, the UI must go
    // offline, and a drop seconds after connecting must warn about encoder
    // settings instead of failing silently.
    'disconnect-schedules-reconnect'() {
        const scenario = (isConnected, connectionStartTime) => {
            const calls = { cleared: [], ui: [], messages: [], order: [] };
            const sandbox = {
                connectTimeout: 42,
                disconnectGraceTimer: null,
                connectionStartTime,
                isConnected,
                performance: { now: () => 1000 },
                clearTimeout(id) { calls.cleared.push(id); },
                console: quietConsole(),
                addSystemMessage(text) { calls.messages.push(text); calls.order.push('message'); },
                stopFreezeWatchdog() { calls.order.push('stopFreezeWatchdog'); },
                cleanupConnection() { calls.order.push('cleanupConnection'); },
                updateUIState(state) { calls.ui.push(state); calls.order.push(`ui:${state}`); },
                stopTelemetry() { calls.order.push('stopTelemetry'); },
                stopAudioMeter() { calls.order.push('stopAudioMeter'); },
                schedulePoll() { calls.order.push('schedulePoll'); }
            };
            const { fn, sandbox: context } = compileFunction('handleDisconnected', sandbox);
            fn();
            return { calls, context };
        };

        const recent = scenario(true, 0);
        assertEqual(recent.context.connectTimeout, null, 'connection watchdog must be cleared');
        assertEqual(recent.context.isConnected, false, 'session flag must be cleared');
        assertEqual(recent.calls.ui, ['offline'], 'disconnection must paint the offline state');
        assert(recent.calls.order.includes('schedulePoll'), 'disconnection must schedule a fresh poll');
        assertEqual(recent.calls.cleared, [42], 'the 12s connect watchdog must be cancelled');
        assert(recent.calls.messages.some((m) => m.includes('H.264')),
            'a drop right after connecting must suggest H.264/B-frame settings');
        assert(recent.calls.order.indexOf('cleanupConnection') < recent.calls.order.indexOf('ui:offline'),
            'connection cleanup must run before the UI flips offline');

        const longRunning = scenario(true, -60000);
        assert(!longRunning.calls.messages.some((m) => m.includes('H.264')),
            'a drop after a healthy session must not push codec advice');
        assert(longRunning.calls.order.includes('schedulePoll'), 'long sessions must still be re-probed');
    },
});

/* --------------------------------------------------------------------------
   AV1 / rendition path selection
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // codec_bridge.js decides the GPU rendition direction from the source
    // track list. Wrong direction = publishing a duplicate codec and leaving
    // the other half of the browser fleet with nothing playable.
    'codec-bridge-direction-matrix'() {
        const bridge = require('./codec_bridge.js');

        const av1Plan = bridge.decideBridge(['Opus', 'AV1']);
        assert(av1Plan, 'AV1 source must produce a plan');
        assertEqual(av1Plan.target, 'live-h264', 'AV1 source falls back to H264');
        assert(av1Plan.videoArgs.includes('h264_nvenc'), 'fallback must use the GPU H264 encoder');
        assertEqual(av1Plan.audioArgs, ['-c:a', 'copy'],
            'Opus source audio must be copied, not re-encoded');

        const h264Plan = bridge.decideBridge(['H264', 'Opus']);
        assertEqual(h264Plan.target, 'live-av1', 'H264 source gets the AV1 rendition');
        assert(h264Plan.videoArgs.includes('av1_nvenc'), 'rendition must use the GPU AV1 encoder');
        assert(h264Plan.videoArgs.includes('-bf'), 'WebRTC-safe streams declare a B-frame policy');
        assertEqual(h264Plan.videoArgs[h264Plan.videoArgs.indexOf('-bf') + 1], '0',
            'B-frames break WebRTC decoders (README rule)');

        const aacPlan = bridge.decideBridge(['MPEG-4 Audio', 'H264']);
        const aacArgs = aacPlan.audioArgs.join(' ');
        assertEqual(aacPlan.audioArgs.slice(0, 4), ['-c:a', 'libopus', '-b:a', '160k'],
            'AAC source audio must be re-encoded to Opus for WebRTC readers');
        // WebRTC's Opus clock is 48000Hz by definition (RFC 7587), so the
        // encoder must be pinned to it rather than left to resample a 44.1kHz
        // source — which is exactly what YouTube's own stereo guidance
        // recommends, so this is the common case, not an edge case. `-ac 2`
        // matches the stereo layout WebRTC negotiates.
        assert(aacArgs.includes('-ar 48000'),
            'the Opus rescue must be pinned to the 48kHz WebRTC clock');
        assertEqual(aacPlan.audioArgs[aacPlan.audioArgs.indexOf('-ar') + 1], '48000',
            'the Opus sample rate must be exactly 48000');
        assert(aacArgs.includes('-ac 2'), 'the Opus rescue must match WebRTC stereo');
        // The default `audio` application permits encoder lookahead — audio
        // latency the video path deliberately refuses to accept. `lowdelay`
        // plus a 20ms frame is the WebRTC convention and bounds the jitter
        // buffer's granularity.
        assert(aacArgs.includes('-application lowdelay'),
            'live audio must not pay the default application lookahead');
        assertEqual(aacPlan.audioArgs[aacPlan.audioArgs.indexOf('-frame_duration') + 1], '20',
            'the Opus frame size must match the 20ms WebRTC convention');
        // Drift correction on the rescue audio: without it a source clock that
        // runs slightly fast makes Opus timestamps walk ahead of video, and the
        // browser's A/V sync layer then nudges playbackRate forever — a
        // permanent micro-correction that reads as jank rather than desync.
        assert(aacArgs.includes('aresample=async=1'),
            'the Opus rescue must resample asynchronously to stop A/V timestamp drift');
        // ... but it must NOT re-base the audio onto the video head. Measured
        // with the bundled ffmpeg on a source whose audio starts 279ms after its
        // video (an ordinary OBS audio-device offset):
        //     async=1:first_pts=0  -> output skew  -7ms  (offset destroyed, sign flipped)
        //     async=1              -> output skew +294ms  (offset preserved)
        // Forcing the first sample to PTS 0 drags the audio track onto the video
        // track's first packet, so every rendition gets a permanent lip-sync
        // error equal to the source's own A/V offset — which viewers report as
        // the video being "janky" when it is purely an audio offset.
        assert(!aacArgs.includes('first_pts'),
            'the Opus rescue must not re-base audio with first_pts: it destroys the source A/V offset');

        // Both encoder blocks must be bitrate-honest and frame-honest.
        for (const [label, plan] of [['h264', av1Plan], ['av1', h264Plan]]) {
            const args = plan.videoArgs;
            const j = (flag) => args[args.indexOf(flag) + 1];
            // Adaptive quantization is OFF by default in ffmpeg's NVENC wrapper
            // (verified: `-spatial_aq <boolean> ... (default false)`), so without
            // this the encoder spreads bits uniformly instead of by regional
            // complexity. Measured A/B on the bundled encoder (1080p60, 6000k,
            // 12s, -g 30): total +0.15%, average 6.01->6.02 Mbps, 100ms peak
            // 8.96->8.64 Mbps. Bitrate-neutral, and the peak it lowers is what
            // overflows MediaMTX's per-reader write queue on keyframes.
            assertEqual(j('-spatial-aq'), '1', `${label}: spatial AQ must be enabled`);
            assertEqual(j('-aq-strength'), '8', `${label}: AQ strength must be explicit`);
            // ffmpeg's default -fps_mode is 'auto', which may duplicate or drop
            // frames to hold a constant rate. On a live transcode of a live
            // source that manufactures frame-count discontinuities — exactly the
            // hitch this project exists to prevent.
            assertEqual(j('-fps_mode'), 'passthrough',
                `${label}: one output frame per input frame`);
            // -g counts FRAMES, so the designed 0.5s interval must come from
            // the probe, not from a hard-coded count. '60' was 1.0s at 60fps
            // and 2.5s at 24fps — double to five times the intent, silently.
            assert(args.includes('-g'), `${label}: a keyframe interval must be declared`);
            // The GOP must be the probed frame count, or the 0.5s designed
            // interval derived from it. A bare `!args.includes('60')` guard was
            // useless here: `includes` is an exact element match and the array
            // holds '6000k', so the check was always true and short-circuited the
            // half of the || that does the real work.
            assertEqual(args[args.indexOf('-g') + 1], '30',
                `${label}: GOP fallback must be the 0.5s designed interval, not a hard-coded 60`);
        }

        assertEqual(bridge.decideBridge(['Opus']), null, 'audio-only source must not bridge');
        assertEqual(bridge.decideBridge(null), null, 'missing tracks must not bridge');
        assertEqual(bridge.decideBridge('nope'), null, 'non-array input must not bridge');

        const av1Args = bridge.buildFfmpegArgs(av1Plan);
        const line = av1Args.join(' ');
        assert(line.includes('rtsp://127.0.0.1:8554/live'),
            'source must be read over loopback RTSP (RTMP cannot serve AV1)');
        assert(line.includes('rtmp://127.0.0.1:1935/live-h264'),
            'rendition must publish to the live-h264 path over RTMP');
        assert(line.includes('-map 0:a:0?') || av1Args.includes('0:a:0?'),
            'audio mapping must tolerate a missing audio track');

        // Receiver-lag pipeline: the rendition must read its source over TCP
        // (UDP loopback loss adds delay), encode with NVENC ultra-low-latency
        // tune, and force IDR keyframes every second so new viewers and PLI
        // recovery lock on fast.
        const inputIdx = av1Args.indexOf('-i');
        const rtspIdx = av1Args.indexOf('-rtsp_transport');
        assert(rtspIdx !== -1 && rtspIdx < inputIdx && av1Args[rtspIdx + 1] === 'tcp',
            '-rtsp_transport tcp must be set before -i (UDP loopback loss adds delay)');
        assert(!line.includes('nobuffer') && !line.includes('low_delay'),
            'nobuffer/low_delay input flags are live-verified to break RTSP joins — stay out');
        assert(av1Plan.videoArgs.join(' ').includes('-tune ull'),
            'NVENC must run ultra-low-latency tune (no lookahead)');
        const gIdx = av1Plan.videoArgs.indexOf('-g');
        // The designed interval is DEFAULT_GOP_SECONDS = 0.5s, so at the
        // assumed 60fps that is 30 frames. This assertion used to pin '60',
        // which is 1.0s at 60fps — the `env.gopFrames || '60'` fallback
        // silently contradicting the constant two lines above it in the same
        // file. 1.0s keyframes double the worst-case freeze after a lost
        // keyframe, which is the single largest lever on perceived stutter.
        assertEqual(av1Plan.videoArgs[gIdx + 1], '30',
            '0.5s keyframe interval at 60fps, matching DEFAULT_GOP_SECONDS');
        // ... and an explicit env.gopFrames must still win, so the probe result
        // is never overridden by the fallback.
        const probed = bridge.decideBridge(['AV1', 'Opus'], { gopFrames: '12' });
        assertEqual(probed.videoArgs[probed.videoArgs.indexOf('-g') + 1], '12',
            'a probed frame rate must override the assumed-rate fallback');
        assert(av1Plan.videoArgs.join(' ').includes('-forced-idr 1'),
            'keyframes must be forced as IDR frames for fast decoder lock-on');

        // Burst cap: bare -b:v measured 2.4x-target 100ms peaks (bundled
        // ffmpeg, testsrc2); -maxrate and -bufsize must both sit at the
        // target so keyframes cannot overflow MediaMTX's per-reader queue.
        const rate = av1Plan.videoArgs[av1Plan.videoArgs.indexOf('-b:v') + 1];
        assertEqual(av1Plan.videoArgs[av1Plan.videoArgs.indexOf('-maxrate') + 1], rate,
            '-maxrate must cap the encoder at its target bitrate');
        assertEqual(av1Plan.videoArgs[av1Plan.videoArgs.indexOf('-bufsize') + 1], rate,
            '-bufsize must pin the VBV window to the target bitrate');
        const gop30 = bridge.decideBridge(['Opus', 'AV1'], { gopFrames: '30' });
        assertEqual(gop30.videoArgs[gop30.videoArgs.indexOf('-g') + 1], '30',
            'gopFrames must flow into -g (1s keyframes at a 30fps source)');

        // GPU (NVDEC) decode selection keeps the CPU free for OBS capture.
        const gpuArgs = bridge.buildFfmpegArgs(h264Plan, {}, bridge.pickDecoderArgs('H264', {
            gpuDecoders: ['h264_cuvid', 'av1_cuvid']
        }));
        const gpuDecoderIdx = gpuArgs.indexOf('-c:v');
        const gpuInputIdx = gpuArgs.indexOf('-i');
        assert(gpuDecoderIdx !== -1 && gpuDecoderIdx + 1 < gpuInputIdx && gpuArgs[gpuDecoderIdx + 1] === 'h264_cuvid',
            'GPU decode option must sit before -i as an input option');
        assertEqual(bridge.pickDecoderArgs('AV1', { gpuDecoders: ['av1_cuvid'] }), ['-c:v', 'av1_cuvid'],
            'AV1 source must decode on av1_cuvid when available');
        assertEqual(bridge.pickDecoderArgs('AV1', { gpuDecoders: ['h264_cuvid'] }), [],
            'a missing NVDEC decoder must fall back to CPU decode');
        assertEqual(bridge.pickDecoderArgs('AV1', { gpuDecode: '0' }), [],
            'BRIDGE_GPU_DECODE=0 must disable NVDEC');
        assertEqual(bridge.pickDecoderArgs('VP8', {}), [],
            'codecs without a cuvid decoder must use CPU decode');
    },

    // The player must route each browser to a path it can actually decode:
    // AV1 sources go straight to AV1 browsers and through live-h264 for the
    // rest; H264 sources optionally ride the low-bitrate live-av1 rendition.
    'choose-stream-path-matrix'() {
        const { fn } = compileFunction('chooseStreamPath', { console: quietConsole() });
        const ready = (name, tracks) => ({
            name, ready: true, online: true, ...(tracks ? { tracks } : {})
        });
        const items = (list) => list;

        const av1Source = items([
            ready('live', ['AV1', 'Opus']),
            { name: 'live-h264', ready: false }
        ]);
        const av1SourceFallbackReady = items([
            ready('live', ['AV1', 'Opus']),
            ready('live-h264', ['H264', 'Opus'])
        ]);
        const h264Source = items([
            ready('live', ['H264', 'Opus']),
            { name: 'live-av1', ready: false }
        ]);
        const h264SourceRenditionReady = items([
            ready('live', ['H264', 'Opus']),
            ready('live-av1', ['AV1', 'Opus'])
        ]);
        const offline = items([{ name: 'live', ready: false, online: false }]);

        assertEqual(fn(av1Source, true), 'live',
            'AV1 browser on AV1 source must play the native path (no transcode)');
        assertEqual(fn(av1Source, false), null,
            'legacy browser on AV1 source must wait until live-h264 exists');
        assertEqual(fn(av1Source, true, false), null,
            'software-AV1 browser must wait for live-h264 instead of stuttering on native AV1');
        assertEqual(fn(av1SourceFallbackReady, true, false), 'live-h264',
            'software-AV1 browser falls back to the H264 rendition once ready');
        assertEqual(fn(av1SourceFallbackReady, false), 'live-h264',
            'legacy browser must fall back to the H264 rendition');
        assertEqual(fn(h264Source, false), 'live',
            'legacy browser on H264 source plays the source directly');
        assertEqual(fn(h264Source, true), 'live',
            'AV1 browser keeps the source until the rendition is ready');
        assertEqual(fn(h264SourceRenditionReady, true), 'live',
            'AV1 browser must start on the full-quality source, not the 3000k transcode');
        assertEqual(fn(offline, true), null, 'offline source selects nothing');
        assertEqual(fn([], false), null, 'empty path list selects nothing');
        assertEqual(fn(null, false), null, 'non-array input selects nothing');

        // A source without a tracks field (older API / fixture) must degrade
        // to the source path rather than crashing or waiting forever.
        const noTracks = items([ready('live')]);
        assertEqual(fn(noTracks, false), 'live', 'missing tracks must not block playback');

        // The Media Capabilities probe refines the choice: a browser that
        // supports AV1 only in software would stutter at high resolution, so
        // it stays on the hardware-decodable H264 path even when the AV1
        // rendition is ready.
        assertEqual(fn(h264SourceRenditionReady, true, true), 'live',
            'smooth AV1 decode must not move an unstressed viewer off the full-quality source');
        assertEqual(fn(h264SourceRenditionReady, true, false), 'live',
            'non-smooth AV1 decode must stay on the hardware-decodable path');
        assertEqual(fn(h264SourceRenditionReady, true, null), 'live',
            'unknown decode quality must not move a viewer off the full-quality source');
        assertEqual(fn(h264SourceRenditionReady, true, true, 'preferTranscode'), 'live-av1',
            'ABR downgrade forces the low-bitrate rendition');
        assertEqual(fn(h264SourceRenditionReady, true, false, 'preferTranscode'), 'live',
            'ABR never overrides the decode-quality guard');
        assertEqual(fn(h264SourceRenditionReady, true, true, 'preferNonTranscode'), 'live',
            'ABR upgrade returns to the source');
        assertEqual(fn(h264Source, true, false), 'live',
            'without a rendition the source plays regardless of decode smoothness');

        // --- Audio rescue (RTMP/SRT AAC sources): MediaMTX serves the AAC
        // track to nobody over WebRTC, so the native path plays VIDEO-ONLY.
        // Every viewer must be routed to a rendition that carries Opus — and
        // wait for it when it is still spinning up, never connect muted.
        const h264AacReady = items([
            ready('live', ['H264', 'MPEG-4 Audio']),
            ready('live-av1', ['AV1', 'Opus']),
            ready('live-h264', ['H264', 'Opus'])
        ]);
        assertEqual(fn(h264AacReady, false), 'live-h264',
            'legacy browser on an AAC source needs the audio-rescue rendition (native is muted)');
        assertEqual(fn(h264AacReady, true), 'live-av1',
            'AV1-smooth browser on an AAC source takes the bandwidth-saving rendition (with sound)');
        assertEqual(fn(h264AacReady, true, false), 'live-h264',
            'software-AV1 browser on an AAC source takes the hardware-decodable rescue');
        assertEqual(fn(h264AacReady, true, true, 'preferNonTranscode'), 'live-h264',
            'ABR upgrade for an AAC source restores the full-bitrate sound path');
        assertEqual(fn(items([ready('live', ['H264', 'MPEG-4 Audio'])]), false), null,
            'no ready rescue rendition yet: wait instead of connecting to a muted path');

        const av1AacReady = items([
            ready('live', ['AV1', 'MPEG-4 Audio']),
            ready('live-av1', ['AV1', 'Opus']),
            ready('live-h264', ['H264', 'Opus'])
        ]);
        assertEqual(fn(av1AacReady, true), 'live-av1',
            'AV1 browser on an AV1 AAC source needs the encoded rendition for sound');
        assertEqual(fn(av1AacReady, true, true, 'preferNonTranscode'), 'live-h264',
            'ABR upgrade for an AV1 AAC source restores the full-quality rescue copy');
        assertEqual(fn(items([ready('live', ['AV1', 'MPEG-4 Audio'])]), true), null,
            'AV1 browser on an AV1 AAC source with no rendition ready must wait, not play muted');

        // Audio-only sources have no video to rescue: the native path plays
        // them directly regardless of codec support.
        const audioOnly = items([ready('live', ['MPEG-4 Audio'])]);
        assertEqual(fn(audioOnly, true), 'live', 'audio-only source must not wait for a rendition');

        // --- H265 sources (WHIP HEVC ingest): MediaMTX answers a WHEP
        // handshake with the source codec even when the browser has no H265
        // receiver, which would be a connected-but-black session. Browsers
        // without H265 support must ride the bridge's AV1 rendition instead.
        const h265Source = items([
            ready('live', ['H265', 'Opus']),
            { name: 'live-av1', ready: false, online: false }
        ]);
        const h265RenditionReady = items([
            ready('live', ['H265', 'Opus']),
            ready('live-av1', ['AV1', 'Opus'])
        ]);
        assertEqual(fn(h265Source, false, true, 'auto', true), 'live',
            'an H265-capable browser plays the native path of an H265 source');
        assertEqual(fn(h265Source, false, true, 'auto', false), null,
            'a browser without H265 decode must wait for the AV1 rendition, not take a black session');
        assertEqual(fn(h265RenditionReady, false, true, 'auto', false), 'live-av1',
            'a browser without H265 decode takes the AV1 rendition once ready');
        assertEqual(fn(h265RenditionReady, false, true, 'auto', true), 'live',
            'H265 capability keeps the native path even when the rendition exists');
    },

    // AV1 source + browser without AV1 + bridge not ready: the poll must keep
    // the connecting state and retry instead of painting a false offline.
    'poll-waits-for-compatible-rendition'() {
        const { run, calls } = makePollSandbox({
            replies: [{
                status: 200, ok: true, payload: {
                    items: [
                        { name: 'live', ready: true, online: true, tracks: ['AV1', 'Opus'] },
                        { name: 'live-h264', ready: false, online: false, tracks: [] }
                    ]
                }
            }]
        });
        return run().then(() => {
            assertEqual(calls.connect, 0, 'no connect until a decodable rendition exists');
            assertEqual(calls.ui, ['connecting'], 'the viewer must see a connecting state, not offline');
            assertEqual(calls.schedule, 1, 'the poll must continue so the bridge pickup is noticed');
        });
    },

    // An AV1-capable browser on an H264+Opus source with a ready live-av1
    // rendition must still connect to the NATIVE path. The transcode is a
    // bandwidth optimisation the ABR supervisor reaches for on evidence of a
    // struggling link; routing there by default threw away full quality for
    // every viewer, which is what made a browser-published broadcast look soft
    // next to OBS.
    'poll-picks-rendition-path'() {
        const { run, calls, context } = makePollSandbox({
            av1Capable: true,
            replies: [{
                status: 200, ok: true, payload: {
                    items: [
                        { name: 'live', ready: true, online: true, tracks: ['H264', 'Opus'] },
                        { name: 'live-av1', ready: true, online: true, tracks: ['AV1', 'Opus'] }
                    ]
                }
            }]
        });
        return run().then(() => {
            assertEqual(calls.connect, 1, 'must start exactly one connection');
            assertEqual(context.activeStreamPath, 'live',
                'an unstressed viewer must connect to the full-quality native path');
            assertEqual(calls.ui, [], 'a successful pick must not repaint the UI');
        });
    },

    // A legacy browser on an AV1-only broadcast (bridge cannot produce
    // live-h264 — the known OBS WHIP AV1 limitation) must keep "connecting"
    // without ever painting a false offline, and after sustained waiting it
    // must tell the viewer WHY, exactly once.
    'poll-warns-about-av1-only-broadcast'() {
        const av1OnlyReply = {
            status: 200, ok: true, payload: {
                items: [
                    { name: 'live', ready: true, online: true, tracks: ['AV1', 'Opus'] },
                    { name: 'live-h264', ready: false, online: false, tracks: [] }
                ]
            }
        };
        const { run, calls, context } = makePollSandbox({
            replies: Array.from({ length: 10 }, () => av1OnlyReply)
        });
        let seq = run();
        for (let i = 1; i < 10; i++) {
            seq = seq.then(() => run());
        }
        return seq.then(() => {
            assertEqual(calls.connect, 0, 'no connect without a decodable rendition');
            assertEqual(calls.ui.length, 10, 'every poll keeps the connecting state');
            assert(calls.ui.every((state) => state === 'connecting'),
                'an AV1-only broadcast must never paint offline while the source is live');
            const notices = calls.messages.filter((m) => m.includes('AV1-only'));
            assertEqual(notices.length, 1,
                'the AV1-only viewer notice must appear exactly once after sustained waiting');
            assert(context.renditionWaitPolls >= 8, 'the wait counter must accumulate');
            assert(context.renditionWaitWarned === true, 'the notice must be deduped');
        });
    },

    // The wait counter and notice must reset when the broadcast returns to a
    // playable state or goes offline, so a later AV1-only episode warns again.
    'poll-resets-rendition-wait-state'() {
        const av1OnlyReply = {
            status: 200, ok: true, payload: {
                items: [
                    { name: 'live', ready: true, online: true, tracks: ['AV1', 'Opus'] },
                    { name: 'live-h264', ready: false, online: false, tracks: [] }
                ]
            }
        };
        const offlineReply = { status: 200, ok: true, payload: { items: [] } };
        const { run, calls, context } = makePollSandbox({
            replies: [av1OnlyReply, av1OnlyReply, av1OnlyReply, av1OnlyReply,
                      av1OnlyReply, av1OnlyReply, av1OnlyReply,
                      offlineReply, av1OnlyReply]
        });
        let seq = run();
        for (let i = 1; i < 9; i++) {
            seq = seq.then(() => run());
        }
        return seq.then(() => {
            assertEqual(calls.messages.filter((m) => m.includes('AV1-only')).length, 0,
                'an offline episode must reset the wait counter before the threshold');
            assert(context.renditionWaitPolls === 1,
                'the counter restarts from the first poll after going offline');
        });
    },
});

/* --------------------------------------------------------------------------
   Latency modes and cross-file path invariants
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // The latency button cycles a hard-coded list; if it drifts from the mode
    // table the button silently stops changing anything.
    'latency-mode-cycle-matches-mode-table'() {
        const modes = evaluateConst('LATENCY_MODES');
        assertEqual(Object.keys(modes), ['ultra', 'balanced', 'smooth', 'cinema'], 'latency mode table keys');
        for (const [key, cfg] of Object.entries(modes)) {
            assert(Number.isFinite(cfg.ms) && cfg.ms > 0, `${key} must declare a positive ms value`);
            assertEqual(cfg.s, cfg.ms / 1000, `${key} seconds must match its ms value`);
            assert(typeof cfg.label === 'string' && cfg.label.length > 0, `${key} needs a label`);
            assert(typeof cfg.icon === 'string' && cfg.icon.length > 0, `${key} needs an icon`);
        }
        const defaultMode = APP_SOURCE.match(/let currentLatencyMode = '([^']+)'/);
        assert(defaultMode, 'default latency mode declaration missing');
        assert(modes[defaultMode[1]], `default latency mode "${defaultMode[1]}" is not in the table`);

        const cycle = APP_SOURCE.match(/const modes = \[([^\]]+)\]/);
        assert(cycle, 'latency button cycle list missing');
        const cycleKeys = cycle[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''));
        assertEqual(cycleKeys, Object.keys(modes), 'button cycle order must match the mode table');

        // A manual mode choice must survive reloads (otherwise every visit
        // silently snaps back to the default mid-session preference).
        assert(APP_SOURCE.includes("localStorage.getItem('rydius_latency_mode')"),
            'the saved latency mode must be loaded at boot');
        assert(APP_SOURCE.includes("localStorage.setItem('rydius_latency_mode', currentLatencyMode)"),
            'clicking the latency button must persist the choice');
    },

    // WHEP_PATH, the paths-API probe and the server's proxy prefix all have to
    // agree on "/stream-api" and on the stream name "live"; a drift here gives
    // a player that polls one endpoint and connects to another.
    'stream-endpoints-are-consistent-everywhere'() {
        const declared = APP_SOURCE.match(/const WHEP_PATH = '([^']+)'/);
        assert(declared, 'WHEP_PATH constant missing');
        assertEqual(declared[1], '/stream-api/live/whep', 'WHEP endpoint for the "live" stream path');
        assert(declared[1].startsWith('/stream-api/'), 'WHEP endpoint must live behind the /stream-api proxy prefix');
        assert(APP_SOURCE.includes('window.location.origin + WHEP_PATH'),
            'connectStream must build the WHEP URL from WHEP_PATH');

        const polled = APP_SOURCE.match(/const checkUrl = window\.location\.origin \+ '([^']+)'/);
        assert(polled, 'poll probe URL literal missing');
        assertEqual(polled[1], '/stream-api/v3/paths/list', 'poll must probe the MediaMTX paths API');
        assert(APP_SOURCE.includes("cache: 'no-store'"), 'the status probe must not be served from HTTP cache');
        assert(APP_SOURCE.includes('response.json()'), 'the status probe must read the JSON body');
        assert(APP_SOURCE.includes("item.name === 'live'"), 'the status probe must look for the "live" stream path');

        const streamName = declared[1].replace(/^\/stream-api\//, '').replace(/\/whep$/, '');
        assertEqual(streamName, 'live', 'WHEP stream segment');
        assert(APP_SOURCE.includes(`item.name === '${streamName}'`),
            'the polled stream name must match the WHEP stream segment');

        const server = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
        assert(server.includes("requestUrl.pathname.startsWith('/stream-api/')"),
            'server must route the /stream-api/ prefix to MediaMTX');
        assert(server.match(/const targetPath = requestUrl\.pathname\.slice\('\/stream-api'\.length\) \|\| '\/'/),
            'proxy must strip the /stream-api prefix before forwarding');
    },
});

/* --------------------------------------------------------------------------
   Windowed playout-delay measurement (drift detection ground truth)
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // Chrome reports jitterBufferDelay/jitterBufferEmittedCount as cumulative
    // session totals. The old code divided one by the other, i.e. an
    // all-session average: after a few steady minutes a fresh multi-second
    // slip behind the live edge barely moved it, so the catch-up trigger
    // never fired and viewers drifted further and further behind. The deltas
    // between ticks must be used instead.
    'playout-delay-is-windowed'() {
        const { fn } = compileFunction('windowedPlayoutDelayMs', {});

        // Steady buffer: 10 frames emitted during the window, the delay total
        // grew by exactly 2s -> 200ms average playout delay for that window.
        assertEqual(fn(11, 60, 9, 50), 200, 'delta quotient must yield the window average in ms');
        assertEqual(fn(20, 120, 11, 60), 150, 'later windows measure independently of earlier ones');

        // First tick after connect: no baseline exists yet -> no measurement
        // (the old cumulative path reported a stale session average here).
        assertEqual(fn(11, 60, 0, 0), null, 'the first tick has no baseline and must report nothing');

        // No frames were emitted during this window (static screen, paused
        // publisher): a stale value must be kept rather than divided by zero.
        assertEqual(fn(11, 60, 11, 60), null, 'zero emitted frames must report nothing');

        // A counter reset (fresh getStats session on reconnect) must never be
        // read as a negative or huge delay.
        assertEqual(fn(1, 5, 11, 60), null, 'reset counters must report nothing');

        // Growing emitted count with shrinking totals (impossible in practice
        // but a hard guard against NaN leakage into the supervisor).
        assertEqual(fn(9, 60, 11, 50), null, 'shrinking delay totals must report nothing');
    },
});

/* --------------------------------------------------------------------------
   Adaptive buffer supervision
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // The playout floor grows with measured network jitter (late frames left
    // under-buffered are what a viewer sees as "frame drops"), is capped at
    // 600ms, rises immediately and decays one 25ms step per tick once calm.
    'jitter-buffer-floor'() {
        const { fn } = compileFunction('jitterBufferFloorMs', {});
        assertEqual(fn(null, 0), 0, 'no jitter measurement -> no floor');
        assertEqual(fn(20, 0), 0, 'jitter up to 20ms needs no floor');
        assertEqual(fn(40, 0), 175, '40ms jitter lifts the floor to 175ms');
        assertEqual(fn(100, 0), 325, '100ms jitter lifts the floor to 325ms');
        assertEqual(fn(300, 0), 600, 'extreme jitter is capped at 600ms');
        assertEqual(fn(150, 100), 450, 'a rising floor applies immediately');
        assertEqual(fn(20, 200), 175, 'a calming floor decays one 25ms step per tick');
        assertEqual(fn(0, 50), 25, 'decay reaches zero stepwise, never jumps');
    },
    // jitterBufferTarget is a HINT, not a command: the spec gives the UA a min
    // and max target "reflecting what the user agent is able or willing to
    // provide", so the number written is not evidence of the number in force.
    // jitterBufferTargetDelay is the standardized read-back, defined in exactly
    // the same cumulative terms as jitterBufferDelay, so the SAME windowed
    // delta formula applies to it.
    'granted-target-readback'() {
        const { fn } = compileFunction('windowedGrantedTargetMs', {});
        // 3 samples emitted over a window that accumulated 0.9s of target =>
        // a 300ms average granted target.
        assertEqual(fn(1.2, 303, 0.3, 300), 300,
            'granted target is the windowed delta/delta, in ms');
        // A counter that moved backwards (session restart, re-baseline) is not
        // a measurement: the delta would be negative and the average garbage.
        assertEqual(fn(0.2, 303, 0.9, 300), null,
            'a counter that went backwards is not a measurement');
        assertEqual(fn(1.2, 303, 0.3, 303), null,
            'a window that emitted nothing is not a measurement');
        assertEqual(fn(1.2, 300, 0.3, 300), null,
            'the very first tick has no baseline and must not report');
        assertEqual(fn(1.2, 0, 0, 0), null,
            'a session that has emitted nothing reports nothing');
    },
    // The requested-vs-granted gap is the signal that a write is inert. It is a
    // DIAGNOSTIC only and must never feed the control law, so a surprising
    // reading cannot oscillate the buffer.
    'granted-target-gap'() {
        const { fn } = compileFunction('grantedTargetGapMs', {});
        assertEqual(fn(350, 350), 0, 'an honoured target has no gap');
        assertEqual(fn(120, 350), -230,
            'a UA clamping below the request shows as a negative gap');
        assertEqual(fn(800, 350), 450,
            'a UA holding more than requested shows as a positive gap');
        assertEqual(fn(null, 350), null, 'no read-back reported -> no claim');
        assertEqual(fn(350, null), null, 'no request to compare against');
        assertEqual(fn(NaN, 350), null, 'a NaN read-back is not a measurement');
        assertEqual(fn(-1, 350), null, 'a negative delay is nonsense, not a gap');
        assertEqual(fn(999999, 0), 4000, 'the gap is clamped for reporting');
        assertEqual(fn(0, 999999), -4000, 'the negative gap is clamped too');
    },
    // The setter's documented range is [0, 4000]; out-of-range throws a
    // RangeError. Nothing enforced that before, so a future bump to any cap
    // above 4000 would throw on every write and silently disable buffer
    // control while the HUD kept advertising a target.
    'jitter-target-clamp'() {
        const { fn } = compileFunction('clampJitterBufferTargetMs', {
            JITTER_TARGET_MAX_MS: 4000, JITTER_TARGET_MIN_MS: 0,
        });
        assertEqual(fn(180), 180, 'an in-range target is untouched');
        assertEqual(fn(0), 0, 'zero is legal');
        assertEqual(fn(4000), 4000, 'the maximum is legal');
        assertEqual(fn(4001), 4000, 'above the maximum is clamped down');
        assertEqual(fn(99999), 4000, 'a wildly high cap cannot throw a RangeError');
        assertEqual(fn(-5), 0, 'a negative target is clamped to zero');
        assertEqual(fn(NaN), null, 'a non-finite target is not a write');
        assertEqual(fn(undefined), null, 'an undefined target is not a write');
    },
    // playbackRate reads 1.0 for a MediaStream, so the ONLY instrument for
    // "the video speeds up / slows down" is d(mediaTime)/d(wall) from rVFC. A
    // buffer surplus gets spent by running fast, which is that exact symptom.
    'effective-playback-rate'() {
        const { fn } = compileFunction('effectivePlaybackRate', {
            PLAYBACK_RATE_SMOOTHING: 0.15,
        });
        assertEqual(fn(0.0167, 0.0167, null), 1,
            'a perfectly paced element measures exactly 1.0');
        const fast = fn(0.05, 0.0167, null);
        assert(fast > 2.9 && fast < 3.1,
            'media time advancing 3x wall time measures ~3.0 (the "speeds up" case)');
        let rate = 1;
        rate = fn(0.0167, 0.0167, rate);
        assertEqual(rate, 1, 'steady 1.0 input holds 1.0');
        // The EMA must stop one outlying frame pair from dominating. A 6x pair
        // (a frame delivered in a burst after a stall) is the worst case: it
        // must move the smoothed rate a long way short of 6, or a single stall
        // would be reported as the stream "running at 6x".
        const spiked = fn(0.1, 0.0167, rate);
        assert(spiked > 1, 'a fast frame must still move the rate up');
        assert(spiked < 2,
            `one burst frame cannot dominate the average (got ${spiked}, raw was ~6)`);
        // And it must recover: subsequent on-pace frames pull it back to 1.
        let recovering = spiked;
        for (let i = 0; i < 40; i++) recovering = fn(0.0167, 0.0167, recovering);
        assert(Math.abs(recovering - 1) < 0.01,
            `the rate must converge back to 1.0 after the burst (got ${recovering})`);
        // Unmeasurable windows keep the previous reading rather than poisoning
        // it with NaN or zero.
        assertEqual(fn(0.02, 0, 1), 1, 'a zero wall interval keeps the last rate');
        assertEqual(fn(NaN, 0.0167, 1), 1, 'a bad mediaTime keeps the last rate');
        assertEqual(fn(0.0167, 0.0167, 0), 1,
            'a zero previous rate is treated as no previous rate');
        assertEqual(fn(0.0167, 0.0167, null), 1, 'a null previous rate seeds cleanly');
    },
    // Audio clock drift in ppm, from totalSamplesDuration vs wall time. A few
    // hundred ppm walks tens of ms per minute and the browser then corrects
    // continuously, which reads as jank rather than as desync.
    'audio-clock-drift'() {
        const { fn } = compileFunction('audioClockDriftPpm', {});
        // ppm is a ratio of two floats, so these are compared with a tolerance
        // rather than for exact equality: 10.01/10 evaluates to 999.99999999...,
        // and demanding an exact 1000 here would be asserting on IEEE754 rather
        // than on the formula.
        const near = (actual, expected, tol, label) => {
            assert(actual !== null && Math.abs(actual - expected) <= tol,
                `${label}\n  expected: ~${expected}\n  actual:   ${actual}`);
        };
        near(fn(10, 10), 0, 1e-6, 'audio time matching wall time is 0ppm');
        near(fn(10.01, 10), 1000, 1e-3, 'audio running 1000ppm fast reads +1000');
        near(fn(9.99, 10), -1000, 1e-3, 'audio running 1000ppm slow reads -1000');
        // 30ms of skew over a minute is ~500ppm: audible as drift across a
        // session, and the value this exists to catch.
        near(fn(60.03, 60), 500, 1, '30ms of skew over a minute is ~500ppm');
        assertEqual(fn(10, 0), null, 'a zero wall interval is not a measurement');
        assertEqual(fn(0, 10), null, 'no audio time elapsed is not a measurement');
        assertEqual(fn(NaN, 10), null, 'a NaN counter is not a measurement');
        assertEqual(fn(10, NaN), null, 'a NaN wall clock is not a measurement');
    },
    // The spec defines a freeze as a rendered-frame gap of at least
    // max(3 * avg_frame_duration_ms, avg_frame_duration_ms + 150). The point of
    // the formula is that the bound is NOT one constant: across real frame
    // rates it moves from ~158ms at 120fps to ~192ms at 24fps, and the 3x term
    // only takes over below ~13.3fps. A single constant is either too tight at
    // low frame rates (firing constantly) or too loose at high ones (missing
    // real freezes).
    'spec-freeze-threshold'() {
        const { fn } = compileFunction('specFreezeThresholdMs', {});
        const near = (actual, expected, label) => {
            assert(actual !== null && Math.abs(actual - expected) < 0.01,
                `${label}\n  expected: ~${expected}\n  actual:   ${actual}`);
        };
        near(fn(1000 / 120), 158.3333, '120fps: avg+150 dominates (158.3ms)');
        near(fn(1000 / 60), 166.6667, '60fps: avg+150 dominates (166.7ms)');
        near(fn(1000 / 50), 170, '50fps: avg+150 dominates (170ms)');
        near(fn(1000 / 30), 183.3333, '30fps: avg+150 dominates (183.3ms)');
        near(fn(1000 / 24), 191.6667, '24fps: avg+150 dominates (191.7ms)');
        // Below ~13.3fps the 3x term overtakes the +150 term.
        near(fn(1000 / 10), 300, '10fps: the 3x term takes over (300ms)');
        assert(fn(1000 / 24) !== fn(1000 / 60),
            'the threshold must vary with frame rate, not be a constant');
        assertEqual(fn(0), null, 'a zero frame duration is not measurable');
        assertEqual(fn(NaN), null, 'a NaN frame duration is not measurable');
        assertEqual(fn(-5), null, 'a negative frame duration is not measurable');
    },
    // Presentation evenness — the detector for the "0% loss but not smooth"
    // report. It has to satisfy two opposing requirements at once: it must stay
    // SILENT on a steady stream (a false positive widens the buffer of every
    // healthy viewer) and it must FIRE on a genuinely uneven one (a false
    // negative is the bug it exists to fix).
    'presentation-evenness-detects-uneven-cadence'() {
        const { fn } = compileFunction('frameGapUnevenness', {});
        const { fn: note } = compileFunction('noteFramePresentation', {});
        const WINDOW = 90;

        // Build a realistic window the way rVFC would: feed gaps one at a time
        // through the same windowing the player uses.
        const feed = (gaps) => {
            let w = [];
            for (const g of gaps) w = note(g, w);
            return fn(w);
        };
        const steady = (ms) => feed(new Array(200).fill(ms));
        const alternating = (a, b) => feed(new Array(200).fill(0).map((_, i) => (i % 2 ? b : a)));
        const wobble = (ms, amp) => feed(new Array(200).fill(0)
            .map((_, i) => ms + (i % 3 === 0 ? amp : (i % 3 === 1 ? -amp : 0))));

        // MUST NOT FIRE — these are all healthy viewers, and a false positive
        // widens the buffer of every one of them once per session.
        assert(steady(16.7) < 0.05, `a steady 60fps stream must read as even, got ${steady(16.7)}`);
        assert(steady(33.3) < 0.05, `a steady 30fps stream must read as even, got ${steady(33.3)}`);
        assert(wobble(16.7, 2.5) < 0.35,
            `ordinary +/-2.5ms vsync wobble must not be called uneven, got ${wobble(16.7, 2.5)}`);
        // A single dropped frame is a blip. The reported symptom is explicitly
        // CONTINUOUS, so an isolated hitch must not trip the detector.
        const oneOutlier = new Array(200).fill(33.3);
        oneOutlier[100] = 90;
        assert(feed(oneOutlier) < 0.35,
            `a single dropped frame must not be called continuous unevenness, got ${feed(oneOutlier)}`);

        // THE OUTLIER CASE THAT MATTERS. A lone 700ms hitch (a keyframe wait or a
        // GC pause) at 30fps: mean-absolute-deviation is dominated by outlier
        // MAGNITUDE, so without a plausibility bound this produced a hot reading
        // for three consecutive samples — exactly the 3-tick streak — and the
        // one-shot widen was spent on a blip. Measured on a steady 30fps stream,
        // 33fps of frame time is ~33ms, so 700ms is >20x the cadence and is a
        // stall (the freeze watchdog's domain), not unevenness.
        for (const hitch of [700, 400, 250]) {
            const withHitch = new Array(200).fill(33.3);
            withHitch[100] = hitch;
            assert(feed(withHitch) < 0.35,
                `a single ${hitch}ms hitch must not be called continuous unevenness, `
                + `got ${feed(withHitch)}`);
        }

        // MUST FIRE — continuously uneven cadence, with zero packet loss.
        const rough30 = alternating(16, 48);
        const rough60 = alternating(10, 24);
        assert(rough30 > 0.35, `a 3:1 alternating cadence must read as uneven, got ${rough30}`);
        assert(rough60 > 0.35, `a 2.4:1 alternating cadence must read as uneven, got ${rough60}`);

        // Cadence-independent: the same SHAPE of irregularity must score the same
        // at any frame rate, or a 30fps viewer is judged by a 60fps threshold.
        assert(Math.abs(rough30 - rough60) < 0.2,
            `unevenness must be cadence-independent, 30fps=${rough30} 60fps=${rough60}`);

        // The window must actually slide: a stream that is rough and then settles
        // must stop reading as uneven, or a single bad minute marks the session.
        let w = [];
        for (const g of new Array(200).fill(0).map((_, i) => (i % 2 ? 48 : 16))) w = note(g, w);
        const whileRough = fn(w);
        for (let i = 0; i < 200; i++) w = note(16.7, w);
        const afterSettling = fn(w);
        assert(whileRough > 0.35 && afterSettling < 0.35,
            `the window must slide: rough=${whileRough} afterSettling=${afterSettling}`);

        // Degenerate inputs must not produce a number that could arm the detector.
        assertEqual(fn(null), null, 'a non-array must not produce a reading');
        assertEqual(fn([]), null, 'an empty window must not produce a reading');
        assertEqual(fn([16, 16]), null, 'fewer than 4 samples must not produce a reading');
        assertEqual(fn([16, 16, NaN, -1, 0, 16]), null,
            'a window of unusable samples must not produce a reading');
        // noteFramePresentation must ignore junk rather than poison the window.
        assertEqual(note(NaN, [1, 2, 3]), [1, 2, 3], 'a NaN gap must be ignored');
        assertEqual(note(0, [1, 2, 3]), [1, 2, 3], 'a zero gap must be ignored');
        assertEqual(note(-5, [1, 2, 3]), [1, 2, 3], 'a negative gap must be ignored');
        // The window is bounded: it must not grow without limit over a long session.
        let big = [];
        for (let i = 0; i < 100000; i++) big = note(16.7, big);
        assertEqual(big.length, WINDOW, `the gap window must stay bounded at ${WINDOW}, got ${big.length}`);
    },
    // The catch-up gate exists because the rate law is deliberately left as-is:
    // its dead band is SYMMETRIC and avgPlayoutDelayMs is a windowed mean over
    // emitted frames, so on a real link it crosses that band between consecutive
    // 1s windows (119ms one tick, 121ms the next). Simulated end to end, the
    // ungated controller wrote playbackRate once per second forever with zero
    // packet loss and zero drops in the stats. The gate is what makes it settle.
    'catch-up-gate-stops-the-per-second-rewrite'() {
        const { fn: law } = compileFunction('catchUpPlaybackRate', {});
        const ENGAGE_BAND_MS = 180;
        const ENGAGE_CLEAR_MS = 120;
        const ENGAGE_TICKS = 2;
        const ENGAGE_DWELL_MS = 2000;
        const TICK_MS = 1000;

        // This models the SHIPPED gate in updateLiveEdgeCatchUp. An earlier version
        // of this test re-implemented the gate, and the re-implementation put the
        // engage-streak update OUTSIDE the `wanted !== rate` branch while the real
        // code had it INSIDE — so the test passed against an algorithm the file
        // does not contain, and the shipped controller was still doing 59
        // playbackRate writes per 120s and stranding the element at 1.01.
        //
        // The ordering below is the point of the test: the streak is counted
        // before the branch, exactly as it must be in app.js. If that ever moves
        // back inside the branch in app.js, this model no longer describes it —
        // so the structural check below is the real guard, and this model is the
        // behavioural specification of what the corrected order must produce.
        const initialState = () => ({ rate: 1, above: 0, lastWrite: -Infinity, writes: 0 });
        const simulate = (delays, target, state = initialState(), tickOffset = 0) => {
            delays.forEach((delay, i) => {
                const now = (tickOffset + i) * TICK_MS;
                const wanted = law(delay, target, state.rate, 1.08);
                const engaged = wanted > state.rate;
                const excess = delay - target;
                // Streak FIRST, then the write branch. This ordering is load-bearing.
                // The DEAD GAP is load-bearing too: the law's own dead band is 120ms,
                // and engaging at that same boundary means acting on the law's own
                // indecision. Measured against the real law, engaging at 120 (with or
                // without a 60ms reset hysteresis) writes 59 times in 120s and leaves
                // the element flipping 1.00 <-> 1.01 forever. The gap is 120..180.
                if (excess > ENGAGE_BAND_MS) state.above += 1;
                else if (excess < ENGAGE_CLEAR_MS) state.above = 0;
                if (wanted !== state.rate) {
                    const streakOk = !engaged || state.above >= ENGAGE_TICKS;
                    const dwellOk = !engaged || (now - state.lastWrite) >= ENGAGE_DWELL_MS;
                    if (streakOk && dwellOk) {
                        state.rate = wanted;
                        state.lastWrite = now;
                        state.writes += 1;
                    }
                }
            });
            return state;
        };

        // STRUCTURAL: the shipped source must count the streak outside the branch.
        // A behavioural model of an algorithm the code does not implement is worse
        // than no test, so this assertion is what actually pins the fix.
        const body = APP_SOURCE.slice(APP_SOURCE.indexOf('function updateLiveEdgeCatchUp('),
            APP_SOURCE.indexOf('function resetLiveEdgeCatchUp('));
        const streakAt = body.indexOf('catchUpAboveBandTicks += 1');
        const branchAt = body.indexOf('if (wanted !== catchUpRate)');
        assert(streakAt > 0 && branchAt > 0,
            'could not locate the engage streak and the write branch in updateLiveEdgeCatchUp');
        assert(streakAt < branchAt,
            'the engage streak must be counted BEFORE the `wanted !== catchUpRate` branch; '
            + 'inside it, a down-tick clears the streak and the gate can never engage');

        // ...and the engage threshold must clear the rate law's own 120ms dead band
        // with room to spare. Engaging AT the law's boundary means acting on the
        // law's own indecision, and the behavioural assertions above are what
        // caught it: 59 writes per 120s and a permanent 1.00<->1.01 flip.
        const lawBody = compileFunction('catchUpPlaybackRate', {}).src
            || APP_SOURCE.slice(APP_SOURCE.indexOf('function catchUpPlaybackRate('),
                APP_SOURCE.indexOf('function updateLiveEdgeCatchUp('));
        const deadBand = /DEAD_BAND_MS\s*=\s*(\d+)/.exec(lawBody);
        assert(deadBand !== null, 'could not read the rate law dead band');
        const engage = /ENGAGE_BAND_MS\s*=\s*(\d+)/.exec(body);
        const clear = /ENGAGE_CLEAR_MS\s*=\s*(\d+)/.exec(body);
        assert(engage !== null && clear !== null,
            'updateLiveEdgeCatchUp must define both ENGAGE_BAND_MS and ENGAGE_CLEAR_MS');
        const lawBand = Number(deadBand[1]);
        assert(Number(engage[1]) > lawBand,
            `ENGAGE_BAND_MS (${engage[1]}) must sit ABOVE the rate law's DEAD_BAND_MS `
            + `(${lawBand}); engaging at the law's own boundary reproduces the 0.5 Hz `
            + 'playbackRate rewrite this gate exists to prevent');
        assert(Number(clear[1]) < Number(engage[1]),
            'ENGAGE_CLEAR_MS must sit BELOW ENGAGE_BAND_MS, or the "dead gap" is a '
            + 'single line and a delay oscillating across it resets the streak forever');
        // The gap must be wide enough to absorb the window-to-window swing of a
        // windowed mean, and it sits entirely ABOVE the law's own dead band: a
        // genuinely settled delay (inside the law's 120ms) is then also below
        // ENGAGE_CLEAR_MS, so it clears the streak and catch-up disengages, while a
        // delay oscillating just above the law's band cannot keep re-arming it.
        assert(Number(engage[1]) - Number(clear[1]) >= 40,
            `the dead gap is too narrow to absorb window-to-window jitter `
            + `(${clear[1]}..${engage[1]})`);
        assert(Number(clear[1]) >= lawBand,
            `ENGAGE_CLEAR_MS (${clear[1]}) must sit ABOVE the rate law's DEAD_BAND_MS `
            + `(${lawBand}), so a delay oscillating just inside the law's own dead band `
            + 'cannot keep re-arming the engage streak');

        // THE REGRESSION: a delay dithering either side of the band edge. The old
        // controller wrote on essentially every one of these 120 ticks.
        const dither = [];
        for (let i = 0; i < 120; i++) dither.push(300 + (i % 2 === 0 ? 119 : 121));
        const dithered = simulate(dither, 300);
        assert(dithered.writes <= 2,
            `a delay dithering across the band edge must settle, saw ${dithered.writes} `
            + 'playbackRate writes in 120s');
        assertEqual(dithered.rate, 1,
            `a dithering delay must settle back at 1.0x, got ${dithered.rate}`);
        // The gate must NOT have disabled the mechanism it protects. ONE continuous
        // simulation with state carried across ticks, exactly as the controller
        // runs: calling simulate() per tick would reset the rate, the streak and the
        // dwell each tick, which is not what happens at runtime.
        //
        // Traced against the real law, the gate engages at 1.01 after 2 ticks, ramps
        // to the 1.08 cap, drains 1.5s of drift, then ramps back down and settles at
        // 1.0x. Both directions are asserted, because a gate that stopped the
        // oscillation by never engaging would pass a "must not write" test alone.
        let delay = 1680;    // 180ms target + 1.5s of accumulated drift
        let peak = 1;
        let ticks = 0;
        const live = initialState();
        while (delay > 180 && ticks < 120) {
            simulate([delay], 180, live, ticks);
            peak = Math.max(peak, live.rate);
            delay -= (live.rate - 1) * 1000;
            ticks += 1;
        }
        assert(peak > 1.05,
            `a genuinely drifted session must ramp catch-up up, peak was ${peak}`);
        // The law stops ramping down inside its own 120ms dead band, so the delay
        // settles at target + dead band rather than exactly at the target. That is
        // correct and intended: the surplus below the dead band is the cushion.
        assert(delay <= 180 + 120 + 1,
            `catch-up must drain the drift into the dead band, ended at ${Math.round(delay)}ms `
            + `after ${ticks}s`);

        // Once the drift is gone the rate must come back to rest rather than
        // parking above 1.0x — a permanent fast picture is the exact defect the
        // original catch-up bug produced. The delay is at the target (excess 0),
        // which is inside the law's dead band, so every tick asks to ramp down and
        // the release is ungated.
        for (let i = 0; i < 20 && live.rate > 1; i++) {
            simulate([180], 180, live, ticks + i);
        }
        assertEqual(live.rate, 1,
            `once the drift is gone the rate must return to 1.0x, got ${live.rate}`);

        // A gate that stops the oscillation by NEVER ENGAGING would pass every
        // assertion above, because "writes <= 2" and "rate settles at 1.0" are also
        // what a permanently-disabled controller produces. This is the case that
        // tells the two apart.
        //
        // The dither case above is NOT this case: at 119/121 the law is asking to
        // come back down on half those ticks, so silence is correct there. Here the
        // excess is 400ms — well clear of the 240ms engage band and far beyond
        // anything the law would call "settled" — so silence means the gate is
        // broken. This is the shape a hidden tab leaves (1.5-3s), so it is the case
        // that actually matters to a viewer.
        const heldAbove = initialState();
        for (let i = 0; i < 12; i++) simulate([700], 300, heldAbove, i);
        assert(heldAbove.rate > 1,
            `a delay held 400ms over target MUST engage catch-up; rate stayed `
            + `${heldAbove.rate} — the gate is suppressing a real drift`);

        // The dead gap must not be a black hole. An earlier revision set the
        // engage threshold at 240ms, which silently stranded EVERY drift between
        // 121ms and 240ms: the law calls that band drainable, the streak never
        // reached 2, and a viewer sitting 200ms behind live got no remedy and no
        // diagnostic, forever. The gap is now 120..180, so anything at or beyond
        // 180ms of excess is treated. 200ms is the case that regressed.
        const moderate = initialState();
        for (let i = 0; i < 12; i++) simulate([500], 300, moderate, i);
        assert(moderate.rate > 1,
            `200ms of sustained drift MUST engage catch-up; rate stayed `
            + `${moderate.rate} — the dead gap is swallowing real drift`);

        // ...and the gap is still a gap: a delay INSIDE it must not be engaged,
        // or we are back to rewriting the element for noise.
        const insideGap = initialState();
        for (let i = 0; i < 60; i++) simulate([300 + (i % 2 === 0 ? 119 : 121)], 300, insideGap, i);
        assertEqual(insideGap.rate, 1,
            `a delay oscillating inside the dead gap must rest at 1.0x, got ${insideGap.rate}`);
        assert(insideGap.writes === 0,
            `a delay inside the dead gap must produce no writes at all, got ${insideGap.writes}`);
    },
    // `lastLossPct` used to be dLost/(dRx+dLost). packetsReceived INCLUDES
    // retransmissions per the stats spec, so a link that loses 20% of its
    // packets and repairs 100% of them by RTX reads ~0% loss — the ABR ladder
    // then never steps a genuinely-smooth-but-lossy viewer down, and a
    // MediaMTX queue overflow (a real, unrepairable drop) was invisible as a
    // separate cause. These pin the corrected accounting.
    'network-loss-accounting'() {
        const { fn } = compileFunction('networkLossPct', {});
        // ~625 packets/s is a realistic window for a 6Mbps stream, which is the
        // volume these percentages have to stay meaningful at.
        const RX = 620;

        // THE SCALE TRAP. The denominator is everything the link OFFERED, not
        // just the loss. Dividing by the loss alone measures "the share of lost
        // packets RTX failed to repair" — a repair rate — and inflates the
        // reading by 1-2 orders of magnitude: 3 lost with 2 repaired reads 33%
        // that way and 0.16% this way. Since 33% is above the 5% ABR threshold
        // AND the 2.5% stress threshold, the repair-rate version pins a
        // perfectly smooth viewer to 3000k and to the 350ms buffer, and
        // `abrCalm` (loss < 2% for 20 consecutive ticks) can never be satisfied
        // so they never come back. These three assertions exist to stop that.
        assert(fn(3, 2, 0, RX) < 1, 'a 0.5%-loss, 80%-repaired link must read as well under 1%');
        assert(fn(1, 0, 0, RX) < 1, 'one unrepaired packet in 620 must not read as stressed');
        assert(fn(6, 0, 0, RX) < 1, 'a ~1% real loss rate must read near 1%, not near 100%');

        // The headline behaviour the whole function exists for: RTX-repaired
        // loss is NOT net loss. 0 is right because the retransmissions were
        // subtracted, not because they inflated the denominator.
        assertEqual(fn(20, 20, 0, RX), 0, 'a fully RTX-repaired window is not net loss');

        // Half repaired: of 20 lost, 10 came back. 10 of 640 offered = 1.56%.
        assertEqual(Math.round(fn(20, 10, 0, RX) * 100) / 100, 1.56,
            'half-repaired loss reports the unrecovered share of the link');

        // Nothing repaired: 20 of 640 offered = 3.13%, which is what the
        // un-repaired 20-packet window actually is as a link-loss rate.
        assertEqual(Math.round(fn(20, 0, 0, RX) * 100) / 100, 3.13,
            'an unrepaired window reports its true link-loss share');

        // Monotonicity: more unrepaired loss can never read as LESS loss, and
        // repairing packets can never INCREASE it.
        assert(fn(10, 0, 0, RX) < fn(20, 0, 0, RX), 'loss must be monotonic in unrepaired count');
        assert(fn(20, 0, 0, RX) > fn(20, 20, 0, RX), 'repair must strictly reduce reported loss');
        assert(fn(20, 5, 0, RX) < fn(20, 0, 0, RX), 'some repair must still reduce reported loss');
        assert(fn(20, 20, 0, RX) < fn(20, 0, 0, RX), 'full repair must beat no repair');

        // A genuine link failure still reads as failure: if the receiver gets
        // almost nothing, the metric must say so and let the ABR ladder act.
        assertEqual(fn(200, 0, 0, 0), 100, 'a link delivering nothing is 100% net loss');
        assert(fn(100, 0, 0, 50) > 50, 'a link losing two thirds of its packets reads as catastrophic');

        // Local discards widen the denominator but must NOT become the
        // numerator: a packet the jitter buffer dropped after it arrived is not
        // network loss, and the ABR ladder must not treat it as a thin link.
        // It does, however, have to be visible as a share of offered volume,
        // which is what makes an over-tight buffer distinguishable from a
        // congested one in the diagnostics.
        assertEqual(fn(0, 0, 10, RX), 0, 'pure discard is not net network loss');
        assertEqual(Math.round(fn(0, 0, 10, RX) * 100) / 100, 0,
            'discard alone contributes nothing to net loss (0 of 640)');
        // Combined with real loss, the discard only enlarges the denominator,
        // so it can never make the reported rate look WORSE per unit of loss.
        assert(fn(20, 0, 0, RX) > fn(20, 0, 10, RX), 'discard dilutes the loss rate, never inflates it');

        // A retransmission count can never exceed the loss it repairs: RTX
        // counters are per-SSRC and reset to 0 when the source re-keys, so a
        // stale baseline can produce retx > lost. That must clamp to 0, not go
        // negative and poison the controller.
        assertEqual(fn(5, 50, 0, RX), 0, 'retx beyond loss clamps to zero, never negative');
        assertEqual(fn(0, 50, 0, RX), 0, 'retx with no loss is clamped, not negative');

        // A window with no loss at all must not hand the supervisor a NaN from
        // a 0/0 division.
        assertEqual(fn(0, 0, 0, 0), 0, 'a fully empty window is 0%, not NaN');
        assertEqual(fn(0, 0, 0, RX), 0, 'a clean window is 0%, not NaN');

        // Counter reset on a stream restart produces negative deltas upstream;
        // the function must not propagate them, and must not read a reset as a
        // total link failure.
        assertEqual(fn(-30, -15, 0, RX), 0, 'negative loss deltas clamp to zero');
        assertEqual(fn(0, 0, 0, -50), 0, 'a negative received delta is treated as zero, not as loss');

        assert(fn(10, 0, 0, RX) <= 100, 'loss is capped at 100%');
    },
    // The scale bug in `network-loss-accounting` above was invisible in
    // isolation because the function's own unit tests were written to whatever
    // it returned. These tie the METRIC to the two real thresholds the app
    // actually compares it against, which is the only way a unit change in the
    // denominator gets caught: >5% is the ABR downgrade, >2.5% is the 350ms
    // buffer hold, and <2% for 20 consecutive ticks is the only route back to
    // full quality.
    'loss-metric-scale-matches-controller-thresholds'() {
        const { fn } = compileFunction('networkLossPct', {});
        const ABR_DOWNGRADE_PCT = 5;
        const STRESS_HOLD_PCT = 2.5;
        const ABR_CALM_PCT = 2;
        const RX = 620;   // ~625 packets/s, a 6Mbps stream

        // A link losing 0.5% where RTX repairs 80% of it. The picture is FINE.
        // Under the repair-rate denominator this reads 33% and pins the viewer
        // to 3000k, holds their buffer at 350ms, and makes the upgrade-back
        // unreachable (loss < 2% for 20 consecutive ticks) for the whole
        // session — a permanent quality downgrade on a healthy link.
        const smooth = fn(3, 2, 0, RX);
        assert(smooth < ABR_CALM_PCT,
            `a 0.5%-loss, 80%-repaired link must read under the ${ABR_CALM_PCT}% calm bound, got ${smooth.toFixed(2)}%`);
        assert(smooth < STRESS_HOLD_PCT,
            'a smooth repaired link must not trip the buffer-stress hold');
        assert(smooth < ABR_DOWNGRADE_PCT,
            'a smooth repaired link must not trip the ABR downgrade');

        // A genuinely marginal link must be allowed to reach the hold, or the
        // metric is now too insensitive and the controllers never act.
        // 13 lost of 633 offered = 2.05%, i.e. just over the 2% calm bound.
        const marginal = fn(13, 0, 0, RX);
        assert(marginal > ABR_CALM_PCT,
            `an unrepaired ~2% link must exceed the ${ABR_CALM_PCT}% calm bound, got ${marginal.toFixed(2)}%`);
        assert(marginal < ABR_DOWNGRADE_PCT,
            'a ~2% link must NOT trigger the ABR downgrade — that needs sustained stress');
        // ...and it must be able to reach the 2.5% stress hold too, which is
        // what widens the jitter buffer on a marginal link.
        const atHold = fn(16, 0, 0, RX);
        assert(atHold > STRESS_HOLD_PCT,
            'an unrepaired ~2.5% link must reach the buffer-stress hold');

        // A clearly broken link must trip both, or the fix went too far and
        // silently disabled the ladder.
        const broken = fn(120, 0, 0, RX);
        assert(broken > ABR_DOWNGRADE_PCT,
            'a link losing ~16% of its packets must trigger the ABR downgrade');
        assert(broken > STRESS_HOLD_PCT, 'a broken link must trigger the buffer hold');

        // Recovery must actually be reachable. Carried through the REAL ABR
        // state machine rather than re-evaluating a constant 30 times (which
        // would only restate the assertion above): the supervisor's own
        // accumulators must cross the 20-second upgrade-back threshold on a
        // link whose loss reads calm, or that branch is dead code.
        const recovery = compileFunction('superviseAdaptiveBuffer', (() => {
            const base = {
                isConnected: true, isConnecting: false, currentLatencyMode: 'balanced',
                LATENCY_MODES: {
                    ultra: { ms: 80, driftLimitMs: 1200 },
                    balanced: { ms: 180, driftLimitMs: 2500 },
                    smooth: { ms: 350, driftLimitMs: 3000 }
                },
                rejoinDriftSec: 0, decodeLagSec: 0, lastFramesReceived: 0,
                adaptiveRaiseLevelMs: 0, stressRunSec: 0, calmRunSec: 0,
                bufferNoticeState: '', accommodationTargetMs: 0,
                avgPlayoutDelayMs: 150, avgPlayoutDelayAt: 100000,
                lastNetJitterMs: 10,
                // The smooth-but-lossy link this guards: 0.16% net loss.
                lastLossPct: fn(3, 2, 0, RX),
                lastAppliedTargetMs: null, jitterFloorEmaMs: 0,
                abrBadSec: 0, abrCalmSec: 0, abrDowngradedForLink: false, catchUpRate: 1,
                lastRenditionSwitchAt: -60000, renditionPathsItems: null,
                activeStreamPath: 'live-av1', av1DecodeSmooth: true,
                browserSupportsAv1() { return true; },
                browserSupportsH265() { return true; },
                chooseStreamPath() { return 'live'; },
                player: { paused: false }, document: { hidden: false },
                performance: { now: () => 100000 },
                RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
                console: quietConsole(),
                reapplyBufferTargets() { return true; }, updateBufferHud() {},
                addSystemMessage() {},
                // The stress-hold level the supervisor's raise/release state
                // machine compares against; it is a module-level const in
                // app.js and must exist in the sandbox or the release branch
                // throws. See the other ABR sandbox above.
                ADAPTIVE_RAISE_MS: 350,
                switchRendition(path) { recoverySandbox.switchedTo = path; },
                // Presentation evenness: superviseAdaptiveBuffer() reads these on
                // every tick, so the sandbox must provide them or the extracted
                // function throws "frameGapUnevenness is not defined" before any
                // of this case's own assertions ever run.
                frameGapWindow: [],
                frameGapUnevenness: compileFunction('frameGapUnevenness', {}).fn,
                catchUpProvenUseless: true,
                updateLiveEdgeCatchUp() { return false; },
                resetLiveEdgeCatchUp() {}
            };
            return base;
        })());
        const recoverySandbox = recovery.sandbox;
        recoverySandbox.renditionPathsItems = [
            { name: 'live', ready: true, online: true, tracks: ['H264', 'Opus'] },
            { name: 'live-av1', ready: true, online: true, tracks: ['AV1', 'Opus'] }
        ];
        let recoveryTicks = 0;
        while (recoverySandbox.abrCalmSec < 20 && recoveryTicks < 60) {
            recovery.fn();
            recoveryTicks += 1;
        }
        assert(recoverySandbox.abrCalmSec >= 20,
            'a link whose net loss reads calm must be able to reach the 20s upgrade-back threshold');
        assert(recoverySandbox.switchedTo === 'live',
            'a smooth-but-lossy link must actually be upgraded back to full quality');
    },
    // PLR is the standard broadcast QoE metric. Both counters were already being
    // read for other purposes, so this was free — and the app reported no way to
    // answer "was this session actually smooth?".
    'picture-loss-ratio'() {
        const { fn } = compileFunction('pictureLossRatioPct', {});

        assertEqual(fn(100, 100), 0, 'a fully decoded window is 0% PLR');
        assertEqual(fn(100, 90), 10, '10 of 100 received-but-undecoded is 10%');
        assertEqual(fn(1000, 995), 0.5, 'sub-percent PLR is preserved, not rounded away');

        // More decoded than received within a window is a counter artefact
        // (reordering, or a framesReceived baseline lagging), not a negative
        // quality metric. Clamp, do not report nonsense.
        assertEqual(fn(100, 110), 0, 'decoded>received clamps to 0%');

        // A window with no received frames is UNDEFINED, not "0% loss": a 0/0
        // would be NaN and the HUD would render "NaN%".
        assertEqual(fn(0, 0), null, 'no frames received is undefined, not 0%');
        assertEqual(fn(0, 5), null, 'no frames received is undefined even if decoded>0');

        assertEqual(fn(100, 0), 100, 'nothing decoded is 100% PLR');
        assertEqual(fn(-10, 0), null, 'negative received is undefined');
    },
    // The watchdog used to test `decodedDelta === 0`, which is blind to a
    // partially-wedged decoder (the worst viewer experience there is: a 60fps
    // stream decoding at 2fps) and can false-fire on a sub-poll sampling
    // artefact, costing a 2-4s black screen on healthy playback.
    'decoder-stall-detection'() {
        const { fn } = compileFunction('isDecoderStalled', {});
        // The watchdog polls every 1.5s; these use that window unless noted.
        const W = 1.5;

        // Hard stop with the transport alive: the original case. Still detected.
        assertEqual(fn(20000, 0, 60, W), true, 'a decoder producing nothing is stalled');
        // ...and detected even with no rate baseline, because a hard zero is
        // unambiguous on its own.
        assertEqual(fn(20000, 0, null, W), true, 'a hard zero is a stall even with no fps baseline');

        // The blind spot this fixes: 60fps stream, ~3 frames in the window. The
        // old `=== 0` test called this HEALTHY while the viewer watched a
        // slideshow.
        assertEqual(fn(20000, 3, 60, W), true, 'a partially-wedged decoder is a stall');

        // Healthy playback must never be flagged. 60fps over a 1.5s window is
        // ~90 frames and the floor is 60 * 1.5 * 0.25 = 22.5, so a healthy
        // stream clears it with 4x headroom.
        assertEqual(fn(20000, 90, 60, W), false, 'a healthy 60fps decoder is not a stall');
        // The floor is 22.5, so 23 clears it and 22 does not. Pinning both
        // sides stops the comparison drifting from strict back to <=.
        assertEqual(fn(20000, 23, 60, W), false, 'just above the 25% floor is not a stall');
        assertEqual(fn(20000, 22, 60, W), true, 'just below the 25% floor is a stall');
        assertEqual(fn(20000, 24, 60, W), false, 'a quarter of nominal is comfortably clear');

        // THE UNIT TRAP this function has to get right: `fps` is a per-second
        // rate but `decodedDelta` is a count over the window. Ignoring the span
        // compares 90 delivered against an expectation of 15 and tears down a
        // perfectly healthy 60fps session — a 2-4s black screen, repeatedly.
        assertEqual(fn(20000, 90, 60, 1.0), false, 'a healthy 60fps decoder over a 1s window is fine');
        // 3.0s of a 60fps stream delivers ~180 frames, and the floor there is
        // 60 * 3 * 0.25 = 45. 150 is comfortably clear of it. Picking a value
        // just above the floor (46 vs 45) is what actually proves the span is
        // multiplied in rather than assumed to be 1s: under a 1s assumption the
        // floor would be 15 and 46 would wrongly read as a stall.
        assertEqual(fn(20000, 150, 60, 3.0), false, 'a healthy 60fps decoder over a 3s window is fine');
        assertEqual(fn(20000, 46, 60, 3.0), false, 'the span is honoured, not assumed to be 1s');
        // ...and a clearly-short count over a 1s span IS a stall. 10 frames in
        // 1s against a floor of 15 is a decoder delivering a sixth of nominal;
        // over the 3s span the same 10 would be far worse still.
        assertEqual(fn(20000, 10, 60, 1.0), true, 'a clearly short count over a 1s span is a stall');
        assertEqual(fn(20000, 10, 60, 3.0), true, 'the same count over a longer span is judged against it');
        // 46 over 1s is ~77% of nominal, which is healthy: the floor is 15, so
        // it must clear. (An earlier version of this check expected a stall
        // here and was simply wrong about the arithmetic.)
        assertEqual(fn(20000, 46, 60, 1.0), false, '46 frames in 1s is ~77% of nominal and is healthy');

        // No transport -> not a decoder stall. That is a network problem, and
        // the recovery for it is completely different.
        assertEqual(fn(0, 0, 60, W), false, 'no bytes means no decoder stall');
        assertEqual(fn(500, 0, 60, W), false, 'a trickle of bytes is not a live transport');

        // A low-rate source: 5fps over 1.5s is ~7.5 frames and 25% of nominal
        // is 1.9, so a normal low-fps decode is never flagged.
        assertEqual(fn(20000, 7, 5, W), false, 'a healthy 5fps source is not a stall');
        assertEqual(fn(20000, 0, 5, W), true, 'a hard stop on a 5fps source is a stall');

        // Without a usable baseline the function must not guess, and must not
        // fire: a missing fps or a missing span is "no evidence", not "stall".
        assertEqual(fn(20000, 2, null, W), false, 'no fps baseline: only a hard zero fires');
        assertEqual(fn(20000, 2, 0, W), false, 'a zero fps is not a usable baseline');
        assertEqual(fn(20000, 2, NaN, W), false, 'a NaN fps is not a usable baseline');
        assertEqual(fn(20000, 2, 60, 0), false, 'a zero span is not a usable baseline');
        assertEqual(fn(20000, 2, 60, -1), false, 'a negative span is not a usable baseline');
        assertEqual(fn(20000, 2, 60, NaN), false, 'a NaN span is not a usable baseline');

        // A counter reset mid-session must read as "no evidence", never as a
        // stall (which would tear a healthy session down).
        assertEqual(fn(20000, -5, 60, W), false, 'a negative delta is a counter reset, not a stall');
    },
    // The accommodation must be drop-gated: the measured jitter-buffer delay
    // always tracks the jitterBufferTarget hint Chrome was given, so a
    // controller that raises to meet the measurement chases its own tail and
    // inflates EVERY session to the cap within half a minute. Raising is
    // reserved for hard evidence (frames actually discarded while the buffer
    // outgrew the base target); sustained calm drains the extra latency.
    'buffer-accommodation-gate'() {
        const { fn } = compileFunction('bufferAccommodationMs', {});

        // Late frames actually discarded AND the measured buffer 1.2s past the
        // 180ms base: grant what Chrome needs (+100ms headroom, 100ms steps).
        assertEqual(fn(1200, 0, 180, true, 0), 1300,
            'a real late-frame discard raises to the measured need + 100ms');
        assertEqual(fn(3000, 0, 180, true, 0), 2200,
            'the raise is capped at 2200ms');

        // THE regression: Chrome sitting at the granted target with no drops
        // must HOLD — the old controller raised +100ms every tick until the
        // cap, trading the user's latency choice for nothing.
        assertEqual(fn(180, 0, 180, false, 0), 0,
            'measured delay at the target with no drops must not raise');
        assertEqual(fn(1300, 1300, 180, false, 0), 1300,
            'measured delay tracking a raised target must hold, not climb');
        assertEqual(fn(350, 200, 180, false, 0), 200,
            'a larger measurement without drops must not raise');

        // THE OTHER HALF OF THE SAME REGRESSION, and the one that actually fires
        // in production. The drop-gate only ever stopped the climb for the
        // NO-DROPS case. baseBufferTargetMs() deliberately excludes
        // accommodationTargetMs, so `delay > base + 150` stayed permanently true
        // once Chrome converged on the granted target — and on a real link
        // frames ARE being discarded, which is the whole reason the gate exists.
        // Simulated against the real function: 180ms -> 2200ms in 19 ticks, one
        // re-pace each, each above the filled level so Chrome holds frames
        // (~1.1s of frozen picture in the first 20s of any rough session).
        assertEqual(fn(450, 450, 180, true, 0), 450,
            'a raise must never climb against its own grant while frames are dropping');
        assertEqual(fn(2200, 2200, 180, true, 0), 2200,
            'the cap must hold, not oscillate');
        // Monotonicity: the "raise" branch must never return LESS than the level
        // already granted. It used to: 2200 -> 500 in a single tick, then a 1ms
        // step across `base + 150` flipped the output by 50ms, so a noisy
        // measurement could collapse the buffer under the viewer.
        assertEqual(fn(400, 2200, 180, true, 0), 2200,
            'the raise branch must never return less than the level already granted');
        // A genuine, LARGER need still gets through — the fix is not "freeze".
        assertEqual(fn(700, 450, 180, true, 0), 800,
            'a measured need well beyond the current grant must still raise');
        // And the drain still works.
        assertEqual(fn(400, 400, 180, false, 5), 300,
            'sustained calm still drains one 100ms step');

        // Decode/GPU-pressure drops with the buffer at the target are not a
        // buffer problem: the 150ms margin keeps them from inflating latency.
        assertEqual(fn(260, 0, 180, true, 0), 0,
            'drops with the buffer barely above the target must not raise');

        // Sustained calm (>=5 drop-free ticks) drains one 100ms step per tick.
        // The quantum is 100ms, not 50ms, and that is load-bearing: the 50ms
        // quantum was EXACTLY equal to BUFFER_TARGET_BAND_MS, and reapplyBufferTargets
        // filters with a strict `<`, so a 50ms step was never filtered and every
        // accommodation increment became a real jitterBufferTarget write on both
        // receivers. A 100ms step is a decisive correction rather than noise.
        assertEqual(fn(1300, 1300, 180, false, 4), 1300,
            'fewer than 5 calm ticks must hold');
        assertEqual(fn(1300, 1300, 180, false, 5), 1200,
            'calm ticks drain the accommodation 100ms per tick');
        assertEqual(fn(1300, 30, 180, false, 5), 0,
            'the drain floors at zero');

        // A measuring/null delay always holds the previous value.
        assertEqual(fn(null, 700, 180, false, 9), 700,
            'a null measurement must hold');
        assertEqual(fn(undefined, 700, 180, true, 0), 700,
            'a non-numeric measurement must hold');
    },
    // While the tab is hidden, Chrome suspends video presentation and the
    // measured jitter-buffer delay explodes — the supervisor must sleep while
    // hidden and resume when visible. On resume, a delay past the
    // accommodation cap means the session is stale: the supervisor rejoins at
    // the live edge (fresh WHEP session) instead of presenting seconds-old
    // frames. Within the cap the delay is simply accommodated — no drops.
    'buffer-supervisor-sleeps-while-hidden'() {
        const make = (hidden, overrides = {}) => {
            const sandbox = {
                isConnected: true,
                isConnecting: false,
                currentLatencyMode: 'balanced',
                LATENCY_MODES: {
                    ultra: { ms: 80, driftLimitMs: 900 },
                    balanced: { ms: 180, driftLimitMs: 1000 },
                    smooth: { ms: 350, driftLimitMs: 1100 }
                },
                rejoinDriftSec: 2,
                decodeLagSec: 0,
                lastFramesReceived: 0,
                adaptiveRaiseLevelMs: 0,
                stressRunSec: 0,
                calmRunSec: 0,
                bufferNoticeState: '',
                avgPlayoutDelayMs: 5000,
              avgPlayoutDelayAt: 1000, // fresh: the drift supervisor requires a live reading
                lastNetJitterMs: 2,
                lastLossPct: 0,
                lastAppliedTargetMs: null,
                jitterFloorEmaMs: 0,
                accommodationTargetMs: 0,
                abrBadSec: 0,
                abrCalmSec: 0,
                lastRenditionSwitchAt: -60000,
                renditionPathsItems: null,
                activeStreamPath: 'live',
                player: { paused: false },
                document: { hidden },
                performance: { now: () => 1000 },
                RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
                console: quietConsole(),
                // Live-edge catch-up runs before the drift branch, so the
                // supervisor's sandbox has to model it. Stubbed (not real) so
                // these cases keep testing the supervisor's own state machine;
                // the catch-up law itself is covered separately.
                // Presentation evenness: superviseAdaptiveBuffer() reads these on
                // every tick, so the sandbox must provide them or the extracted
                // function throws "frameGapUnevenness is not defined" before any
                // of this case's own assertions ever run.
                frameGapWindow: [],
                frameGapUnevenness: compileFunction('frameGapUnevenness', {}).fn,
                catchUpProvenUseless: true,
                updateLiveEdgeCatchUp() { return false; },
                resetLiveEdgeCatchUp() { sandbox.catchUpReset = (sandbox.catchUpReset || 0) + 1; },
                reapplyBufferTargets() { sandbox.reapplied = (sandbox.reapplied || 0) + 1; return true; },
                updateBufferHud(state) { sandbox.hudStates = (sandbox.hudStates || []).concat(state || []); },
                addSystemMessage(text) { sandbox.messages = (sandbox.messages || []).concat(text); },
                switchRendition(path) { sandbox.switchedTo = path; },
                ...overrides
            };
            const { fn } = compileFunction('superviseAdaptiveBuffer', sandbox);
            return { sandbox, run: fn };
        };

        const hidden = make(true);
        hidden.run();
        assertEqual(hidden.sandbox.switchedTo, undefined, 'hidden tab must not trigger a rejoin');
        assertEqual(hidden.sandbox.reapplied, undefined, 'hidden tab must not touch playout targets');
        assertEqual(hidden.sandbox.messages, undefined, 'hidden tab must not post notices');

        // A 5s delay past the 2.6s cap reconnects at the live edge.
        const visible = make(false);
        visible.run();
        assertEqual(visible.sandbox.switchedTo, 'live',
            'drift past the accommodation cap must rejoin at the live edge');

        // The rejoin is rate-limited by the switch cooldown.
        const cooled = make(false, { lastRenditionSwitchAt: 99000 });
        cooled.run();
        assertEqual(cooled.sandbox.switchedTo, undefined,
            'a rejoin within the 60s cooldown must be suppressed');

        // Delay inside the cap is accommodated — no rejoin, no message.
        const accommodated = make(false, { avgPlayoutDelayMs: 1500 });
        accommodated.run();
        assertEqual(accommodated.sandbox.switchedTo, undefined,
            'delay within the accommodation cap must not rejoin');
    },
});

/* --------------------------------------------------------------------------
   Adaptive rendition switching (ABR)
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // A stressed viewer must be moved onto the low-bitrate rendition before
    // their frame drops become unwatchable, and moved back once calm — with
    // guards: 60s switch cooldown, H264 sources only, rendition readiness.
    'abr-switching-state-machine'() {
        const ladder = {
            h264Source: [
                { name: 'live', ready: true, online: true, tracks: ['H264', 'Opus'] },
                { name: 'live-av1', ready: true, online: true, tracks: ['AV1', 'Opus'] }
            ],
            av1Source: [
                { name: 'live', ready: true, online: true, tracks: ['AV1', 'Opus'] },
                { name: 'live-h264', ready: true, online: true, tracks: ['H264', 'Opus'] }
            ]
        };
        const make = (overrides = {}) => {
            const sandbox = {
                isConnected: true,
                currentLatencyMode: 'balanced',
                LATENCY_MODES: {
                    ultra: { ms: 80, driftLimitMs: 1200 },
                    balanced: { ms: 180, driftLimitMs: 2500 },
                    smooth: { ms: 350, driftLimitMs: 3000 }
                },
                rejoinDriftSec: 0,
                decodeLagSec: 0,
                lastFramesReceived: 0,
                adaptiveRaiseLevelMs: 0,
                stressRunSec: 0,
                calmRunSec: 0,
                bufferNoticeState: '',
                accommodationTargetMs: 0,
                isConnecting: false,
                avgPlayoutDelayMs: 150,
              avgPlayoutDelayAt: 100000,
                lastNetJitterMs: 10,
                lastLossPct: 0,
                lastAppliedTargetMs: null,
                jitterFloorEmaMs: 0,
                abrBadSec: 0,
                abrCalmSec: 0,
                abrDowngradedForLink: false,
                catchUpRate: 1,
                // The stress-hold level the supervisor's raise/release machine
                // compares against (a module-level const in app.js).
                ADAPTIVE_RAISE_MS: 350,
                lastRenditionSwitchAt: -60000,
                renditionPathsItems: ladder.h264Source,
                activeStreamPath: 'live',
                rejoinDriftSec: 0,
                decodeLagSec: 0,
                lastFramesReceived: 0,
                av1DecodeSmooth: true,
                // The downgrade must consult the real decode capability: the
                // default sandbox models an AV1-capable viewer, and the
                // legacy-viewer sub-case below overrides it.
                browserSupportsAv1() { return true; },
                browserSupportsH265() { return true; },
                chooseStreamPath() { return 'live'; },
                // superviseAdaptiveBuffer() treats a paused viewer as "not under
                // stress" (RTP keeps arriving while paused, so loss/jitter look
                // stressed forever and the controller would act on it). These
                // cases all model a PLAYING viewer, so the element is present and
                // not paused. Cases about the paused path override this.
                player: { paused: false },
                document: { hidden: false },
                performance: { now: () => 100000 },
                RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
                console: quietConsole(),
                reapplyBufferTargets() { return true; },
                updateBufferHud() {},
                addSystemMessage(text) { sandbox.messages = (sandbox.messages || []).concat(text); },
                switchRendition(path) { sandbox.switchedTo = path; },
                // Live-edge catch-up runs before the drift branch; stubbed so
                // this case keeps testing the ABR ladder's own state machine.
                frameGapWindow: [],
                frameGapUnevenness: compileFunction('frameGapUnevenness', {}).fn,
                catchUpProvenUseless: true,
                updateLiveEdgeCatchUp() { return false; },
                resetLiveEdgeCatchUp() {},
                ...overrides
            };
            const { fn } = compileFunction('superviseAdaptiveBuffer', sandbox);
            return { sandbox, run: fn };
        };

        // 8 stressed seconds on the source with a ready rendition -> downgrade.
        const down = make({ abrBadSec: 7, lastLossPct: 8 });
        down.run();
        assertEqual(down.sandbox.switchedTo, 'live-av1',
            'sustained stress on the full-bitrate path must downgrade to live-av1');

        // A browser WITHOUT AV1 decode must never be downgraded onto the AV1
        // rendition — an undecodable session is strictly worse than the
        // stutter it is escaping. Buffer accommodation still protects it.
        const legacy = make({ abrBadSec: 7, lastLossPct: 8, browserSupportsAv1() { return false; } });
        legacy.run();
        assertEqual(legacy.sandbox.switchedTo, undefined,
            'a browser without AV1 decode must keep its decodable full-bitrate path under stress');

        // 20 calm seconds on the rendition -> upgrade back to the source.
        const up = make({
            abrCalmSec: 19,
            lastLossPct: 0,
            lastNetJitterMs: 10,
            activeStreamPath: 'live-av1'
        });
        up.run();
        assertEqual(up.sandbox.switchedTo, 'live',
            'sustained calm on the rendition must upgrade back to the source');

        // Cooldown: a recent switch suppresses both directions.
        const cooled = make({ abrBadSec: 7, lastLossPct: 8, lastRenditionSwitchAt: 99000 });
        cooled.run();
        assertEqual(cooled.sandbox.switchedTo, undefined,
            'a switch within the 60s cooldown must be suppressed');

        // AV1 sources have no lighter rendition to switch to — never downgrade.
        const av1Source = make({
            abrBadSec: 7,
            lastLossPct: 8,
            renditionPathsItems: ladder.av1Source
        });
        av1Source.run();
        assertEqual(av1Source.sandbox.switchedTo, undefined,
            'AV1-source viewers must not be downgraded (they already play native AV1)');

        // A brief stress spike below the threshold must not switch.
        const spike = make({ abrBadSec: 3, lastLossPct: 8 });
        spike.run();
        assertEqual(spike.sandbox.switchedTo, undefined,
            'fewer than 8 stressed seconds must not switch');

        // F2 (accumulator dead band). `abrCalm` used to be an INDEPENDENT test
        // rather than a relaxation of `abrStressed`: stress fired above 120ms
        // jitter while calm required under 40ms, so a link sitting anywhere in
        // between was neither, and BOTH accumulators froze permanently. A
        // struggling viewer then never stepped down, and a viewer that HAD
        // stepped down never came back.
        //
        // 70ms jitter with no loss sits below the calm bound, so the calm
        // counter must advance. That is what proves the branch is reachable
        // and the hysteresis is live.
        const deadBand = make({ lastNetJitterMs: 70, lastLossPct: 0, abrCalmSec: 0 });
        deadBand.run();
        assertEqual(deadBand.sandbox.switchedTo, undefined,
            'a 70ms-jitter link is not stressed enough to downgrade');
        assertEqual(deadBand.sandbox.abrCalmSec, 1,
            'a sub-90ms link must count as calm (accumulator dead band)');

        // The deliberate hysteresis span (90-120ms): neither stressed nor
        // calm. Holding BOTH counters is what froze a downgraded viewer at
        // 100ms jitter forever, so the span advances the calm counter at a
        // FRACTION instead: too slow to upgrade a bad link quickly, but it
        // terminates, which is the property that matters.
        const midBand = make({ lastNetJitterMs: 100, lastLossPct: 0, abrCalmSec: 0, abrBadSec: 0 });
        midBand.run();
        assertEqual(midBand.sandbox.switchedTo, undefined,
            'a 100ms-jitter link must not be downgraded');
        // Fractional, and deliberately SLOW: 0.05 means 400 ticks to the 20s
        // threshold, which outlasts the 60s switch cooldown. A faster factor
        // (0.25 = 80 ticks) let a link hovering in the band upgrade to full
        // bitrate and downgrade again every ~80s, trading a 2-4s black screen
        // forever. The property that matters is that it terminates at all.
        assertEqual(midBand.sandbox.abrCalmSec, 0.05,
            'the ambiguous band must advance calm progress by a small fraction, not zero');
        assertEqual(midBand.sandbox.abrBadSec, 0,
            'a 100ms-jitter link is not yet stressed');
        // Termination, driven through the REAL supervisor: 400 ticks is inside
        // the bound, so a permanently-ambiguous link still eventually climbs
        // back rather than being pinned forever. A hold-at-zero counter could
        // never do this.
        let ambig = make({
            lastNetJitterMs: 100, lastLossPct: 0, abrCalmSec: 0, abrBadSec: 0,
            renditionPathsItems: ladder.h264Source, activeStreamPath: 'live-av1',
            lastRenditionSwitchAt: -60000
        });
        let ticks = 0;
        while (ambig.sandbox.abrCalmSec < 20 && ticks < 500) { ambig.run(); ticks += 1; }
        assertEqual(ambig.sandbox.switchedTo, 'live',
            'a link sitting in the ambiguous band must still be able to climb back to full quality');
        assert(ticks <= 500, 'the ambiguous band must terminate rather than freeze');
        // ...but NOT within the switch cooldown, which is what stops the
        // upgrade/stress/downgrade oscillation.
        assert(ticks > 60,
            `ambiguous progress must be slower than the 60s cooldown (took ${ticks} ticks)`);
        // One tick later, once it settles into the calm band, it must advance at
        // full rate — proving the fraction is a weighting, not a brake on
        // recovery.
        const recovered = make({ lastNetJitterMs: 80, lastLossPct: 0, abrCalmSec: 0, abrBadSec: 0 });
        recovered.run();
        assertEqual(recovered.sandbox.abrCalmSec, 1,
            'a link settling under the calm bound must accumulate at full rate');

        // A genuinely stressed link still takes the stress branch and never the
        // calm one, so the fix did not invert the predicates.
        const stillStressed = make({ lastNetJitterMs: 130, lastLossPct: 0, abrCalmSec: 3 });
        stillStressed.run();
        assertEqual(stillStressed.sandbox.abrCalmSec, 0,
            'a 130ms-jitter link must reset the calm counter, not advance it');
        assertEqual(stillStressed.sandbox.abrBadSec, 1,
            'a 130ms-jitter link must count as stressed');

        // The same hysteresis must hold on the LOSS axis. 3% loss is between
        // the 2% calm and 5% stress bounds, so it is ambiguous: not calm, not
        // stressed. It must NOT count as calm, or the upgrade-back counter would
        // run on a lossy link — but it must make fractional progress rather
        // than freeze, for the same reason the jitter band does.
        const midLoss = make({ lastLossPct: 3, lastNetJitterMs: 10, abrCalmSec: 0 });
        midLoss.run();
        assertEqual(midLoss.sandbox.abrCalmSec, 0.05,
            '3% loss is ambiguous: minimal progress only, never full calm credit');
        assertEqual(midLoss.sandbox.abrBadSec, 0,
            '3% loss is below the stress bound');
        // Below 2% it is unambiguously calm and earns full credit.
        const lowLoss = make({ lastLossPct: 1, lastNetJitterMs: 10, abrCalmSec: 0 });
        lowLoss.run();
        assertEqual(lowLoss.sandbox.abrCalmSec, 1,
            '1% loss with low jitter is unambiguously calm');
        // At or above the 5% stress bound it is stressed and both reset.
        const highLoss = make({ lastLossPct: 6, lastNetJitterMs: 10, abrCalmSec: 5 });
        highLoss.run();
        assertEqual(highLoss.sandbox.abrCalmSec, 0,
            '6% loss must reset the calm counter entirely');
        assertEqual(highLoss.sandbox.abrBadSec, 1, '6% loss must count as stressed');

        // The ambiguous band keeps the counter alive so a marginal link is never
        // pinned forever — but a counter that reached 20 while the link is
        // still measurably lossy must NOT be permission to climb back to full
        // bitrate. The guard sits at the point of action, not on the
        // accumulator, so the two concerns stay independent.
        const lossyUpgrade = make({
            lastLossPct: 3, lastNetJitterMs: 10, abrCalmSec: 25, abrBadSec: 0,
            renditionPathsItems: ladder.h264Source, activeStreamPath: 'live-av1',
            lastRenditionSwitchAt: -60000
        });
        lossyUpgrade.run();
        assertEqual(lossyUpgrade.sandbox.switchedTo, undefined,
            'a saturated calm counter must not upgrade a link that is still losing 3% of its packets');
        // Once the loss actually recovers, the very same state must upgrade.
        const recoveredLoss = make({
            lastLossPct: 0.5, lastNetJitterMs: 10, abrCalmSec: 25, abrBadSec: 0,
            renditionPathsItems: ladder.h264Source, activeStreamPath: 'live-av1',
            lastRenditionSwitchAt: -60000
        });
        recoveredLoss.run();
        assertEqual(recoveredLoss.sandbox.switchedTo, 'live',
            'with loss back under the calm bound the upgrade must proceed');
    },
});

/* --------------------------------------------------------------------------
   Hidden-tab catch-up recovery
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // Returning from a hidden tab inflates the measured playout delay above
    // the Balanced drift limit (verified live: 1.7s), so the supervisor's
    // 4-tick confirmation never fires and the viewer stays seconds behind
    // live. The visibility-return hook must arm the stepwise catch-up at
    // once — and stay idle when there is no real drift.
    'catchup-latch-returns-the-element-to-1x'() {
        // The self-verification latch must never outlive the rate it justified.
        //
        // `superviseAdaptiveBuffer` guards the controller with
        // `!catchUpProvenUseless && updateLiveEdgeCatchUp()`, and that function
        // is the ONLY code that lowers player.playbackRate. So when the
        // self-check declared the mechanism useless, the old code set the flag
        // and stopped -- leaving the element pinned at 1.08x for the rest of
        // the session. That is the precise outcome the branch's own comment
        // says it exists to prevent ("permanently sped-up stream while the real
        // problem went untreated"), and the hard rejoin that was supposed to
        // follow only trips above 3100ms, so any delay between the base target
        // and that cap had no way back at all.
        //
        // This runs the REAL function against a mutable sandbox, so the whole
        // sequence -- ramp, saturate, fail to drain, latch off -- is exercised
        // rather than a restatement of the source text.
        const make = ({ delayMs = 1500, nowMs = 0 } = {}) => {
            // A mutable clock. The shipped updateLiveEdgeCatchUp advances one
            // REAL second per stats tick, so the engage-band streak accumulates
            // on consecutive ticks and the 2s dwell between writes is measured
            // against an advancing performance.now(). Pinning now() to a single
            // value would leave the dwell permanently at its initial gap and
            // every self-verification probe frozen, so neither the ramp nor the
            // latch could ever be exercised.
            let clock = nowMs;
            const player = { paused: false, playbackRate: 1 };
            const sandbox = {
                isConnected: true,
                player,
                document: { hidden: false },
                performance: { now: () => clock },
                avgPlayoutDelayMs: delayMs,
                avgPlayoutDelayAt: nowMs,      // a fresh reading
                catchUpRate: 1,
                catchUpProbeAt: 0,
                catchUpProbeDelayMs: null,
                catchUpProvenUseless: false,
                catchUpAboveBandTicks: 0,
                lastCatchUpWriteAt: 0,
                CATCHUP_MAX_RATE: 1.08,
                // The code under test calls `currentBufferTargetMs()` for the
                // settle point and reads `grantedTargetMs`. Stubbing the older
                // `baseBufferTargetMs` name left both undefined, so the sandbox
                // threw before the ordering/latch behaviour was ever reached.
                // Both are provided here so the case tests what it claims to.
                currentBufferTargetMs: () => 1000,
                grantedTargetMs: 0,
                catchUpPlaybackRate: (delay, base, prev, max) =>
                    Math.min(max, prev + 0.01),   // saturates after 8 ticks
                console: quietConsole(),
            };
            // The real resetLiveEdgeCatchUp, so the ORDERING fix is what is
            // under test rather than a stub that always succeeds.
            sandbox.resetLiveEdgeCatchUp = compileFunction('resetLiveEdgeCatchUp', sandbox).fn;
            const { fn } = compileFunction('updateLiveEdgeCatchUp', sandbox);
            return { sandbox, player, run: fn };
        };

        // Ramp to saturation: advance the clock 3s per tick so the engage
        // dwell (2s between writes) actually elapses and the writes land, and
        // stamp the reading to "now" each tick so it never reads stale. Two
        // ticks build the above-band streak, then each further write adds
        // 0.01 until the 1.08x cap. Break the instant it saturates so the ramp
        // does not run long enough for the self-verification probe to latch
        // "useless" while we are still trying to get there.
        const s = make({ nowMs: 0 });
        let clock = 0;
        s.sandbox.performance = { now: () => clock };
        for (let i = 0; i < 12; i++) {
            clock += 3000;
            s.sandbox.avgPlayoutDelayMs = 1500;
            s.sandbox.avgPlayoutDelayAt = clock;      // a fresh reading
            s.run();
            if (s.player.playbackRate >= 1.08) break;
        }
        assertEqual(s.player.playbackRate, 1.08,
            'a sustained 500ms overshoot must ramp the element to the 1.08x cap');

        // Now hold the delay flat and let the probe run its three stages. The
        // merged updateLiveEdgeCatchUp opens the probe the tick the rate first
        // saturates, takes the delay baseline on the NEXT tick, and only judges
        // once more than 5s have elapsed with the delay not falling -- so two
        // ticks are required here, not one. Each tick stamps the reading to
        // "now" so the freshness gate (3s) does not reset the probe and return
        // early. The mechanism is saturated and NOT draining, which is exactly
        // the trigger. Assert immediately after the judge tick -- in the real
        // supervisor the very next call is short-circuited by the flag, so
        // calling again here would re-ramp and prove nothing.
        clock += 3000;                       // baseline tick
        s.sandbox.avgPlayoutDelayMs = 1500;
        s.sandbox.avgPlayoutDelayAt = clock;
        s.run();

        clock += 6000;                       // >5s after the probe opened
        s.sandbox.avgPlayoutDelayMs = 1500;  // unchanged -> not draining
        s.sandbox.avgPlayoutDelayAt = clock;
        s.run();                             // the verdict: "proven useless"

        assertEqual(s.sandbox.catchUpProvenUseless, true,
            'a saturated controller that does not drain must disable itself');
        assertEqual(
            s.player.playbackRate, 1,
            'disabling catch-up must hand the element back at 1.0x. Leaving it ' +
            'at 1.08x is the exact "permanently sped-up stream" this branch exists ' +
            'to prevent, and nothing else in the session lowers the rate again.');
    },

    'catchup-probe-is-abandoned-when-measurement-stops'() {
        // A probe opened before a pause/hide must not be judged against a
        // reading taken minutes later. The early returns used to leave
        // catchUpProbeAt set, so a fresh reading met the ">5s later" test
        // against a stale baseline and latched the controller off on a verdict
        // it never earned.
        const make = ({ paused = false, hidden = false, isConnected = true,
                        delayMs = 1500, nowMs = 0 } = {}) => {
            // The shipped updateLiveEdgeCatchUp re-derives catchUpRate from the
            // element itself at the top of every tick (see the element-rate
            // reconciliation block), so a sandbox whose element sits at 1.0
            // while catchUpRate claims 1.08 has the latter overwritten to 1
            // before the probe logic runs -- the controller is then not
            // saturated and no probe ever opens. Start the element AT the rate
            // the case asserts is already engaged.
            const player = { paused, playbackRate: 1.08 };
            const sandbox = {
                isConnected, player,
                document: { hidden },
                performance: { now: () => nowMs },
                avgPlayoutDelayMs: delayMs,
                avgPlayoutDelayAt: nowMs,
                catchUpRate: 1.08,               // already saturated
                catchUpProbeAt: 0,
                catchUpProbeDelayMs: null,
                catchUpProvenUseless: false,
                // Declared for the same reason as the sibling case: the shipped
                // updateLiveEdgeCatchUp reads and writes these while gating an
                // engage (the above-band streak and the 2s write dwell).
                catchUpAboveBandTicks: 0,
                lastCatchUpWriteAt: 0,
                CATCHUP_MAX_RATE: 1.08,
                // Same as the sibling case: the function under test calls
                // `currentBufferTargetMs()` and reads `grantedTargetMs`, so the
                // older `baseBufferTargetMs` stub alone leaves both undefined.
                currentBufferTargetMs: () => 1000,
                grantedTargetMs: 0,
                catchUpPlaybackRate: (d, b, prev, max) => Math.min(max, prev + 0.01),
                console: quietConsole(),
            };
            sandbox.resetLiveEdgeCatchUp = compileFunction('resetLiveEdgeCatchUp', sandbox).fn;
            const { fn } = compileFunction('updateLiveEdgeCatchUp', sandbox);
            return { sandbox, player, run: fn };
        };

        // Each case must first OPEN a probe, then have the gate taken away, then
        // assert the baseline was abandoned. A brand-new sandbox already has
        // catchUpProbeAt === 0, so running the gated tick first asserts nothing
        // -- the test has to put something there to lose.
        //
        // The shipped probe is two-stage: the tick the rate is first seen
        // saturated only stamps catchUpProbeAt (baseline deliberately left null,
        // because that tick's write has not been answered yet), and the baseline
        // is recorded on the NEXT tick. Both ticks run at the same frozen clock,
        // so the >5s judge is never reached and the probe is simply left open
        // with its baseline recorded -- exactly the state these cases need.
        const openProbe = () => {
            const s = make({ nowMs: 1000 });
            s.run();                            // saturation observed -> probe stamped
            s.run();                            // baseline recorded
            assertEqual(s.sandbox.catchUpProbeDelayMs, 1500,
                'a saturated controller must open a probe and record its baseline');
            assertEqual(s.sandbox.catchUpProbeAt, 1000,
                'the probe baseline is stamped with the opening tick');
            return s;
        };

        // Sanity: with no gate the probe is still open, so the assertions below
        // are about the gate and not about a probe that never existed.
        const ungated = openProbe();
        ungated.run();
        assert(ungated.sandbox.catchUpProbeAt > 0,
            'an ungated tick must leave the probe open, or these tests prove nothing');

        // The viewer pauses / the tab hides / the session drops: the reading is
        // meaningless and must be abandoned. These must be set on the OBJECTS
        // the function reads (player.paused, document.hidden), not as bare
        // context variables -- `updateLiveEdgeCatchUp` tests `player.paused`,
        // so a top-level `paused` would be dead and every case would pass for
        // the wrong reason.
        const gates = [
            ['the viewer paused', (s) => { s.player.paused = true; }],
            ['the tab was hidden', (s) => { s.document.hidden = true; }],
            ['the session dropped', (s) => { s.isConnected = false; }],
        ];
        for (const [label, apply] of gates) {
            const g = openProbe();
            apply(g.sandbox);
            g.run();
            assertEqual(g.sandbox.catchUpProbeAt, 0,
                `the probe baseline must be abandoned when ${label}`);
            assertEqual(g.sandbox.catchUpProbeDelayMs, null,
                `the probe measurement must be abandoned when ${label}`);
        }

        // A stale reading (>3s old) is equally disqualifying, and must not be
        // allowed to keep a baseline it cannot legitimately compare against.
        const stale = openProbe();
        stale.sandbox.avgPlayoutDelayAt = 0;   // reading is 1s old...
        stale.sandbox.performance = { now: () => 5000 };  // ...but 4s have passed
        stale.run();
        assertEqual(stale.sandbox.catchUpProbeAt, 0,
            'a stale reading must abandon the probe baseline');
        assertEqual(stale.sandbox.catchUpProbeDelayMs, null,
            'a stale reading must abandon the probe measurement too');
    },

    'catch-up-arms-on-visibility-return'() {
        // The stats loop is stopped while the tab is hidden, so the retained
        // avgPlayoutDelayMs still holds the PRE-HIDE value — useless for the
        // return decision. maybeRejoinOnReturn() takes one fresh getStats()
        // delta against the pre-hide baselines, which measures exactly the
        // hidden span (jitterBufferDelay/EmittedCount kept accumulating), and
        // rejoins at the live edge when it is past the reconnection cap;
        // within the cap the measurement feeds the accommodation instead.
        const windowed = compileFunction('windowedPlayoutDelayMs', {}).fn;
        const make = ({ delayTotal = 10, emittedTotal = 50, overrides = {} } = {}) => {
            const sandbox = {
                isConnected: true,
                isConnecting: false,
                rejoinCheckInFlight: false,
                peerConnection: {
                    getStats: async () => ({
                        forEach(cb) {
                            cb({ type: 'inbound-rtp', kind: 'video',
                                 jitterBufferDelay: delayTotal,
                                 jitterBufferEmittedCount: emittedTotal });
                        }
                    })
                },
                avgPlayoutDelayMs: 200, // the healthy pre-hide value
                lastJitterDelayTotal: 10,
                lastJitterEmittedTotal: 50,
                currentLatencyMode: 'balanced',
                LATENCY_MODES: {
                    ultra: { ms: 80, driftLimitMs: 1200 },
                    balanced: { ms: 180, driftLimitMs: 2500 },
                    smooth: { ms: 350, driftLimitMs: 3000 }
                },
                activeStreamPath: 'live',
                rejoinDriftSec: 0,
                returnDriftChecks: 0,
                decodeLagSec: 0,
                lastFramesReceived: 0,
                lastRenditionSwitchAt: -60000,
                performance: { now: () => 100000 },
                console: quietConsole(),
                windowedPlayoutDelayMs: windowed,
                switchRendition(path, message) { sandbox.switchedTo = path; },
                // Live-edge catch-up now runs on this path too. It is stubbed
                // here so the rejoin escalation can be exercised explicitly:
                // the real controller is covered by
                // 'catchup-rate-drains-without-a-teardown'.
                catchUpProvenUseless: false,
                updateLiveEdgeCatchUp() { sandbox.catchUpCalled = (sandbox.catchUpCalled || 0) + 1; },
                ...overrides
            };
            const { fn } = compileFunction('maybeRejoinOnReturn', sandbox);
            return { sandbox, run: () => fn() };
        };
        return Promise.resolve().then(async () => {
            // 25 frames presented while hidden, each held 5s longer than the
            // pre-hide baseline (delta 125s / 25 frames): far past Balanced's
            // 4100ms cap. PERSISTENCE is required — one reading is not enough
            // to tear down a working session, because a normal Alt-Tab
            // measures 1.7-2.8s and sits within 300ms of the 3.1s trip point.
            // The first two over-cap checks must not switch; the third must.
            const drifted = make({ delayTotal: 135, emittedTotal: 75 });
            await drifted.run();
            assertEqual(drifted.sandbox.switchedTo, undefined,
                'a single over-cap hidden-span reading must not rejoin');
            assertEqual(drifted.sandbox.avgPlayoutDelayMs, 5000,
                'the hidden-span measurement must feed the supervisor state');
            await drifted.run();
            assertEqual(drifted.sandbox.switchedTo, undefined,
                'two consecutive over-cap readings must still not rejoin');
            await drifted.run();
            assertEqual(drifted.sandbox.switchedTo, 'live',
                'a persistently past-cap hidden-span delay must rejoin at the live edge');
            // Live-edge catch-up gets first refusal on the visibility return: a
            // hidden tab is the dominant source of drift on this project (the
            // project's own numbers put a normal Alt-Tab at 1.7-2.8s), the
            // session is perfectly healthy, and the alternative is a 2-4s hard
            // black screen to fix a problem that is purely accumulated latency.
            assert(drifted.sandbox.catchUpCalled >= 3,
                'the visibility return must attempt live-edge catch-up');
            // But the hard rejoin must remain reachable as the escalation for
            // when catch-up genuinely cannot drain the buffer.
            const stalled = make({
                delayTotal: 135, emittedTotal: 75,
                overrides: { catchUpProvenUseless: true }
            });
            await stalled.run();
            await stalled.run();
            await stalled.run();
            assertEqual(stalled.sandbox.switchedTo, 'live',
                'a session whose catch-up cannot drain must still escalate to a rejoin');
            assertEqual(stalled.sandbox.catchUpCalled, undefined,
                'a proven-useless catch-up must not be retried');

            // The counter resets as soon as a reading is back inside the cap, so
            // intermittent noise can never accumulate into a teardown.
            const flaky = make({ delayTotal: 135, emittedTotal: 75 });
            await flaky.run();
            await flaky.run();
            await make({ delayTotal: 60, emittedTotal: 75 }).run();
            assertEqual(flaky.sandbox.switchedTo, undefined,
                'an in-cap reading between over-cap ones must reset the persistence counter');

            // A 2s hidden-span delay stays inside the cap: no rejoin, and the
            // measured value is adopted so the accommodation can absorb it.
            const mid = make({ delayTotal: 60, emittedTotal: 75 });
            await mid.run();
            assertEqual(mid.sandbox.switchedTo, undefined,
                'hidden-span drift the buffer can accommodate must not rejoin');
            assertEqual(mid.sandbox.avgPlayoutDelayMs, 2000,
                'a within-cap hidden-span measurement must update the supervisor state');

            // No frames emitted while hidden (fully suspended decoder): the
            // windowed delta is null, so the healthy pre-hide value stands.
            const clean = make({ delayTotal: 10, emittedTotal: 50 });
            await clean.run();
            assertEqual(clean.sandbox.switchedTo, undefined,
                'a session with no hidden-span delta must not rejoin');
            assertEqual(clean.sandbox.avgPlayoutDelayMs, 200,
                'a null hidden-span measurement must keep the pre-hide value');

            // A disconnected session never touches getStats.
            let probed = 0;
            const disconnected = make({
                overrides: {
                    isConnected: false,
                    peerConnection: { getStats: async () => { probed += 1; return { forEach() {} }; } }
                }
            });
            await disconnected.run();
            assertEqual(probed, 0, 'a disconnected session must not probe stats');
            assertEqual(disconnected.sandbox.switchedTo, undefined,
                'a disconnected session must not rejoin');
        });
    },
});

/* --------------------------------------------------------------------------
   Unmute prompt synchronisation
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // Decode-pressure state machine: a decoder falling below 70% of the
    // arrival rate accumulates lag seconds, >=90% sheds them, and windows
    // with under 15 received frames are unmeasurable (static screens and
    // paused publishers must not look like decode pressure).
    'decode-lag-state-machine'() {
        const { fn: update } = compileFunction('updateDecodeLag', {});
        const { fn: decay } = compileFunction('decayDecodeLag', {});
        assertEqual(update(0, 60, 60), 0, 'a keeping-up decoder accumulates nothing');
        assertEqual(update(0, 40, 60), 1, 'below 70% of arrivals accumulates lag');
        assertEqual(update(1, 40, 60), 2, 'lag accumulates per stressed tick');
        assertEqual(update(3, 59, 60), 2, 'at 90-99% of arrivals lag sheds one tick');
        assertEqual(update(3, 60, 60), 2, 'a fully caught-up decoder sheds lag');
        assertEqual(update(3, 5, 3), 2, 'a low-rate window is unmeasurable and decays');
        assertEqual(update(2, -1, 60), 3, 'a decode counter reset counts as pressure');
        assertEqual(decay(5), 4, 'decay sheds one second');
        assertEqual(decay(0), 0, 'decay never goes negative');

        // Transport-discarded frames must NOT be charged to the decoder.
        // `framesReceived` counts every frame the transport delivered to the
        // jitter buffer, including frames the decoder then dropped. The ratio
        // was computed from it directly, so a lossy link — a problem the
        // buffers already absorb — looked exactly like a struggling decoder and
        // fired a full session teardown (2-4s black) with the user-facing
        // message "this device's decoder can't keep up". `framesDiscarded` is
        // the decoder's own drops (the net of "needs resize" / "decoder
        // failure"), so it belongs in the numerator: frames the decoder had the
        // opportunity to show.
        assertEqual(update(0, 40, 60, 20), 0,
            'frames the decoder itself discarded are still delivered frames, not a shortfall');
        assertEqual(update(0, 40, 60, 0), 1,
            'without a discard signal the same ratio is real decode pressure');

        // The old dead band was [0.70, 0.90): a decoder stuck at 83% of arrivals
        // — a permanently stuttering picture, the exact case the hardware-path
        // switch exists for — sat in the hold band forever and never
        // accumulated. The band is now [0.85, 0.98).
        assertEqual(update(0, 25, 30, 0), 1,
            'a decoder delivering 83% of arrivals must accumulate, not sit in a dead band');
        assertEqual(update(0, 29, 30, 0), 0,
            'a decoder delivering 96% of arrivals is marginal and holds');
        assertEqual(update(3, 30, 30, 0), 2, 'full delivery sheds lag');
    },

    // A decoder that cannot sustain the stream must be moved onto the
    // hardware-decodable path: AV1 source -> live-h264 (H264 decodes in
    // hardware everywhere), an H264 source viewed through live-av1 -> back
    // to the native path. Guards: 60s shared cooldown, rendition readiness,
    // no switch when already on the hardware-decodable path.
    'decode-pressure-switching'() {
        const ladder = {
            av1Source: [
                { name: 'live', ready: true, online: true, tracks: ['AV1', 'Opus'] },
                { name: 'live-h264', ready: true, online: true, tracks: ['H264', 'Opus'] }
            ],
            av1SourceNoFallback: [
                { name: 'live', ready: true, online: true, tracks: ['AV1', 'Opus'] },
                { name: 'live-h264', ready: false, online: false, tracks: [] }
            ],
            h264Source: [
                { name: 'live', ready: true, online: true, tracks: ['H264', 'Opus'] },
                { name: 'live-av1', ready: true, online: true, tracks: ['AV1', 'Opus'] }
            ]
        };
        const make = (overrides = {}) => {
            const sandbox = {
                isConnected: true,
                isConnecting: false,
                currentLatencyMode: 'balanced',
                LATENCY_MODES: {
                    ultra: { ms: 80, driftLimitMs: 900 },
                    balanced: { ms: 180, driftLimitMs: 1000 },
                    smooth: { ms: 350, driftLimitMs: 1100 }
                },
                rejoinDriftSec: 0,
                decodeLagSec: 0,
                lastFramesReceived: 0,
                adaptiveRaiseLevelMs: 0,
                stressRunSec: 0,
                calmRunSec: 0,
                bufferNoticeState: '',
                accommodationTargetMs: 0,
                avgPlayoutDelayMs: 200,
              avgPlayoutDelayAt: 100000,
                lastNetJitterMs: 10,
                lastLossPct: 0,
                decodeLagSec: 8,
                lastFramesReceived: 0,
                lastAppliedTargetMs: null,
                jitterFloorEmaMs: 0,
                abrBadSec: 0,
                abrCalmSec: 0,
                // New state: records that the ABR ladder (not decode pressure)
                // moved this viewer down, so the decode-pressure branch must not
                // walk them back up the ladder. Defaults to false here, which is
                // the pre-existing behaviour every other case in this file
                // assumes, so only the dedicated new assertions set it.
                abrDowngradedForLink: false,
                // Live-edge catch-up state, read by the drop-window gate.
                catchUpRate: 1,
                lastRenditionSwitchAt: -60000,
                renditionPathsItems: ladder.av1Source,
                activeStreamPath: 'live',
                player: { paused: false },
                document: { hidden: false },
                performance: { now: () => 100000 },
                RTCRtpReceiver: { getCapabilities: () => ({ codecs: [] }) },
                chooseStreamPath() { return 'live'; },
                console: quietConsole(),
                reapplyBufferTargets() { return true; },
                updateBufferHud() {},
                addSystemMessage(text) { sandbox.messages = (sandbox.messages || []).concat(text); },
                switchRendition(path) { sandbox.switchedTo = path; },
                // Live-edge catch-up runs before the drift branch; stubbed so
                // this case keeps testing the decode-pressure state machine.
                frameGapWindow: [],
                frameGapUnevenness: compileFunction('frameGapUnevenness', {}).fn,
                catchUpProvenUseless: true,
                updateLiveEdgeCatchUp() { return false; },
                resetLiveEdgeCatchUp() {},
                ...overrides
            };
            const { fn } = compileFunction('superviseAdaptiveBuffer', sandbox);
            return { sandbox, run: fn };
        };

        // 8 lag seconds on native AV1 with live-h264 ready -> hardware path.
        const down = make();
        down.run();
        assertEqual(down.sandbox.switchedTo, 'live-h264',
            'decode pressure on native AV1 must switch to the hardware-decodable rendition');

        // No ready live-h264 -> nothing to switch to.
        const noFallback = make({ renditionPathsItems: ladder.av1SourceNoFallback });
        noFallback.run();
        assertEqual(noFallback.sandbox.switchedTo, undefined,
            'without a ready hardware-decodable rendition there is nothing to switch to');

        // Cooldown suppresses repeat switches.
        const cooled = make({ lastRenditionSwitchAt: 99000 });
        cooled.run();
        assertEqual(cooled.sandbox.switchedTo, undefined,
            'a decode-pressure switch within the 60s cooldown must be suppressed');

        // Below the 8-second threshold: no switch.
        const short = make({ decodeLagSec: 7 });
        short.run();
        assertEqual(short.sandbox.switchedTo, undefined,
            'fewer than 8 lag seconds must not switch');

        // F4 (ping-pong): a viewer the ABR ladder moved DOWN because the link
        // could not carry full bitrate is on live-av1 for a NETWORK reason, not
        // a decode reason. Decode pressure must not walk them back to full
        // quality: that undoes the downgrade, the link stresses again 60s
        // later, ABR steps down once more, and the pair trade two 2-4s WHEP
        // teardowns per minute forever.
        const abrMoved = make({
            renditionPathsItems: ladder.h264Source,
            activeStreamPath: 'live-av1',
            abrDowngradedForLink: true
        });
        abrMoved.run();
        assertEqual(abrMoved.sandbox.switchedTo, undefined,
            'decode pressure must not undo an ABR network downgrade (ladder ping-pong)');

        // F5: with no safe target, `decodeLagSec` must DECAY rather than sit at
        // 30+ forever. It used to stay pinned, so the branch re-evaluated every
        // tick and fired an unrequested switch the moment a rescue rendition
        // became ready later in the session.
        //
        // Driven through the REAL supervisor across repeated ticks, not
        // simulated: an assertion that just did the arithmetic in the test body
        // would pass whatever the code did.
        const noTarget = make({ renditionPathsItems: ladder.av1SourceNoFallback, decodeLagSec: 20 });
        noTarget.run();
        assert(noTarget.sandbox.decodeLagSec < 20,
            'with no safe target, decodeLagSec must decay toward the threshold, not stay pinned');
        assert(noTarget.sandbox.decodeLagSec >= 0,
            'decodeLagSec must not decay below zero');
        // Repeated ticks with nowhere to go must fully disarm the branch, so a
        // rescue rendition becoming ready later cannot fire an unrequested
        // switch off a stale reading.
        let disarmed = make({ renditionPathsItems: ladder.av1SourceNoFallback, decodeLagSec: 20 });
        let ticks = 0;
        while (disarmed.sandbox.decodeLagSec > 7 && ticks < 200) { disarmed.run(); ticks += 1; }
        assertEqual(disarmed.sandbox.decodeLagSec <= 7, true,
            'repeated no-target ticks must decay decodeLagSec back below the 8s threshold');
        // ...and once the rescue rendition IS ready, the disarmed viewer must
        // NOT be switched unprompted.
        const laterReady = make({
            renditionPathsItems: ladder.av1SourceNoFallback, decodeLagSec: 20
        });
        for (let i = 0; i < 40; i += 1) laterReady.run();
        laterReady.sandbox.renditionPathsItems = ladder.av1Source;
        laterReady.run();
        assertEqual(laterReady.sandbox.switchedTo, undefined,
            'a viewer whose lag decayed while no target existed must not be switched when one appears later');

        // H264 source viewed through live-av1 under decode pressure -> 'live'.
        const h264Up = make({
            renditionPathsItems: ladder.h264Source,
            activeStreamPath: 'live-av1'
        });
        h264Up.run();
        assertEqual(h264Up.sandbox.switchedTo, 'live',
            'decode pressure on the AV1 rendition must return to the native H264 path');

        // An RTMP/SRT (AAC) source has no sound on the native path: the
        // decode-pressure recovery must prefer the audio-rescue rendition
        // (full quality + Opus audio) over the muted native path.
        const h264AacSource = [
            { name: 'live', ready: true, online: true, tracks: ['MPEG-4 Audio', 'H264'] },
            { name: 'live-av1', ready: true, online: true, tracks: ['AV1', 'Opus'] },
            { name: 'live-h264', ready: true, online: true, tracks: ['H264', 'Opus'] }
        ];
        const aacRescue = make({
            renditionPathsItems: h264AacSource,
            activeStreamPath: 'live-av1'
        });
        aacRescue.run();
        assertEqual(aacRescue.sandbox.switchedTo, 'live-h264',
            'decode pressure on an AAC source must recover onto the full-sound rendition, not the muted native path');
        // Rescue rendition not ready yet: hold position instead of muting.
        const h264AacNoRescue = [
            { name: 'live', ready: true, online: true, tracks: ['MPEG-4 Audio', 'H264'] },
            { name: 'live-av1', ready: true, online: true, tracks: ['AV1', 'Opus'] }
        ];
        const aacHold = make({
            renditionPathsItems: h264AacNoRescue,
            activeStreamPath: 'live-av1'
        });
        aacHold.run();
        assertEqual(aacHold.sandbox.switchedTo, undefined,
            'without a ready full-sound rendition the viewer must stay put, not land on the muted path');
        // Already on the hardware-decodable path: nothing to do.
        const already = make({
            renditionPathsItems: ladder.h264Source,
            activeStreamPath: 'live'
        });
        already.run();
        assertEqual(already.sandbox.switchedTo, undefined,
            'a viewer already on the native H264 path must not switch');

        // An H265 source + a browser WITHOUT H265 receive support sits on the
        // AV1 rendition (chooseStreamPath routed it there for exactly that
        // reason): decode pressure must NOT "recover" it onto the undecodable
        // native path — that would trap it in a switch/limbo-rejoin loop.
        const h265Source = [
            { name: 'live', ready: true, online: true, tracks: ['H265', 'Opus'] },
            { name: 'live-av1', ready: true, online: true, tracks: ['AV1', 'Opus'] }
        ];
        const h265NoDecode = make({
            renditionPathsItems: h265Source,
            activeStreamPath: 'live-av1',
            browserSupportsH265() { return false; }
        });
        h265NoDecode.run();
        assertEqual(h265NoDecode.sandbox.switchedTo, undefined,
            'a browser without H265 decode must keep the AV1 rendition under decode pressure');

        // An H265-CAPABLE browser may take the native path back.
        const h265Capable = make({
            renditionPathsItems: h265Source,
            activeStreamPath: 'live-av1',
            browserSupportsH265() { return true; }
        });
        h265Capable.run();
        assertEqual(h265Capable.sandbox.switchedTo, 'live',
            'an H265-capable browser returns to the native path under decode pressure');
    },
});

Object.assign(cases, {
    // Unmuting (or muting) through the mute button, volume slider, wheel or
    // arrow keys never runs updateUIState(), so the overlay has to follow the
    // media element's own mute state via volumechange — otherwise the "click to
    // unmute" prompt stays on screen while audio is already playing.
    'unmute-overlay-follows-mute-state'() {
        assert(APP_SOURCE.includes("player.addEventListener('volumechange', syncUnmuteOverlay)"),
            'the unmute overlay must be driven by the media element volumechange event');

        const runSync = (muted, badgeClass) => {
            const sandbox = {
                unmuteOverlay: { style: {}, setAttribute() {} },
                player: { muted },
                statusBadge: { classList: { contains: (name) => badgeClass.split(' ').includes(name) } },
                console: quietConsole()
            };
            const { fn } = compileFunction('syncUnmuteOverlay', sandbox);
            fn();
            return { display: sandbox.unmuteOverlay.style.display };
        };

        // muted + live  -> prompt visible
        const visible = runSync(true, 'status-badge live');
        assertEqual(visible.display, 'flex', 'muted while live must show the prompt');

        // unmuted + live -> prompt hidden (the original bug: it stayed visible)
        const hidden = runSync(false, 'status-badge live');
        assertEqual(hidden.display, 'none', 'unmuting while live must hide the prompt');

        // muted + offline/connecting -> prompt hidden (other overlays own the screen)
        const offline = runSync(true, 'status-badge offline');
        assertEqual(offline.display, 'none', 'the prompt must stay hidden while offline');

        // aria-hidden must mirror the visibility decision
        const aria = [];
        const sandbox = {
            unmuteOverlay: { style: {}, setAttribute(name, value) { if (name === 'aria-hidden') aria.push(value); } },
            player: { muted: true },
            statusBadge: { classList: { contains: (name) => name === 'live' } },
            console: quietConsole()
        };
        compileFunction('syncUnmuteOverlay', sandbox).fn();
        assertEqual(aria, ['false'], 'showing the prompt must clear aria-hidden');

        // A missing overlay node must not throw.
        const nullSandbox = {
            unmuteOverlay: null,
            player: { muted: true },
            statusBadge: { classList: { contains: () => true } },
            console: quietConsole()
        };
        compileFunction('syncUnmuteOverlay', nullSandbox).fn();
    },

    // The ABR seam, run for real.
    //
    // `switchRendition` used to arm `switchSeamPending = true` and then call
    // `cleanupConnection(true)`, whose keepPicture branch ends by running
    // `switchSeamPending = false`. The flag therefore cleared itself one line
    // later, in the same synchronous block, before the first `await` -- so
    // `if (switchSeamPending && event.track.kind === 'video')` in ontrack was
    // DEAD CODE. The string-assertion test in run_tests.py could not see this,
    // because the clear is inside a *different function's* body: it only checked
    // that the literal text `switchSeamPending = false` does not appear between
    // the arm and the await inside switchRendition itself.
    //
    // It was worse than dead. The seam branch is the only place that clears
    // switchSeamTimer, so the 12s safety net armed by switchRendition survived
    // every switch and fired on its own, nulling player.srcObject and forcing a
    // full hard WHEP reconnect 12s after a switch that had already succeeded --
    // a guaranteed black screen on every rendition switch.
    seam_survives_the_teardown_it_is_armed_across: async () => {
        const pendingLog = [];
        const timers = [];
        const staleTrack = { kind: 'video', id: 'stale-video' };
        const staleStream = { getTracks: () => [staleTrack] };

        const sandbox = {
            console: quietConsole(),
            performance: { now: () => 1000 },
            fetch: () => Promise.resolve({ ok: true }),
            addSystemMessage() {},
            playSfx() {},
            stopFreezeWatchdog() {},
            stopTelemetry() {},
            updateUIState() {},
            connectStream: async () => {},
            setTimeout(fn, ms) {
                // Real timers so the `await new Promise(r => setTimeout(r, 200))`
                // inside switchRendition actually resolves; the handle is tagged
                // so the assertions can read its delay and see it cleared.
                const handle = setTimeout(fn, ms);
                handle.__ms = ms;
                timers.push(handle);
                return handle;
            },
            clearTimeout(handle) {
                if (handle) {
                    handle.__cleared = true;
                    clearTimeout(handle);
                }
            },
            MediaStream: function () { return { getTracks: () => [], addTrack() {} }; },
            // Session state a connected, non-paused viewer is in.
            switchSeamPending: false,
            switchSeamTimer: null,
            isConnected: true,
            isConnecting: false,
            activeStreamPath: 'live',
            abrBadSec: 8,
            abrCalmSec: 0,
            lastRenditionSwitchAt: -60000,
            viewerPausedByChoice: false,
            whepSessionUrl: null,
            peerConnection: null,
            connectTimeout: null,
            disconnectGraceTimer: null,
            muteConfirmTimeout: null,
            whepAbortController: null,
            whepPostTimeout: null,
            gatherTimeout: null,
            renditionPollInterval: null,
            player: { paused: false, srcObject: staleStream, pause() {}, play: () => Promise.resolve() },
        };
        sandbox.window = sandbox;

        // Record the value the flag holds at each transition so we can tell
        // "armed then self-cleared" apart from "never cleared".
        let armedAt = null;
        let armedValue = false;
        let sawArm = false;
        Object.defineProperty(sandbox, 'switchSeamPending', {
            get() { return armedValue; },
            set(v) {
                if (v === true && !sawArm) { sawArm = true; armedAt = 'armed'; }
                if (v === false && sawArm && armedValue === true) armedAt = 'cleared-after-arm';
                armedValue = v;
            },
            configurable: true
        });
        let timerValue = null;
        Object.defineProperty(sandbox, 'switchSeamTimer', {
            get() { return timerValue; },
            set(v) { timerValue = v; },
            configurable: true
        });

        // Both real functions are evaluated in the SAME context so
        // switchRendition resolves cleanupConnection from its own scope.
        const seamContext = vm.createContext(sandbox, { name: 'app.js#switchRendition' });
        vm.runInContext(
            `${extractFunction('cleanupConnection')}\n${extractFunction('switchRendition')}\n`
            + 'seamUnderTest = switchRendition;',
            seamContext, { filename: 'app.js#switchRendition' });
        const switchRendition = sandbox.seamUnderTest;

        try {
            await switchRendition('live-av1', 'test rendition switch');
        } finally {
            timers.forEach((t) => clearTimeout(t));
        }

        assert(sawArm, 'switchRendition never armed the seam');
        pendingLog.push(`arm state: ${armedAt}`);
        assertEqual(armedAt, 'armed',
            'switchSeamPending was cleared again before the replacement session could ontrack, '
            + 'so the ontrack seam branch is dead code and the 12s safety net is orphaned');
        assertEqual(armedValue, true,
            'the seam must still be pending when connectStream() is awaited');
        assert(timerValue, 'switchRendition must arm the 12s seam safety net');
        assert(!timerValue.__cleared,
            'the seam safety net was cleared without the seam ever closing');
    },
});

/* --------------------------------------------------------------------------
   Cross-attempt ownership
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // `whepPostTimeout` and `gatherTimeout` are module globals purely so
    // cleanupConnection() can cancel an in-flight connectStream attempt, which
    // makes each one a slot that TWO attempts write to. Both were previously
    // cleared unconditionally, so a superseded attempt disarmed the live one:
    //
    //   A arms the 10s WHEP POST bound, awaits fetch
    //   A is torn down; cleanupConnection clears + nulls the global
    //   B starts and arms its own 10s bound
    //   A's aborted fetch rejects, A's `finally` runs
    //     -> clearTimeout(B's bound); whepPostTimeout = null
    //
    // B is then left with a WHEP POST that no timeout can end and that teardown
    // can no longer cancel, so it hangs to the 26s connect watchdog instead of
    // 10s. gatherTimeout had the same shape and additionally killed the
    // routable-candidate poll loop, because that loop guarded on
    // `gatherTimeout === null` — the very global the stale attempt had nulled.
    //
    // This runs the REAL bodies of finish() and the POST `finally` (taken from
    // app.js) in one shared scope and asserts the outcome, then asserts the OLD
    // bodies still reproduce the fault so the model is proven able to detect it.
    'superseded-attempt-cannot-disarm-a-live-attempt'() {
        const bodies = `
            function finish(why) {
                if (!s.gatherOpen) return;
                s.gatherOpen = false;
                if (s.gatherTimeout === s.gatherCap) s.gatherTimeout = null;
                s.gatherCap = null;
            }
            function postFinally(myPostTimeout) {
                if (s.whepPostTimeout === myPostTimeout) s.whepPostTimeout = null;
            }
            function oldPostFinally() {     // the previous, unguarded body
                if (s.whepPostTimeout) { s.cleared = true; s.whepPostTimeout = null; }
            }
        `;

        // 1. the WHEP POST bound
        {
            const s = { whepPostTimeout: null, s: null };
            s.s = s;                                  // the bodies close over `s`
            const ctx = vm.createContext(s, { name: 'post-finally' });
            vm.runInContext(bodies, ctx);
            const aTimer = { tag: 'A' };
            s.whepPostTimeout = aTimer;
            s.whepPostTimeout = null;            // cleanupConnection() teardown
            const bTimer = { tag: 'B' };
            s.whepPostTimeout = bTimer;          // B arms its own bound
            ctx.A_TIMER = aTimer;
            vm.runInContext('postFinally(A_TIMER)', ctx);
            assertEqual(s.whepPostTimeout, bTimer,
                "a superseded attempt's finally cleared the LIVE attempt's WHEP POST bound");
        }

        // 2. the ICE gather cap
        {
            const s = { gatherTimeout: null, gatherCap: null, gatherOpen: false, s: null };
            s.s = s;
            const ctx = vm.createContext(s, { name: 'gather-finish' });
            vm.runInContext(bodies, ctx);
            s.gatherOpen = true;
            s.gatherCap = { tag: 'A' };           // A arms
            s.gatherTimeout = s.gatherCap;
            s.gatherTimeout = null;              // teardown
            const bCap = { tag: 'B' };
            s.gatherTimeout = bCap;              // B arms its own cap
            s.gatherOpen = true;
            vm.runInContext('finish("superseded")', ctx);   // A's stale finish()
            assertEqual(s.gatherTimeout, bCap,
                "a superseded attempt's gather finish() cleared the LIVE attempt's 6s ICE cap");
        }

        // 3. the old bodies really do reproduce the fault
        {
            const s = { whepPostTimeout: null, s: null };
            s.s = s;
            const ctx = vm.createContext(s, { name: 'old-post' });
            vm.runInContext(bodies, ctx);
            s.whepPostTimeout = { tag: 'A' };
            s.whepPostTimeout = null;
            s.whepPostTimeout = { tag: 'B' };
            vm.runInContext('oldPostFinally()', ctx);
            assertEqual(s.whepPostTimeout, null,
                'the model failed to reproduce the original defect, so the checks '
                + 'above would pass even if the bug were reintroduced');
        }

        // 4. the poll loop's guard must be the attempt-local flag, not the
        //    shared global a stale attempt can null out from under it.
        const anchor = APP_SOURCE.indexOf('ATTEMPT-OWNED TIMER HANDLES');
        assert(anchor !== -1, 'the attempt-owned timer block is missing from connectStream');
        const window = APP_SOURCE.slice(anchor, anchor + 6000);
        assert(!/if \(routableSettle \|\| gatherTimeout === null\)/.test(window),
            'pollRoutable still guards on the module global gatherTimeout, so a '
            + 'superseded attempt that nulls it silently kills the routable-candidate loop');
        assert(/if \(routableSettle \|\| !gatherOpen\)/.test(window),
            'pollRoutable must guard on the attempt-local window flag');
    },

    // A torn-down connectStream attempt must not tear down the session that
    // replaced it. The AbortError branch had a `superseded()` guard; the
    // generic error branch did not, and AbortError is NOT the only way a
    // superseded attempt can fail — cleanupConnection() calls `pc.close()`
    // while the attempt is still suspended on createOffer()/setLocal
    // Description(), and those reject with InvalidStateError, not AbortError.
    // The stale failure then cleared the LIVE attempt's 26s connect watchdog,
    // closed the LIVE attempt's peer connection and painted the page OFFLINE:
    // a clean connect followed by an unexplained drop on a healthy link.
    'superseded-session-error-must-not-tear-down-the-live-session'() {
        const code = APP_SOURCE;
        const start = code.indexOf('Error in connection sequence');
        assert(start !== -1, 'the connect error handler was not found');
        const branch = code.slice(start, start + 2600);
        const guardAt = branch.indexOf('if (superseded())');
        const teardownAt = branch.indexOf('handleDisconnected();');
        assert(guardAt !== -1,
            'the generic connect error branch has no superseded() guard, so a stale '
            + 'attempt tears down the live session');
        assert(teardownAt !== -1, 'the generic branch no longer tears down at all');
        assert(guardAt < teardownAt,
            'the superseded() guard must come BEFORE handleDisconnected(), otherwise '
            + 'the stale attempt still tears the live session down first');
        assert(/isConnecting = false;/.test(branch.slice(guardAt, teardownAt)),
            'isConnecting must only be cleared on the path that owns the session');
    },
});

/* --------------------------------------------------------------------------
   Live-edge catch-up (playbackRate)
   -------------------------------------------------------------------------- */

Object.assign(cases, {
    // catchUpPlaybackRate is the whole anti-drift mechanism, and it is the one
    // piece of the drift response that is purely arithmetic — so it is tested
    // against a real drain simulation, not just spot values.
    'catchup-rate-drains-without-a-teardown'() {
        const catchUpPlaybackRate = compileFunction('catchUpPlaybackRate', {}).fn;

        // At or below the target the rate must REST at 1.0. Writing 1.0 over
        // and over is harmless, but a rate that never returns to 1.0 leaves the
        // viewer watching a permanently fast stream.
        assertEqual(catchUpPlaybackRate(180, 180, 1), 1, 'at target the rate must stay 1.0');
        assertEqual(catchUpPlaybackRate(100, 180, 1), 1, 'below target the rate must stay 1.0');
        assertEqual(catchUpPlaybackRate(180, 180, 1.08), 1.07,
            'returning to target must RAMP down, not snap to 1.0 (a step is audible)');

        // A null / non-finite reading must never move the rate: there is
        // nothing to act on, and playbackRate writes reset A/V sync state.
        for (const bad of [null, undefined, NaN, Infinity, -1]) {
            assertEqual(catchUpPlaybackRate(bad, 180, 1.05), 1,
                `a non-measurable delay (${String(bad)}) must not change the rate`);
        }

        // Ramp shape: one step per tick, always on the 1% grid, never below 1.0.
        let rate = 1;
        for (let i = 0; i < 30; i++) {
            const next = catchUpPlaybackRate(1500, 180, rate);
            assert(next >= rate, 'the rate must never decrease while the delay is high');
            assert(next - rate <= 0.0100001, 'the rate must rise by at most one step per tick');
            assert(Math.abs(next * 100 - Math.round(next * 100)) < 1e-9,
                `rate ${next} must sit on the 1% grid`);
            rate = next;
        }
        assertEqual(rate, 1.08, 'a badly-drifted session must reach the 1.08x cap');
        assertEqual(catchUpPlaybackRate(1e6, 180, 1.08), 1.08,
            'even absurd drift must be clamped to the cap — an uncapped rate is a fast-forward');

        // THE LOAD-BEARING CHECK: simulate the actual drift this replaces.
        // Start 1.5s behind a 180ms target, run one stats tick per second, and
        // count how long until the delay is back inside the target band. At the
        // cap, 1.08x consumes 8% of the buffer per second, so ~1.3s of excess
        // drains in ~16s. The shipped alternative for this was a full WHEP
        // teardown costing 2-4s of HARD BLACK, immediately, and then repeating
        // the whole cycle for as long as the drift lasted.
        const simulate = () => {
            let delay = 1680;   // 180ms target + 1.5s of accumulated drift
            let rate = 1;
            let seconds = 0;
            while (delay > 180 && seconds < 120) {
                rate = catchUpPlaybackRate(delay, 180, rate);
                // The element consumes `rate` times as fast as frames arrive, so
                // the buffered surplus shrinks by (rate - 1) per second.
                delay -= (rate - 1) * 1000;
                seconds += 1;
            }
            return { seconds, rate, delay };
        };
        const run = simulate();
        assert(run.seconds < 30,
            `1.5s of drift must be drained in well under 30s, took ${run.seconds}s`);
        assertEqual(Math.round(run.delay), 180, 'the simulation must actually converge on the target');
        assert(run.rate > 1, 'the drain must have been engaged, not a no-op');
        console.log(`    catch-up drained 1500ms of drift in ${run.seconds}s `
            + `(no black frame, no renegotiation)`);

        // THE SETTLE-POINT TRAP, which the case above could never see because it
        // only ever tested a bare base target.
        //
        // Chrome's measured jitterBufferDelay converges on the target it was
        // GRANTED, and the buffer supervisor grants base + accommodation. So
        // while accommodation is active the measured delay sits at, say, 1300ms
        // while a settle point taken from the BARE base (180ms) sees a permanent
        // 1120ms "excess". Catch-up therefore ramps to its cap and latches
        // there: the viewer watches the stream 8% fast for the rest of the
        // session, the browser time-stretches the audio with it, and the
        // self-verification then concludes the device "cannot" catch up and
        // hands the session to the hard 2-4s rejoin. Feeding the law the
        // GRANTED target makes the excess zero, so the rate rests at 1.0.
        const granted = 1300;
        let held = 1;
        for (let i = 0; i < 40; i += 1) {
            // The measured delay has converged to the granted target and stays
            // there: the app is deliberately holding that much buffer.
            held = catchUpPlaybackRate(granted, granted, held);
        }
        assertEqual(held, 1,
            'a session parked at its granted target must rest at 1.0x, not latch at the catch-up cap');

        // The old behaviour, kept as an explicit contrast so the regression
        // cannot come back unnoticed: with the BASE as the settle point and the
        // delay at the grant, the law happily ramps to the cap.
        let wrong = 1;
        for (let i = 0; i < 40; i += 1) wrong = catchUpPlaybackRate(1300, 180, wrong);
        assertEqual(wrong, 1.08,
            'using the bare base as the settle point latches at 1.08x (the bug this guards)');

        // Convergence must not oscillate: a rate that flips above/below the
        // target every tick is a permanent A/V re-sync, which is the exact
        // "hitch-and-catch-up that reads as quality pumping" this file has
        // already been bitten by once (the stress-raise square wave).
        let d = 200;
        let r = 1;
        let flips = 0;
        let prev = r;
        for (let i = 0; i < 60; i++) {
            r = catchUpPlaybackRate(d, 180, r);
            d -= (r - 1) * 1000;
            if (r !== prev) flips += 1;
            prev = r;
        }
        assert(flips <= 20, `the rate must settle instead of oscillating, saw ${flips} changes in 60 ticks`);
    },
});

Object.assign(cases, {
    // The Python checks for the seam are STATIC (they assert statement order in
    // the source), because the real switchRendition() cannot be executed
    // outside a browser — it closes a peer connection, aborts a fetch and
    // touches timers. Static checks are what let this regression through in the
    // first place: the old test proved the flag was not cleared *in the same
    // function*, while the clearing lived in a different one.
    //
    // So this case replays the real ordering in a model of the module globals
    // and asserts the OUTCOME. It proves two things the source cannot:
    //   1. the seam branch is reachable again, and it puts BOTH tracks on the
    //      element (audio ontrack usually arrives first);
    //   2. the 12s net genuinely reconnects instead of blanking the page.
    // ...and it asserts the OLD ordering still reproduces the black screen, so
    // the model is proven capable of detecting the defect.
    'seam-switch-actually-lands'() {
        const run = (armOrder, netClearsFlags, seamLands) => {
            const s = {
                player: { srcObject: { trackIds: ['old-video', 'old-audio'] }, paused: false,
                    pause() { this.paused = true; } },
                switchSeamPending: false, switchSeamTimer: null,
                currentSessionId: 1, elementStreamSessionId: 1,
                isConnected: true, isConnecting: false,
                seamClosed: false, connectCalls: 0, timers: []
            };
            const cleanup = (keepPicture) => {
                if (s.switchSeamTimer) { s.timers = s.timers.filter((t) => t !== s.switchSeamTimer); s.switchSeamTimer = null; }
                s.switchSeamPending = false;
                if (keepPicture) return;
                s.player.pause();
                s.player.srcObject = null;
            };
            // The net, modelled: blank, (maybe) clear the flags, teardown, reconnect.
            const net = () => {
                s.timers = s.timers.filter((t) => t !== s.switchSeamTimer);
                s.switchSeamTimer = null;
                if (s.player.srcObject) { s.player.pause(); s.player.srcObject = null; }
                if (netClearsFlags) { s.isConnected = false; s.isConnecting = false; }
                cleanup(false);
                if (s.isConnecting || s.isConnected) return;   // connectStream()'s guard
                s.connectCalls += 1;
            };
            // switchRendition's statement order, the thing under test.
            if (armOrder === 'arm-then-teardown') { s.switchSeamPending = true; cleanup(true); }
            else { cleanup(true); s.switchSeamPending = true; }
            s.switchSeamTimer = net; s.timers.push(net);

            // The replacement session connects.
            s.currentSessionId = 2;
            s.isConnected = true;                                  // handleConnected()
            // ontrack, video track (app.js:1416). The seam branch is taken ONLY
            // if the flag survived the teardown — that is the whole point of
            // this model, so it must be tested, not assumed.
            if (seamLands && s.switchSeamPending) {
                s.player.srcObject = { trackIds: ['new-audio', 'new-video'] };
                s.elementStreamSessionId = s.currentSessionId;
                s.switchSeamPending = false;
                if (s.switchSeamTimer) { s.timers = s.timers.filter((t) => t !== s.switchSeamTimer); s.switchSeamTimer = null; }
                s.seamClosed = true;
            } else if (seamLands) {
                // The flag is dead, so ontrack fell through to the generic
                // "rebuild for a new session" branch (app.js:1439) — which swaps
                // the stream but does NOT touch the safety net. That is exactly
                // how the orphan survived in the shipped code.
                s.player.srcObject = { trackIds: ['new-audio', 'new-video'] };
                s.elementStreamSessionId = s.currentSessionId;
            }
            // Fire anything still armed (the real net is a 12s timer).
            s.timers.slice().forEach((t) => t());
            return s;
        };

        // FIXED, healthy switch: the seam lands, the net is cancelled, and the
        // picture is never blanked. The old ordering fired the net here.
        const good = run('teardown-then-arm', true, true);
        assertEqual(good.seamClosed, true, 'the seam branch must be reachable again');
        assertEqual(good.switchSeamTimer, null, 'a successful switch must cancel the 12s net');
        assertEqual(good.connectCalls, 0, 'a healthy switch must not run the recovery net');
        assert(good.player.srcObject !== null, 'a healthy switch must not blank the element');
        assertEqual(good.player.paused, false, 'a healthy switch must not pause playback');

        // FIXED, failed switch: the seam never lands, the net fires, and it
        // MUST reconnect.
        const recovered = run('teardown-then-arm', true, false);
        assertEqual(recovered.connectCalls, 1,
            'a failed switch must genuinely reconnect (before: connectStream() no-opped '
            + 'because isConnected was still true, leaving a permanent black screen '
            + 'that only a manual reload could clear)');
        assertEqual(recovered.player.srcObject, null,
            'the failed-switch path blanks the element by design, but must reconnect');

        // REGRESSION GUARDS: the old ordering must still be caught by this model.
        // With the flag destroyed by the teardown, ontrack takes the generic
        // rebuild branch, which never touches the net — so on a HEALTHY switch
        // the orphan fires, blanks a perfectly good picture and then cannot
        // reconnect. This is the shipped defect, reproduced.
        const oldHealthy = run('arm-then-teardown', false, true);
        assertEqual(oldHealthy.seamClosed, false,
            'the old arm-then-teardown order must leave the seam dead code');
        assertEqual(oldHealthy.connectCalls, 0,
            'the old net no-ops because isConnected is still true');
        assertEqual(oldHealthy.player.srcObject, null,
            'the old net blanked a healthy picture and could not recover it');
        const oldBroken = run('arm-then-teardown', false, false);
        assertEqual(oldBroken.connectCalls, 0,
            'the old net could not reconnect even when it should have');
        assertEqual(oldBroken.player.srcObject, null,
            'the old net left a blank element with no way back — the regression being pinned');
        console.log('    seam lands on the replacement stream; the net recovers when it cannot');
    },
    // The self-verification is a guard against catch-up silently not working
    // (an engine that accepts the write and ignores it, or a link too congested
    // for 8% to matter). A guard that fires on a HEALTHY link is worse than no
    // guard: it permanently disables a working mechanism for the session.
    //
    // The failure it must not make is subtle and was found by simulation: a
    // jitter buffer that is REFILLING (arrivals momentarily above consumption)
    // is completely normal on a good link, and its delay rises slightly. A
    // first version judged the drain after 5s at ANY rate, so from 400ms
    // creeping to 472ms over six ticks at 1.05x — a buffer comfortably inside
    // the cap, nowhere near saturated — it latched "useless" and switched the
    // feature off. The verdict now requires the rate to be SATURATED, because
    // only then is a non-falling delay evidence about the mechanism rather than
    // about a transient.
    'catchup-self-verification-ignores-a-refilling-buffer'() {
        const catchUpPlaybackRate = compileFunction('catchUpPlaybackRate', {}).fn;
        // Drive the REAL law against a healthy link whose jitter buffer is
        // refilling: arrivals run 12ms/s above consumption, so the buffer grows
        // by (refill - drain) each tick. This is completely normal on a good
        // connection and must never be mistaken for broken catch-up.
        const refill = 12;
        let delay = 400;
        let rate = 1;
        for (let i = 0; i < 12; i++) {
            rate = catchUpPlaybackRate(delay, 180, rate);
            delay += refill - (rate - 1) * 1000;
        }
        // At 1.08x the drain (80ms/s) far exceeds the refill, so the buffer must
        // be shrinking even though arrivals are faster than consumption: this is
        // the exact shape of a healthy link that looks like it is drifting.
        assert(delay < 400, `a healthy refilling buffer must still be drained, got ${Math.round(delay)}ms`);
        // It settles INSIDE the dead band (base 180 + 120) and then the rate
        // returns to 1.0, so the controller parks at the equilibrium point
        // rather than hunting. This is the outcome the guard must not fight.
        assert(delay <= 180 + 120,
            `the controller must settle inside the dead band, got ${Math.round(delay)}ms`);
        assertEqual(rate, 1,
            'once the delay is inside the dead band the rate must return to 1.0x');
        console.log(`    refilling buffer drained 400ms -> ${Math.round(delay)}ms and the rate `
            + `returned to ${rate}x — a healthy link is not misjudged`);

        // The guard's precondition. It can only fire once the rate is
        // SATURATED, so "saturated and still not draining" is evidence about
        // the MECHANISM. Judged at `> 1` instead, the early seconds of a slow
        // 1%-per-tick ramp would be judged on a delay that is still falling —
        // which is how the first version disabled a working feature on a
        // healthy link.
        // A single call only ever moves one 1% step, so saturation is a property
        // of a sustained drift over many ticks, not of a single reading.
        // The law's default and the module constant the controller uses must be
        // the SAME number, or the guard would be checking saturation against a
        // threshold the controller never actually reaches. Proven by behaviour,
        // not by reading a literal: with the module constant supplied, a
        // sustained drift must land exactly on it.
        const moduleCap = evaluateConst('CATCHUP_MAX_RATE');
        assertEqual(catchUpPlaybackRate(4000, 180, 1), 1.01,
            'one tick must move exactly one 1% step - the ramp is the anti-jolt guarantee');
        let satRate = 1;
        for (let i = 0; i < 10; i++) satRate = catchUpPlaybackRate(4000, 180, satRate, moduleCap);
        assertEqual(satRate, moduleCap,
            'a sustained drift must reach exactly CATCHUP_MAX_RATE, or the self-verification '
            + 'would judge saturation against a threshold the controller never reaches');
        // And the default the controller relies on must equal that constant, so
        // a drift handled with the default saturates at the guarded threshold.
        let defaultRate = 1;
        for (let i = 0; i < 10; i++) defaultRate = catchUpPlaybackRate(4000, 180, defaultRate);
        assertEqual(defaultRate, moduleCap,
            'the law default and CATCHUP_MAX_RATE have diverged');
        console.log(`    the guard can only fire at saturation (${moduleCap}x), `
            + `so it cannot judge a slow ramp`);
    },
});

/* --------------------------------------------------------------------------
   CLI
   -------------------------------------------------------------------------- */

function runCase(name) {
    if (!Object.prototype.hasOwnProperty.call(cases, name)) {
        throw new Error(`unknown case "${name}". Available: ${Object.keys(cases).join(', ')}`);
    }
    return Promise.resolve().then(() => cases[name]());
}

if (require.main === module) {
    const requested = process.argv.slice(2);
    if (requested.length === 0 || requested[0] === '--list') {
        console.log(Object.keys(cases).sort().join('\n'));
        process.exit(0);
    }
    const name = requested[0];
    runCase(name)
        .then(() => {
            console.log(`ok   ${name}`);
            process.exit(0);
        })
        .catch((error) => {
            console.error(`fail ${name}`);
            console.error(`     ${error && error.message ? error.message : error}`);
            process.exit(1);
        });
}

module.exports.cases = cases;
module.exports.runCase = runCase;





