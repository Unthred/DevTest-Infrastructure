// Issue #1188: the two reads the Requirements check cite gate needs: a pull request's diff and one file at a commit (null when absent).
export function citeFacts(repo, gh) {
  const contentsPath = path => path.split('/').map(encodeURIComponent).join('/');
  return {
    pullDiff: async n => gh(['pr', 'diff', String(n), '--repo', repo]) || '',
    fileAtRef: async (path, ref) => {
      try { return gh(['api', '--method', 'GET', `repos/${repo}/contents/${contentsPath(path)}`, '-f', `ref=${ref}`, '-H', 'Accept: application/vnd.github.raw']); }
      catch { return null; }
    }
  };
}
