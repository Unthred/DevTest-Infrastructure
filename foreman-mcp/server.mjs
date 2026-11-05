#!/usr/bin/env node
// foreman-mcp: a read-only stdio MCP server for the overseer. Reads the local dashboard view and /proc; writes only its own call log.
// Configuration: FOREMAN_MCP_CONFIG (a JSON file: { "viewUrl": "http://HOST:PORT/api/view.json", "logFile": "/path/calls.log" }); both can also be
// given as FOREMAN_MCP_VIEW_URL and FOREMAN_MCP_LOG. Nothing but protocol is ever written to stdout.
import fs from 'node:fs';
import readline from 'node:readline';
import { createProtocol } from './protocol.mjs';
import { createTools } from './tools.mjs';
import { createViewSource, readHost } from './source.mjs';
import { createCallLog } from './calllog.mjs';

function loadConfig(env = process.env) {
  let cfg = {};
  if (env.FOREMAN_MCP_CONFIG) { try { cfg = JSON.parse(fs.readFileSync(env.FOREMAN_MCP_CONFIG, 'utf8')); } catch { cfg = {}; } }
  return { viewUrl: env.FOREMAN_MCP_VIEW_URL || cfg.viewUrl || null, logFile: env.FOREMAN_MCP_LOG || cfg.logFile || null };
}

export function buildServer(config) {
  const callLog = createCallLog(config.logFile);
  const tools = createTools({ source: createViewSource({ url: config.viewUrl }), readHost });
  return createProtocol({ tools, log: e => callLog.record(e) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const protocol = buildServer(loadConfig());
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();   // replies keep the order of the requests
  rl.on('line', line => { chain = chain.then(async () => { const reply = await protocol.handleLine(line); if (reply) process.stdout.write(JSON.stringify(reply) + '\n'); }).catch(() => {}); });
  rl.on('close', () => { chain.finally(() => process.exit(0)); });
  process.on('uncaughtException', () => {});   // a bug in one call must not take the connection down; nothing is printed to stdout
}
