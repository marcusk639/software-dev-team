// Project checks for the string links typecheck cannot see (contract-map
// role-registry, prompt-sections, sdk-assumptions, tool-names). Hints for the
// reviewer, never verdicts.
import { baseOf, filesMentioning, listOf, quote, showAt } from './lib/sides.mjs';

const TEAM = 'src/team.ts';
const SDK = '@anthropic-ai/claude-agent-sdk';
const TOOL_FILES = ['src/tools.ts', 'src/agents/shared.ts', 'src/permissions.ts'];
const PROMPT = /^(?:src\/.+\/prompt\.md|plugin\/.+\.md)$/;

const changed = (files, path) => files.some((f) => f.file === path || f.oldFile === path);
const minus = (a, b) => [...a].filter((x) => !b.has(x));

// The text between `start` and the next `end` after it, by indexOf: these
// files are PR-controlled, so no lazy regex scans over them.
function between(text, start, end) {
  const i = text.indexOf(start);
  if (i < 0) return '';
  const j = text.indexOf(end, i + start.length);
  return text.slice(i + start.length, j < 0 ? text.length : j);
}

const ROLE_LINE = /^\s*(?:"([\w-]+)"|([A-Za-z]\w*))\s*[:,]/;

// Role keys of `export const AGENTS = { … }` in src/team.ts.
function roles(text) {
  const body = between(text, 'export const AGENTS = {', '\n}');
  return new Set(body.split('\n').flatMap((l) => {
    const m = ROLE_LINE.exec(l);
    return m ? [m[1] ?? m[2]] : [];
  }));
}

function roleNames(ctx) {
  if (!changed(ctx.files, TEAM)) return [];
  const before = roles(showAt(ctx.git, baseOf(ctx), TEAM));
  const after = roles(showAt(ctx.git, ctx.headSha, TEAM));
  const facts = [];
  for (const role of minus(before, after)) {
    const still = filesMentioning(ctx.git, ctx.headSha, role, ['src', 'plugin']).filter((p) => p !== TEAM);
    facts.push({ file: TEAM, note: `removed role ${role}${still.length ? `; still named in ${still.slice(0, 8).join(', ')}` : ''}` });
  }
  for (const role of minus(after, before)) {
    const named = filesMentioning(ctx.git, ctx.headSha, role, ['src', 'plugin']).filter((p) => PROMPT.test(p));
    if (!named.length) facts.push({ file: TEAM, note: `new role ${role} is not named in any prompt` });
  }
  return facts;
}

const sectionsOf = (text) => new Set([...text.matchAll(/^<(\w+)>$/gm)].map((m) => m[1]));

function promptSections(ctx) {
  const base = baseOf(ctx);
  const facts = [];
  for (const f of ctx.files.filter((x) => /(^|\/)prompt\.md$/.test(x.file))) {
    const before = sectionsOf(showAt(ctx.git, base, f.oldFile ?? f.file));
    const after = sectionsOf(f.status === 'D' ? '' : showAt(ctx.git, ctx.headSha, f.file));
    for (const s of minus(before, after)) facts.push({ file: f.file, note: `removed section <${s}> (consumer-breaking)` });
    if (before.size) for (const s of minus(after, before)) facts.push({ file: f.file, note: `added section <${s}>` });
  }
  return facts;
}

const sdkVersion = (text) => {
  try {
    const pkg = JSON.parse(text);
    const v = pkg.dependencies?.[SDK] ?? pkg.devDependencies?.[SDK] ?? null;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
};

function sdkPin(ctx) {
  if (!changed(ctx.files, 'package.json')) return [];
  const before = sdkVersion(showAt(ctx.git, baseOf(ctx), 'package.json'));
  const after = sdkVersion(showAt(ctx.git, ctx.headSha, 'package.json'));
  if (before === after) return [];
  const old = before?.replace(/^[\^~=]/, '').slice(0, 60);
  const stale = old ? filesMentioning(ctx.git, ctx.headSha, old, ['src', 'plugin']) : [];
  return [
    {
      file: 'package.json',
      note: `SDK ${before ? quote(before, 40) : 'absent'} → ${after ? quote(after, 40) : 'absent'}${stale.length ? `; old version still named in ${stale.slice(0, 8).join(', ')}` : ''}`,
    },
  ];
}

const ARRAY_START = /^(?:export )?const ([A-Z_]+) = \[(.*)$/;
const members = (text) => [...text.matchAll(/"(\w+)"|\.\.\.(\w+)/g)].map((x) => x[1] ?? `...${x[2]}`);

// ToolName's members and every `const NAME = [ … ]` list, read line by line.
function toolSets(text) {
  const sets = {};
  if (text.includes('export type ToolName =')) sets.ToolName = new Set(members(between(text, 'export type ToolName =', ';')));
  let open = null;
  for (const line of text.split('\n')) {
    const start = open ? null : ARRAY_START.exec(line);
    const body = start ? start[2] : open ? line : null;
    if (body === null) continue;
    if (start) (open = start[1]), (sets[open] = new Set());
    const close = body.indexOf(']');
    for (const m of members(close < 0 ? body : body.slice(0, close))) sets[open].add(m);
    if (close >= 0) open = null;
  }
  return sets;
}

function toolLists(ctx) {
  const base = baseOf(ctx);
  const facts = [];
  for (const path of TOOL_FILES.filter((p) => changed(ctx.files, p))) {
    const before = toolSets(showAt(ctx.git, base, path));
    const after = toolSets(showAt(ctx.git, ctx.headSha, path));
    const diffs = [];
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const b = before[name] ?? new Set();
      const a = after[name] ?? new Set();
      const delta = [...minus(a, b).map((t) => `+${t}`), ...minus(b, a).map((t) => `-${t}`)];
      if (delta.length) diffs.push(`${name} ${delta.join(' ')}`);
    }
    if (diffs.length) facts.push({ file: path, note: `tool lists changed: ${listOf(diffs, 6).replaceAll('"', '')}` });
  }
  return facts;
}

export default [
  { name: 'role-names', run: roleNames },
  { name: 'prompt-sections', run: promptSections },
  { name: 'sdk-pin', run: sdkPin },
  { name: 'tool-lists', run: toolLists },
];
