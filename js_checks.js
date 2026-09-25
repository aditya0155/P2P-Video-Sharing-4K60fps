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
        assert(!vp9Out.includes('a=rtcp-fb:98'), 'feedback must only be injected for H264 payload types');
    },
};

/* --------------------------------------------------------------------------
   Stream polling / reconnect state machine
   -------------------------------------------------------------------------- */

function makePollSandbox(options = {}) {
    const calls = { fetch: [], ui: [], connect: 0, schedule: 0, json: 0 };
    const replies = (options.replies || []).slice();
    const sandbox = {
        isConnected: Boolean(options.isConnected),
        isConnecting: Boolean(options.isConnecting),
        reconnectAttempts: options.reconnectAttempts ?? 0,
        window: { location: { origin: 'http://127.0.0.1:3000' } },
        console: quietConsole(),
        updateUIState(state) { calls.ui.push(state); },
        schedulePoll() { calls.schedule++; },
        connectStream() { calls.connect++; },
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
   Unmute prompt synchronisation
   -------------------------------------------------------------------------- */

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
