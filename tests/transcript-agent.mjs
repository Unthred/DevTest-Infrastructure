#!/usr/bin/env node
// Fake Claude-shaped stream for the transcript tests: prints seeded canaries, then a usage-limit error.
const [secret, env] = process.argv.slice(2);
process.stdin.resume();
const out = o => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'abc' });
out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: `Reading config with token ${secret} and ${env}` }, { type: 'tool_use', name: 'Bash', input: { command: `echo ${secret}` } }], usage: { input_tokens: 10, output_tokens: 5 } } });
out({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'same message id again' }], usage: { input_tokens: 10, output_tokens: 5 } } });
out({ type: 'user', message: { content: [{ type: 'tool_result', content: `output ${secret}` }] } });
out({ type: 'result', is_error: true, result: 'You have hit your usage limit. Resets at 2026-10-30T05:00:00Z' });
process.exitCode = 1;
