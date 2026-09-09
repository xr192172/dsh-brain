const { spawn } = require('node:child_process');
const { readdirSync } = require('node:fs');
const { join } = require('node:path');
const here = __dirname;
const outs = readdirSync(join(here, 'out')).filter((d) => d && d.startsWith('b')).sort();
const latest = outs[outs.length - 1];
if (!latest) { console.error('[switchboard] no builds under out/'); process.exit(1); }
const main = join(here, 'out', latest, 'main.js');
const child = spawn(process.execPath, [main], { stdio: 'inherit', env: process.env });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', (c) => process.exit(c ?? 1));
