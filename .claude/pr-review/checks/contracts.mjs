// Project checks for the string links typecheck cannot see (contract-map
// role-registry, prompt-sections, sdk-assumptions, tool-names). Hints for the
// reviewer, never verdicts.
import { baseOf, filesMentioning, listOf, showAt } from './lib/sides.mjs';

const TEAM = 'src/team.ts';
const SDK = '@anthropic-ai/claude-agent-sdk';
const TOOL_FILES = ['src/tools.ts', 'src/agents/shared.ts', 'src/permissions.ts'];
const PROMPT = /^(?:src\/.+\/prompt\.md|plugin\/.+\.md)$/;

const changed = (files, path) => files.some((f) => f.file === path || f.oldFile === path);
const minus = (a, b) => [...a].filter((x) => !b.has(x));

// Role keys of `export const AGENTS = { … }` in src/team.ts.
function roles(text) {
  const body = /export const AGENTS = \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? '';
  return new Set([...body.matchAll(/^\s*(?:"([\w-]+)"|([A-Za-z]\w*))\s*[:,]/gm)].map((m) => m[1] ?? m[2]));
}

function roleNames(ctx) {
  if (!changed(ctx.files, TEAM)) return [];
  const before = roles(showAt(ctx.git, baseOf(ctx), TEAM));
  const after = roles(showAt(ctx.git, ctx.headSha, TEAM));
  const facts = [];
  for (const role of minus(before, after)) {
    const still = filesMentioning(ctx.git, ctx.headSha, role, ['src', 'plugin']).filter((p) => p !== TEAM);
    facts.push({ file: TEAM, note: `removed role ${role}${still.length ? `; still named in ${still.join(', ')}` : ''}. Consumers' .claude/dev-team/${role}*.md files would now fail to load.` });
  }
  for (const role of minus(after, before)) {
    const named = filesMentioning(ctx.git, ctx.headSha, role, ['src', 'plugin']).filter((p) => PROMPT.test(p));
    if (!named.length) facts.push({ file: TEAM, note: `new role ${role} is not named in any prompt; the manager learns of it only from the roster` });
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
    for (const s of minus(before, after)) facts.push({ file: f.file, note: `removed section <${s}>: consumer-breaking for any .claude/dev-team/<name>.${s}.md override` });
    if (before.size) for (const s of minus(after, before)) facts.push({ file: f.file, note: `added section <${s}>` });
  }
  return facts;
}

const sdkVersion = (text) => {
  try {
    const pkg = JSON.parse(text);
    return pkg.dependencies?.[SDK] ?? pkg.devDependencies?.[SDK] ?? null;
  } catch {
    return null;
  }
};

function sdkPin(ctx) {
  if (!changed(ctx.files, 'package.json')) return [];
  const before = sdkVersion(showAt(ctx.git, baseOf(ctx), 'package.json'));
  const after = sdkVersion(showAt(ctx.git, ctx.headSha, 'package.json'));
  if (before === after) return [];
  const old = before?.replace(/^[\^~=]/, '');
  const stale = old ? filesMentioning(ctx.git, ctx.headSha, old, ['src', 'plugin']) : [];
  return [
    {
      file: 'package.json',
      note: `${SDK} ${before ?? 'absent'} → ${after ?? 'absent'}. Assumptions verified against the old version need re-checking${stale.length ? `; files that still name ${old}: ${stale.join(', ')}` : ''}.`,
    },
  ];
}

function toolSets(text) {
  const sets = {};
  const union = /export type ToolName =([\s\S]*?);/.exec(text)?.[1];
  if (union) sets.ToolName = new Set([...union.matchAll(/"(\w+)"/g)].map((m) => m[1]));
  for (const m of text.matchAll(/^(?:export )?const ([A-Z_]+) = \[([\s\S]*?)\]/gm)) sets[m[1]] = new Set([...m[2].matchAll(/"(\w+)"|\.\.\.(\w+)/g)].map((x) => x[1] ?? `...${x[2]}`));
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
    if (diffs.length) facts.push({ file: path, note: `tool lists changed: ${listOf(diffs).replaceAll('"', '')}. Check every rule keyed on these lists (write checks, manager allowlist, foreground-only) still covers what it should.` });
  }
  return facts;
}

export default [
  { name: 'role-names', run: roleNames },
  { name: 'prompt-sections', run: promptSections },
  { name: 'sdk-pin', run: sdkPin },
  { name: 'tool-lists', run: toolLists },
];
