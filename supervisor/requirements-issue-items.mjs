// Issue #1188: how many rows the Requirements check table must have. The acceptance items are the numbered or bulleted lines under
// the issue's Wanted, Requirements, Acceptance, Live checks, Before the PR, After install and Follow-ups headings. An issue with no such list is not counted.
const ITEM_HEADING = /^#{1,6}\s*(?:wanted|acceptance(?:\s+(?:criteria|list|items))?|requirements?|live checks?|before the pr|after install|follow-?ups?)\b/i;
const ITEM_LINE = /^\s*(?:\d+[.)]|[-*])\s+(?:\[[ xX]\]\s+)?(\S.*)$/;

export function issueAcceptanceItems(issueBody) {
  const items = [];
  let inItems = false;
  for (const line of String(issueBody || '').split('\n')) {
    if (/^#{1,6}\s/.test(line)) { inItems = ITEM_HEADING.test(line); continue; }
    if (!inItems) continue;
    const item = ITEM_LINE.exec(line);
    if (item) items.push(item[1].trim());
  }
  return items;
}

// A missing or extra row is named, not only counted.
export function expectedRowProblems(rows, issueBody) {
  const items = issueAcceptanceItems(issueBody);
  if (!items.length || items.length === rows.length) return [];
  if (rows.length < items.length) {
    return items.slice(rows.length).map(item => ({ row: '(missing row)', cite: `item ${items.indexOf(item) + 1}`, reason: `the issue has ${items.length} acceptance items, the table has ${rows.length} rows; no row for "${item.slice(0, 100)}"` }));
  }
  return rows.slice(items.length).map(row => ({ row: row.requirement, cite: 'extra row', reason: `the issue has ${items.length} acceptance items, the table has ${rows.length} rows; this row matches no item` }));
}
