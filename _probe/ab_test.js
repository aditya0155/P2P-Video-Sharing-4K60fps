// A/B measurement helper: encodes the same clip with and without an extra
// encoder flag and reports total size, 100ms peak, max IDR and IDR count, so a
// change is adopted on numbers rather than on reputation.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FFMPEG = process.env.FFMPEG
  || "C:\\Users\\adity\\Videos\\Streaming'\\ffmpeg_win\\ffmpeg-n8.1-latest-win64-gpl-shared-8.1\\bin\\ffmpeg.exe";
const SRC = process.argv[2];
const CODEC = process.argv[3] || 'h264_nvenc';
const BITRATE = process.argv[4] || '6000k';
const GOP = process.argv[5] || '30';
const DUR = Number(process.env.DUR_SEC || 12);
const VARIANTS = JSON.parse(process.argv[6]
  || '[["baseline",[]],["aq",["-spatial-aq","1","-aq-strength","8"]]]');

function encode(extra) {
  const out = path.join(os.tmpdir(), `ab_${Math.random().toString(36).slice(2)}.h264`);
  const args = [
    '-hide_banner', '-loglevel', 'error', '-i', SRC,
    '-c:v', CODEC, '-preset', 'p4', '-tune', 'ull',
    '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', BITRATE,
    '-bf', '0', '-g', GOP, '-forced-idr', '1',
    '-fps_mode', 'passthrough',
    ...extra, '-f', 'h264', '-y', out,
  ];
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error('ENCODE FAILED:', (r.stderr || '').split('\n').slice(-6).join('\n'));
    return null;
  }
  const b = fs.readFileSync(out);
  fs.unlinkSync(out);
  // Split on Annex-B start codes: 00 00 01 begins a NAL; the first payload byte
  // 0x65 is IDR (nal_ref_idc 3, type 5).
  const sizes = [];
  const idrs = [];
  let i = 0;
  const isStart = (k) => b[k] === 0 && b[k + 1] === 0
    && ((b[k + 2] === 0 && b[k + 3] === 1) || (b[k + 2] === 1));
  const startLen = (k) => (b[k + 2] === 1 ? 3 : 4);
  while (i < b.length - 5) {
    if (!isStart(i)) { i++; continue; }
    const isIdr = b[i + startLen(i)] === 0x65;
    let j = i + startLen(i);
    while (j < b.length - 5 && !isStart(j)) j++;
    const size = j - i;
    sizes.push(size);
    if (isIdr) idrs.push(size);
    i = j;
  }
  const total = b.length;
  // 100ms peak = the largest 10th-of-a-second window.
  const per = Math.max(1, Math.round(sizes.length / (DUR * 10)));
  let peak = 0;
  for (let k = 0; k + per <= sizes.length; k += per) {
    let s = 0;
    for (let m = k; m < k + per; m++) s += sizes[m];
    peak = Math.max(peak, s);
  }
  return {
    totalKB: +(total / 1024).toFixed(0),
    avgMbps: +((total * 8 / DUR) / 1e6).toFixed(2),
    peak100Mbps: +((peak * 8 / 0.1) / 1e6).toFixed(2),
    idr: idrs.length,
    maxIdrKB: idrs.length ? +(Math.max(...idrs) / 1024).toFixed(1) : 0,
    frames: sizes.length,
  };
}

for (const [name, extra] of VARIANTS) {
  const r = encode(extra);
  console.log(name.padEnd(12), r ? JSON.stringify(r) : 'FAILED');
}
