// MCP over newline-delimited JSON-RPC 2.0 on stdio. handleLine() turns one input line into zero or one output message; nothing here touches
// stdout itself, so a test can drive it directly. A malformed line gets a JSON-RPC error and never stops the server.
export const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_LINE_BYTES = 1024 * 1024;
export const SERVER_INFO = { name: 'foreman-mcp', version: '0.1.0' };

const err = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });

export function createProtocol({ tools, log = () => {} }) {
  let initialized = false;
  return {
    async handleLine(line) {
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return err(null, -32600, 'message too large');
      if (!line.trim()) return null;
      let msg; try { msg = JSON.parse(line); } catch { return err(null, -32700, 'Parse error'); }
      if (Array.isArray(msg)) return err(null, -32600, 'batches are not supported');
      if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return err(msg?.id, -32600, 'Invalid Request');
      const { id, method, params } = msg, isNotification = id === undefined;
      if (isNotification) { if (method === 'notifications/initialized') initialized = true; return null; }   // notifications never get a reply
      if (method === 'ping') return ok(id, {});
      if (method === 'initialize') {
        const asked = params?.protocolVersion;
        return ok(id, { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
          instructions: 'Read access to Foreman state, plus foreman_propose, which only writes a proposal for the homeowner to approve on the dashboard. Cost figures are usage-equivalent estimates. No tool changes Foreman state or can approve anything.' });
      }
      if (method === 'tools/list') return ok(id, { tools: tools.list() });
      if (method === 'tools/call') {
        const name = params?.name, args = params?.arguments ?? {};
        if (typeof name !== 'string') return err(id, -32602, 'tools/call needs a tool name');
        const started = Date.now();
        try {
          const r = await tools.call(name, args);
          log({ tool: name, args, ms: Date.now() - started, ok: !r.isError });
          return ok(id, { content: [{ type: 'text', text: r.text }], isError: !!r.isError });
        } catch (error) {
          log({ tool: name, args, ms: Date.now() - started, ok: false, error: String(error.message).slice(0, 200) });
          return err(id, error.code || -32603, String(error.message).slice(0, 300));
        }
      }
      return err(id, -32601, `Method not found: ${method.slice(0, 60)}`);
    },
    get initialized() { return initialized; },
  };
}
