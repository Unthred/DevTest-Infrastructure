// Issue #1311: GET /api/v1/agent-icon/{agent}, the one colour SVG icon of an agent, kept by the homeowner in <state root>/agent-icons/.
// The agent is only looked up in the configured agent ids (see supervisor/agenticon-file.mjs), so no request text reaches a path.
import { readAgentIcon } from '../../agenticon-file.mjs';

export const name = 'agent_icon';
export const method = 'GET';
export const path = 'agent-icon/{agent}';

const POLICY = "default-src 'none'; style-src 'none'; sandbox";

export function handle(req, res, context) {
  const svg = readAgentIcon(context.root, context.config, context.params.agent);
  if (svg === null) return context.fail(req, res, 404, 'not_found', 'No icon for that agent.');
  return context.reply(req, res, 200, 'image/svg+xml', svg, {
    'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', 'content-security-policy': POLICY,
  });
}
