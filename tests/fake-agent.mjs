#!/usr/bin/env node
import fs from 'node:fs';
const [scenario, marker] = process.argv.slice(2);
fs.appendFileSync(marker, 'called\n');
process.stdin.resume();
if (scenario === 'limit') { console.log(JSON.stringify({ type: 'error', message: 'Usage limit reached. Resets at 2026-10-30T05:00:00Z' })); process.exitCode = 1; }
else if (scenario === 'auth') { console.log('Authentication failed'); process.exitCode = 1; }
else if (scenario === 'sleep') { setTimeout(() => { console.log('done'); }, 60000); }
else if (scenario === 'recoverable-rate') { console.error('429 rate limit, retrying in 2s'); console.log('done'); }
else { console.log('done'); }
