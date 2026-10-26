import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as contracts from '../contracts.mjs';
import { byName, ctx, repo } from './helpers.mjs';

const repos = [];
const make = (base, head) => {
  const r = repo(base, head);
  repos.push(r);
  return r;
};
after(() => repos.forEach((r) => r.cleanup()));
const run = (name, r) => byName(contracts, name).run(ctx(r));

const team = (keys) => `export const AGENTS = {\n${keys.map((k) => (k.includes('-') ? `  "${k}": x,` : `  ${k},`)).join('\n')}\n} satisfies Record<string, AgentSpec>;\n`;
const ORCH = 'src/orchestrator/prompt.md';

describe('role-names', () => {
  it('names prompts that still mention a removed role', () => {
    const r = make({ 'src/team.ts': team(['architect', 'qa-tester']), [ORCH]: 'send it to qa-tester\n' }, { 'src/team.ts': team(['architect', 'quality-tester']), 'src/agents/x/prompt.md': 'quality-tester runs it\n' });
    const notes = run('role-names', r).map((f) => f.note).join('\n');
    assert.match(notes, /removed role qa-tester/);
    assert.match(notes, new RegExp(ORCH));
  });

  it('says when a new role is named in no prompt', () => {
    const r = make({ 'src/team.ts': team(['architect']), [ORCH]: 'architect\n' }, { 'src/team.ts': team(['architect', 'data-engineer']) });
    assert.match(run('role-names', r)[0].note, /data-engineer.*not named in/);
  });

  it('is silent when team.ts is untouched', () => {
    const r = make({ 'src/team.ts': team(['architect']) }, { 'src/cli.ts': 'x\n' });
    assert.deepEqual(run('role-names', r), []);
  });
});

describe('prompt-sections', () => {
  it('marks a renamed section consumer-breaking', () => {
    const p = 'src/agents/architect/prompt.md';
    const r = make({ [p]: '<role>\nx\n</role>\n\n<safety>\ny\n</safety>\n' }, { [p]: '<role>\nx\n</role>\n\n<rules>\ny\n</rules>\n' });
    const notes = run('prompt-sections', r).map((f) => f.note).join('\n');
    assert.match(notes, /removed section <safety>/);
    assert.match(notes, /consumer-breaking/);
    assert.match(notes, /added section <rules>/);
  });

  it('is silent when only the body of a section changes', () => {
    const p = 'src/orchestrator/prompt.md';
    const r = make({ [p]: '<role>\nx\n</role>\n' }, { [p]: '<role>\nchanged\n</role>\n' });
    assert.deepEqual(run('prompt-sections', r), []);
  });
});

describe('sdk-pin', () => {
  const pkg = (v) => `{\n  "dependencies": {\n    "@anthropic-ai/claude-agent-sdk": "${v}"\n  }\n}\n`;
  it('names both versions and the files that still assume the old one', () => {
    const r = make({ 'package.json': pkg('0.3.283'), 'src/permissions.ts': '// unverified against 0.3.283\n' }, { 'package.json': pkg('^0.4.0') });
    const [fact] = run('sdk-pin', r);
    assert.match(fact.note, /0\.3\.283 → \^0\.4\.0/);
    assert.match(fact.note, /src\/permissions\.ts/);
  });

  it('is silent when another dependency changes', () => {
    const r = make({ 'package.json': pkg('0.3.283') }, { 'package.json': pkg('0.3.283').replace('}\n}', '},\n  "x": 1\n}') });
    assert.deepEqual(run('sdk-pin', r), []);
  });
});

describe('tool-lists', () => {
  const tools = (manager, union) => `export type ToolName =\n${union.map((t) => `  | "${t}"`).join('\n')};\n\nexport const MANAGER_ALLOWED = [\n${manager.map((t) => `  "${t}",`).join('\n')}\n] as const satisfies readonly ToolName[];\n`;
  it('reports a tool added to the manager allowlist', () => {
    const r = make({ 'src/tools.ts': tools(['Read'], ['Read', 'WebFetch']) }, { 'src/tools.ts': tools(['Read', 'WebFetch'], ['Read', 'WebFetch']) });
    assert.match(run('tool-lists', r)[0].note, /MANAGER_ALLOWED \+WebFetch/);
  });

  it('reports a change to the ToolName union', () => {
    const r = make({ 'src/tools.ts': tools(['Read'], ['Read']) }, { 'src/tools.ts': tools(['Read'], ['Read', 'Skill']) });
    assert.match(run('tool-lists', r)[0].note, /ToolName \+Skill/);
  });
});
