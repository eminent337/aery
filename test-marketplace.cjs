const { spawn } = require('child_process');

const pty = require('node-pty');
const p = pty.spawn('bun', ['run', 'aery', '--no-title'], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: '/home/aryee/aery/ai_agent/aery',
  env: process.env
});

let out = '';
p.on('data', data => {
  out += data;
  if (out.includes('Aery >') && !out.includes('marketplace')) {
    console.log("Found prompt, sending /marketplace");
    p.write('/marketplace\r');
  }
});

setTimeout(() => {
  console.log("Output:");
  console.log(out);
  p.kill();
}, 5000);
