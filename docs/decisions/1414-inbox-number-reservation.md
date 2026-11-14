# The MCP server reserves an Inbox card number with one marker file in items/

- Status: agent-proposal
- Date: 2026-11-14
- Source: issue #1414 (every Inbox card shows a short card number and its issue number once posted); amends the single write of D-031.
- Decision: Every Inbox item has a running number (shown as C142). Foreman owns the counter (`status/number.json`) and gives a number once, never reuses one, and numbers items that exist already once, oldest first. So that the reply of `foreman_propose` can name the number, the MCP account reserves it before it writes the item: one small marker file `items/.n<number>` holding the item id, created with the exclusive flag (so two proposals arriving together cannot take the same number) and removed by Foreman when it picks the item up, or by the MCP server if the item write fails. The write stays inside `<inbox>/items/`, the only directory the launcher allows; the marker is never an item and the pickup scan reads only `<32 hex>.json` names. If a reserved number was already given to another item (a stale reader), Foreman ignores the reservation and assigns the next number.
- Rationale: The overseer must be able to say "reject C142" at once, and the account that proposes cannot write `status/`. A marker in `items/` is the smallest write that is atomic and stays inside the existing permission boundary; it carries no content and no authority.
- Rejected: Assigning only at pickup, so the reply carries no number (fails the issue); a counter file the MCP account writes (a second, mutable state file it could damage); letting the MCP account write `status/`; predicting the number from the queue (can name the wrong card).
- Superseded-by: none
