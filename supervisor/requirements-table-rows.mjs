// Reads the rows of the PR "Requirements check" table (shared by the shape check and the cite check, issue #1188).
export const REQUIREMENTS_TABLE_HEADING = 'Requirements check';

export const cells = line => line.trim().startsWith('|') && line.trim().endsWith('|')
  ? line.trim().slice(1, -1).split('|').map(cell => cell.trim())
  : null;

export const tableSection = body => {
  const lines = String(body || '').split('\n');
  const start = lines.findIndex(line => new RegExp(`^#{1,6}\\s+${REQUIREMENTS_TABLE_HEADING}\\s*$`, 'i').test(line.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^#{1,6}\s+/.test(line.trim()));
  return end < 0 ? rest : rest.slice(0, end);
};


// Every row of the table as { requirement, status, evidence }, for the cite check (#1188).
export function requirementsRows(body) {
  const section = tableSection(body) || [];
  const headerAt = section.findIndex(line => cells(line)?.length === 3);
  if (headerAt < 0) return [];
  return section.slice(headerAt + 2).map(cells).filter(row => row?.length === 3).map(([requirement, status, evidence]) => ({ requirement, status, evidence }));
}
