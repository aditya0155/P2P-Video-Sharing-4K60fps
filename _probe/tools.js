// Two small tools used while auditing this project.
//
//   node tools.js spec <file> <term> [contextChars]
//       Grep the cached W3C editor drafts in ../research and print the prose
//       around one term, so a spec claim can be checked against the real text.
//
//   node tools.js run [python args...]
//       Run the project's own test suite detached and report where the output
//       lands. A full run takes ~60-90s, longer than one command window.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

function spec(file, term, span) {
  const raw = fs.readFileSync(path.join(ROOT, 'research', file), 'utf8');
  let from = 0;
  let n = 0;
  for (;;) {
    const i = raw.indexOf(term, from);
    if (i < 0 || n >= 3) break;
    console.log('--- hit ' + (n + 1) + ' @' + i + ' ---');
    console.log(raw.slice(Math.max(0, i - 200), i + span)
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ').replace(/\n\s*/g, '\n').trim());
    console.log('');
    from = i + term.length;
    n += 1;
  }
  if (n === 0) console.log('NOT FOUND: ' + term);
}

function run(args) {
  const out = path.join(os.tmpdir(), 'rydius_suite.out');
  const err = path.join(os.tmpdir(), 'rydius_suite.err');
  const child = require('child_process').spawn('python', ['run_tests.py', ...args], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')],
  });
  child.unref();
  console.log('started pid=' + child.pid);
  console.log('results: ' + out + ' / ' + err);
}

const [, , cmd, ...rest] = process.argv;
if (cmd === 'spec') spec(rest[0], rest[1], Number(rest[2] || 1200));
else if (cmd === 'run') run(rest);
else console.log('usage: node tools.js spec <file> <term> [chars] | run [py args]');
