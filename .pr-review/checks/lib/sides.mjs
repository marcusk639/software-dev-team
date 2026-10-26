// Both sides of a changed file, as the engine's three-dot diff sees them: the
// base side is the merge base of base and head, not the base tip. The kit
// passes it as ctx.mergeBase from P0.1; before that it is computed here.

export function baseOf({ git, baseSha, headSha, mergeBase }) {
  if (typeof mergeBase === 'string' && /^[0-9a-f]{40}$/.test(mergeBase)) return mergeBase;
  try {
    return git(['merge-base', baseSha, headSha]).trim() || baseSha;
  } catch {
    return baseSha;
  }
}

// Files above this size are skipped: their text is PR-controlled and the
// checks' scans should stay cheap. A skipped file reads as ''.
export const MAX_BYTES = 256 * 1024;

// The file at a commit, or '' when it does not exist there or is too large.
export function showAt(git, sha, path) {
  if (!sha || !path) return '';
  try {
    if (Number(git(['cat-file', '-s', `${sha}:${path}`]).trim()) > MAX_BYTES) return '';
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
