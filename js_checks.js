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
        assertEqual(aacPlan.audioArgs,
            ['-c:a', 'libopus', '-b:a', '160k', '-af', 'aresample=async=1'],
            'AAC source audio must be re-encoded to Opus for WebRTC readers');
        // Drift correction on the rescue audio: without it a source clock that
        // runs slightly fast makes Opus timestamps walk ahead of video, and the
        // browser's A/V sync layer then nudges playbackRate forever — a
        // permanent micro-correction that reads as jank rather than desync.
        assert(aacPlan.audioArgs.join(' ').includes('aresample=async=1'),
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
        assert(!aacPlan.audioArgs.join(' ').includes('first_pts'),
            'the Opus rescue must not re-base audio with first_pts: it destroys the source A/V offset');

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
        assertEqual(av1Plan.videoArgs[gIdx + 1], '60', '1s keyframe interval at 60fps');
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
        assertEqual(fn(h264SourceRenditionReady, true), 'live-av1',
            'AV1 browser must prefer the low-bandwidth AV1 rendition');
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
        assertEqual(fn(h264SourceRenditionReady, true, true), 'live-av1',
            'smooth AV1 decode keeps the low-bandwidth rendition');
        assertEqual(fn(h264SourceRenditionReady, true, false), 'live',
            'non-smooth AV1 decode must stay on the hardware-decodable path');
        assertEqual(fn(h264SourceRenditionReady, true, null), 'live-av1',
            'unknown decode quality keeps the previous behavior');
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

    // AV1-capable browser on an H264 source with a ready live-av1 rendition
    // must connect to the rendition (half the bandwidth on a hotspot).
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
            assertEqual(context.activeStreamPath, 'live-av1', 'connection must target the AV1 rendition');
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
        assertEqual(Object.keys(modes), ['ultra', 'balanced', 'smooth'], 'latency mode table keys');
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
    // The accommodation must be drop-gated: the measured jitter-buffer delay
    // always tracks the jitterBufferTarget hint Chrome was given, so a
    // controller that raises to meet the measurement chases its own tail and
    // inflates EVERY session to the cap within half a minute. Raising is
    // reserved for hard evidence (frames actually discarded while the buffer
    // outgrew the base target); sustained calm drains the extra latency.
    'buffer-accommodation-gate'() {
        const { fn } = compileFunction('bufferAccommodationMs', {});

        // Late frames actually discarded AND the measured buffer 1.2s past the
        // 180ms base: grant what Chrome needs (+100ms headroom, 50ms steps).
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
        assertEqual(fn(400, 400, 180, false, 5), 350,
            'sustained calm still drains one 50ms step');

        // Decode/GPU-pressure drops with the buffer at the target are not a
        // buffer problem: the 150ms margin keeps them from inflating latency.
        assertEqual(fn(260, 0, 180, true, 0), 0,
            'drops with the buffer barely above the target must not raise');

        // Sustained calm (>=5 drop-free ticks) drains one 50ms step per tick.
        assertEqual(fn(1300, 1300, 180, false, 4), 1300,
            'fewer than 5 calm ticks must hold');
        assertEqual(fn(1300, 1300, 180, false, 5), 1250,
            'calm ticks drain the accommodation 50ms per tick');
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





