// Headless-Chrome WHEP receiver probe: real browser viewer -> MediaMTX.
// Dumps the actual getStats() a viewer sees, plus rVFC presentation cadence.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WHEP = process.env.WHEP_URL || 'http://127.0.0.1:3000/stream-api/live/whep';
const RUN_MS = Number(process.env.RUN_MS || 30000);
const PORT = Number(process.env.CDP_PORT || 9333);
// CDP_EXISTING=1 attaches to a Chrome already listening on CDP_PORT instead of
// spawning one. On this host Chrome needs ~10s to open its debug port, which is
// longer than a single command window allows, so the launcher starts it first.
const CDP_EXISTING = process.env.CDP_EXISTING === '1';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'whepprof-'));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// WHEP POST from Node. Also used to DELETE the reader session at the end.
function postSdp(url, sdp) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', 'Content-Length': Buffer.byteLength(sdp) },
    }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ ok: res.statusCode < 300, status: res.statusCode, body: b, session: res.headers.location || null }));
    });
    req.on('error', reject);
    req.write(sdp); req.end();
  });
}

function delSession(sessionUrl) {
  return new Promise((resolve) => {
    try {
      const u = new URL(sessionUrl);
      const req = http.request({
        hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'DELETE',
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', resolve);
      req.end();
    } catch (e) { resolve(); }
  });
}

const KEEP = ['packetsReceived', 'packetsLost', 'bytesReceived', 'jitter', 'framesReceived',
  'framesDecoded', 'framesDropped', 'framesDiscarded', 'nackCount', 'pliCount', 'firCount',
  'freezeCount', 'pauseCount', 'totalPausesDuration', 'totalFreezesDuration', 'jitterBufferDelay',
  'jitterBufferEmittedCount', 'jitterBufferTarget', 'jitterBufferMinimumDelay', 'playoutDelay',
  'playoutDelayHint', 'frameWidth', 'frameHeight', 'framesPerSecond', 'currentRoundTripTime',
  'availableIncomingBitrate', 'totalDecodeTime', 'keyFramesDecoded', 'totalInterFrameDelay',
  'decoderImplementation', 'powerEfficientDecoder', 'totalAudioEnergy', 'concealedSamples',
  'insertedSamplesForDeceleration', 'insertedSamplesForAcceleration', 'removedSamplesForAcceleration',
  'totalSamplesReceived', 'audioLevel'];

function pick(r) {
  const o = {};
  for (const k of KEEP) if (r[k] !== undefined) o[k] = r[k];
  return o;
}

const PAGE_HELPERS = `
  window.__log=[]; window.__frames=[]; window.__stream=new MediaStream();
  window.__rvfcOk=('requestVideoFrameCallback' in HTMLVideoElement.prototype);
  window.__v=document.createElement('video');
  window.__v.autoplay=true; window.__v.muted=true; window.__v.playsInline=true;
  window.__v.style.cssText='position:fixed;left:0;top:0;width:640px;height:360px;z-index:99999;background:#000';
  document.documentElement.appendChild(window.__v); true
`;

// The offer has to come FROM the browser (it owns the ICE candidates), and the
// answer has to go back to the browser. The WHEP POST in between happens in Node
// so no CORS preflight or same-origin requirement is involved: a fetch issued
// from an `about:blank` page has a null origin and MediaMTX answers that with a
// bare "Failed to fetch", which is indistinguishable from a transport problem.
const PAGE_MAKE_OFFER = `
(async () => {
  const pc = new RTCPeerConnection({ iceServers: [] });
  window.__pc = pc;
  pc.addEventListener('track', (e) => { window.__stream.addTrack(e.track); });
  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const t = setTimeout(resolve, 2500);
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } };
  });
  return pc.localDescription.sdp;
})()
`;

const PAGE_ACCEPT_ANSWER = `
(async (answer) => {
  const pc = window.__pc;
  await pc.setRemoteDescription({ type:'answer', sdp: answer });
  window.__caps = pc.getReceivers().map(r => ({
    kind: r.track ? r.track.kind : 'none',
    jitterBufferTarget: 'jitterBufferTarget' in r,
    playoutDelay: 'playoutDelay' in r,
    playoutDelayHint: 'playoutDelayHint' in r,
    minPlayoutDelay: 'minPlayoutDelay' in r,
  }));
  window.__v.srcObject = window.__stream;
  try { await window.__v.play(); } catch (err) { window.__log.push('play(): ' + err.message); }
  return window.__caps;
})()
`;


(async () => {
  let chrome = null;
  if (!CDP_EXISTING) {
    chrome = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required', '--no-sandbox', 'about:blank',
    ], { stdio: 'ignore' });
  }
  const ownChrome = () => { if (chrome) { try { chrome.kill(); } catch (e) {} } };

  let version = null;
  for (let i = 0; i < 60; i++) {
    try { version = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; }
    catch (e) { await sleep(500); }
  }
  if (!version) { console.error('CHROME_START_FAILED'); ownChrome(); process.exit(1); }

  const ws = new WebSocket(version.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 268435456 });
  // Node's built-in WebSocket is an EventTarget; the `ws` package is a legacy
  // EventEmitter. Normalise both onto addEventListener so the harness works with
  // either and needs no dependency.
  const wsOn = (type, fn) => {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener(type, (ev) => fn(ev && ev.data !== undefined ? ev.data : ev));
    } else {
      ws.on(type, fn);
    }
  };
  await new Promise((res, rej) => { wsOn('open', res); wsOn('error', rej); });
  let id = 0; const pending = new Map(); const events = [];
  wsOn('message', (raw) => {
    const msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    } else if (msg.method) events.push(msg);
  });
  const send = (method, params, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {}, sessionId }));
  });
  // Load a real page first. A WHEP POST from `about:blank` has a null origin and
  // MediaMTX answers that with a CORS failure ("Failed to fetch"), so the probe
  // has to run on the same origin the real viewer uses.
  const PAGE_URL = process.env.PAGE_URL || 'http://127.0.0.1:3000/streaming/';
  const { targetId } = await send('Target.createTarget', { url: PAGE_URL });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000,
    }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error('PAGE: ' + ((d.exception && d.exception.description) || d.text));
    }
    return r.result.value;
  };
  // Target.createTarget resolves before the page finishes loading, and a fetch
  // issued mid-navigation is a "Failed to fetch". Wait for the document first.
  let href = null;
  for (let i = 0; i < 40; i++) {
    href = await ev(`(document.readyState==='complete' ? location.href : 'WAIT:'+document.readyState)`);
    if (typeof href === 'string' && href.indexOf('WAIT:') !== 0) break;
    await sleep(500);
  }
  console.log('=== PAGE ===', href);
  await ev(PAGE_HELPERS);
  const offer = await ev(PAGE_MAKE_OFFER);
  // Node performs the WHEP POST (see the note on PAGE_MAKE_OFFER).
  const answer = await postSdp(WHEP, offer);
  if (!answer.ok) { console.error('WHEP FAIL: ' + answer.status + ' ' + answer.body); ws.close(); ownChrome(); process.exit(2); }
  console.log('=== WHEP OK ===', answer.session || '(no Location)');
  const caps = await ev(`(${PAGE_ACCEPT_ANSWER})(${JSON.stringify(answer.body)})`);
  console.log('=== RECEIVER API SUPPORT ===');
  console.log(JSON.stringify(caps, null, 1));

  await ev(`(()=>{ const v=window.__v; if(!window.__rvfcOk) return false;
    const cb=(now,md)=>{ window.__frames.push({t:now, mt:md.mediaTime, pf:md.presentedFrames,
      w:md.width,h:md.height, fr: md.presentedFractions?Array.from(md.presentedFractions):null, pt:md.processingTime});
      v.requestVideoFrameCallback(cb); };
    v.requestVideoFrameCallback(cb); return true; })()`);

  await sleep(3000);
  const grab = `window.__pc.getStats().then(rep=>{const o=[];rep.forEach(r=>o.push(JSON.parse(JSON.stringify(r))));return o;})`;
  const first = await ev(grab);
  await sleep(RUN_MS);
  const second = await ev(grab);
  const frames = JSON.parse(await ev(`JSON.stringify(window.__frames||[])`));
  const el = await ev(`(()=>{const v=window.__v,q=v.getVideoPlaybackQuality?v.getVideoPlaybackQuality():null;
    return {w:v.videoWidth,h:v.videoHeight,ready:v.readyState,paused:v.paused,ct:v.currentTime,rate:v.playbackRate,
      dropped:q?q.droppedVideoFrames:null,total:q?q.totalVideoFrames:null,err:v.error?v.error.code:null};})()`);
  const plog = await ev(`JSON.stringify(window.__log)`);
  const rlog = events.filter(e => e.method === 'Log.entryAdded').map(e => e.params.entry.level + ': ' + e.params.entry.text).slice(0, 25);


  const key = (r) => [r.type, r.kind || '', r.id].join('|');
  const am = new Map(first.map(r => [key(r), r]));
  const report = [];
  for (const r of second) {
    const p = am.get(key(r));
    if (!p) continue;
    const d = {};
    for (const k of Object.keys(r)) if (typeof r[k] === 'number' && typeof p[k] === 'number' && r[k] !== p[k]) d[k] = r[k] - p[k];
    if (Object.keys(d).length || r.type === 'inbound-rtp' || r.type === 'candidate-pair') {
      report.push({ type: r.type, kind: r.kind, id: String(r.id).slice(0, 8), codec: r.codecId, delta: d, final: pick(r) });
    }
  }
  console.log('=== ELEMENT ===', JSON.stringify(el));
  console.log('=== PAGE LOG ===', plog);
  console.log('=== BROWSER LOG ==='); rlog.forEach(l => console.log('  ' + l));
  console.log('=== STATS (delta over ' + RUN_MS + 'ms) ===');
  console.log(JSON.stringify(report, null, 1));
  if (answer.session) { await delSession(new URL(answer.session, WHEP).href); }
  console.log('=== rVFC ===');
  console.log('frames=' + frames.length);
  const iv = []; for (let i = 1; i < frames.length; i++) iv.push(+(frames[i].t - frames[i-1].t).toFixed(2));
  console.log('callback intervals ms: ' + JSON.stringify(iv.slice(0, 80)));
  console.log('mediaTime deltas: ' + JSON.stringify(frames.slice(1, 40).map((f, i) => +(f.mt - frames[i].mt).toFixed(5))));
  console.log('sample frame: ' + JSON.stringify(frames[1] || null));
  ws.close(); ownChrome(); await sleep(600);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  process.exit(0);
})().catch((e) => { console.error('PROBE_ERROR: ' + e.message); process.exit(3); });

