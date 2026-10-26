// Reads the policy test files' case tables: which command or path literals sit
// in a deny block and which in an allow block. A heuristic over TypeScript
// source with no parser dependency: it never throws, and on input it cannot
// follow it returns what it has read so far.

const NOT_CASES = new Set(['Bash', 'Read', 'Grep', 'Glob', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task', 'WebFetch', 'WebSearch', 'deny', 'allow']);
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return', 'typeof', undefined]);
const OPEN = { '(': ')', '[': ']', '{': '}' };

// Reads a quoted string starting at i (the quote). Returns [value, next index].
function readString(src, i) {
  const q = src[i];
  let out = '';
  let j = i + 1;
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\' && j + 1 < src.length) {
      const c = src[j + 1];
      out += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      j += 2;
    } else if (src[j] === '\n' && q !== '`') break;
    else out += src[j++];
  }
  return [out, j + 1];
}

// A template literal; one with ${…} is not a literal case (its value is computed).
function readTemplate(src, i) {
  let j = i + 1;
  let out = '';
  let computed = false;
  while (j < src.length && src[j] !== '`') {
    if (src[j] === '\\') {
      out += src[j + 1] ?? '';
      j += 2;
    } else if (src[j] === '$' && src[j + 1] === '{') {
      computed = true;
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
    } else out += src[j++];
  }
  return [computed ? null : out, j + 1];
}

function readRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== '\n') {
    if (src[j] === '\\') j += 2;
    else if (src[j] === '[') (inClass = true), j++;
    else if (src[j] === ']') (inClass = false), j++;
    else if (src[j] === '/' && !inClass) break;
    else j++;
  }
  j++;
  while (j < src.length && /[a-z]/i.test(src[j])) j++;
  return j;
}

export function tokenize(src) {
  const tokens = [];
  let i = 0;
  const prev = () => tokens.at(-1)?.value;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) i++;
    else if (c === '/' && src[i + 1] === '/') i = src.indexOf('\n', i) < 0 ? src.length : src.indexOf('\n', i);
    else if (c === '/' && src[i + 1] === '*') i = src.indexOf('*/', i + 2) < 0 ? src.length : src.indexOf('*/', i + 2) + 2;
    else if (c === '/' && REGEX_AFTER.has(prev())) {
      i = readRegex(src, i);
      tokens.push({ type: 'regex', value: '/re/' });
    } else if (c === '"' || c === "'") {
      const [value, next] = readString(src, i);
      tokens.push({ type: 'str', value });
      i = next;
    } else if (c === '`') {
      const [value, next] = readTemplate(src, i);
      tokens.push(value === null ? { type: 'tpl', value: '`…`' } : { type: 'str', value });
      i = next;
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w$]/.test(src[j])) j++;
      tokens.push({ type: 'id', value: src.slice(i, j) });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[\w.]/.test(src[j])) j++;
      tokens.push({ type: 'num', value: src.slice(i, j) });
      i = j;
    } else {
      tokens.push({ type: 'punct', value: c });
      i++;
    }
  }
  return tokens;
}

// Index of the token closing the bracket opened at `start`, or the last token.
function closeOf(tokens, start) {
  const stack = [];
  for (let k = start; k < tokens.length; k++) {
    const v = tokens[k].type === 'punct' ? tokens[k].value : null;
    if (v && OPEN[v]) stack.push(OPEN[v]);
    else if (v && v === stack.at(-1)) {
      stack.pop();
      if (!stack.length) return k;
    }
  }
  return tokens.length - 1;
}

const literalsIn = (tokens) => tokens.filter((t) => t.type === 'str' && !NOT_CASES.has(t.value)).map((t) => t.value);

export function caseBlocks(src) {
  try {
    return blocks(tokenize(String(src ?? '')));
  } catch {
    return [];
  }
}

function blocks(tokens) {
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'id') continue;
    if (t.value === 'ACCEPTED_FALSE_POSITIVES' && tokens[k + 1]?.value === '=' && tokens[k + 2]?.value === '[') {
      const end = closeOf(tokens, k + 2);
      out.push({ verdict: 'deny', literals: literalsIn(tokens.slice(k + 3, end)) });
      k = end;
      continue;
    }
    if (!['denies', 'allows', 'check'].includes(t.value) || tokens[k + 1]?.value !== '(') continue;
    if (tokens[k - 1]?.value === 'function' || tokens[k - 1]?.value === '.') continue;
    const end = closeOf(tokens, k + 1);
    const inner = tokens.slice(k + 2, end);
    if (t.value === 'check') {
      const verdict = [...inner].reverse().find((x) => x.type === 'str' && (x.value === 'deny' || x.value === 'allow'))?.value;
      if (verdict) out.push({ verdict, literals: literalsIn(inner) });
    } else out.push({ verdict: t.value === 'denies' ? 'deny' : 'allow', literals: literalsIn(inner) });
    k = end;
  }
  return out;
}
