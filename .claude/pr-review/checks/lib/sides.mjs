// Both sides of a changed file, as the engine's three-dot diff sees them: the
// base side is the merge base of base and head, not the base tip.

export function baseOf({ git, baseSha, headSha }) {
  try {
    return git(['merge-base', baseSha, headSha]).trim() || baseSha;
  } catch {
    return baseSha;
  }
}

// The file at a commit, or '' when it does not exist there.
export function showAt(git, sha, path) {
  if (!sha || !path) return '';
  try {
    return git(['show', `${sha}:${path}`]);
  } catch {
    return '';
  }
}

// Files at the head commit whose text contains `needle`, under the given roots.
export function filesMentioning(git, sha, needle, roots) {
  try {
    return git(['grep', '-l', '-F', '-e', needle, sha, '--', ...roots])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(sha.length + 1));
  } catch {
    return [];
  }
}

export const quote = (s, max = 120) => JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s);

export function listOf(items, max = 10) {
  const shown = items.slice(0, max).map((s) => quote(s));
  return items.length > max ? `${shown.join(', ')} and ${items.length - max} more` : shown.join(', ');
}
