const pty = require('node-pty');

const p = pty.spawn('bun', ['run', 'aery', '--no-title'], {
  name: 'xterm-color',
  cols: 80,
  rows: 30,
  cwd: '/home/aryee/aery/ai_agent/aery',
  env: process.env
});

let out = '';
let sent = false;
p.on('data', data => {
  out += data;
  if (!sent && (out.includes('╰─') || out.includes('│'))) {
    setTimeout(() => {
      console.log("Sending /marketplace");
      p.write('/marketplace\r');
      sent = true;
    }, 1000);
  }
});

setTimeout(() => {
  console.log("Output after 6s:");
  console.log(out);
  p.kill();
}, 6000);
