import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as policy from '../policy.mjs';
import { MAX_BYTES } from '../lib/sides.mjs';
import { byName, ctx, repo } from './helpers.mjs';

const loosening = byName(policy, 'policy-loosening');
const carveOuts = byName(policy, 'carve-outs');
const repos = [];
const make = (base, head) => {
  const r = repo(base, head);
  repos.push(r);
  return r;
};
after(() => repos.forEach((r) => r.cleanup()));

const T = 'src/permissions-round9.test.ts';

describe('policy-loosening', () => {
  it('reports a case moved from a deny table to an allow table, by location only', () => {
    const r = make(
      { [T]: 'denies(R, [bash("rm -rf x"), bash("keep")]);\nallows([bash("ls")]);\n' },
      { [T]: 'denies(R, [bash("keep")]);\nallows([\n  bash("ls"),\n  bash("rm -rf x"),\n]);\n' },
    );
    const facts = loosening.run(ctx(r));
    assert.equal(facts.length, 1);
    assert.equal(facts[0].file, T);
    assert.equal(facts[0].line, 4);
    assert.match(facts[0].note, /1 case\(s\) moved from a deny table to an allow table, now at src\/permissions-round9\.test\.ts line 4/);
    assert.doesNotMatch(facts[0].note, /rm -rf/);
  });

  it('reports a deny case removed without replacement, at its base location', () => {
    const r = make({ [T]: 'denies(R, [\n  bash("cat .e?v"),\n  bash("keep"),\n]);\n' }, { [T]: 'denies(R, [bash("keep")]);\n' });
    const [fact] = loosening.run(ctx(r));
    assert.match(fact.note, /1 deny case\(s\) removed .* line 2 \(base side/);
    assert.doesNotMatch(fact.note, /\.e\?v/);
  });

  it('counts an entry leaving the accepted false-positive list as a removed deny case', () => {
    const fp = 'src/permissions-message-false-positives.test.ts';
    const r = make({ [fp]: 'const ACCEPTED_FALSE_POSITIVES = [\n  "a",\n  "b",\n];\n' }, { [fp]: 'const ACCEPTED_FALSE_POSITIVES = [\n  "a",\n];\n' });
    assert.match(loosening.run(ctx(r))[0].note, /1 deny case\(s\) removed/);
  });

  it('does not count a reworded reason as a removed deny case', () => {
    const r = make({ [T]: 'denies(SAFETY("old wording"), [bash("x")]);\n' }, { [T]: 'denies(SAFETY("new wording"), [bash("x")]);\n' });
    assert.deepEqual(loosening.run(ctx(r)), []);
  });

  it('is silent when only deny cases are added', () => {
    const r = make({ [T]: 'denies(R, [bash("a")]);\n' }, { [T]: 'denies(R, [bash("a"), bash("b")]);\n' });
    assert.deepEqual(loosening.run(ctx(r)), []);
  });

  it('lists where new allow cases are, the shape a declared loosening takes', () => {
    const r = make({ [T]: 'allows([bash("ls")]);\n' }, { [T]: 'allows([bash("ls")]);\nallows([bash("GIT_EDITOR=true git rebase")]);\n' });
    const [fact] = loosening.run(ctx(r));
    assert.match(fact.note, /1 new allow case\(s\) at src\/permissions-round9\.test\.ts line 2/);
  });

  it('follows a case that moves to another suite file', () => {
    const r = make({ [T]: 'denies(R, [bash("x")]);\n' }, { [T]: null, 'src/permissions-round10.test.ts': 'allows([bash("x")]);\n' });
    assert.match(loosening.run(ctx(r))[0].note, /moved .* now at src\/permissions-round10\.test\.ts line 1/);
  });

  it('reads policy suites in subdirectories as tests, not as policy source', () => {
    const sub = 'src/permissions/shell.test.ts';
    const r = make({ [sub]: 'denies(R, [bash("x")]);\n' }, { [sub]: 'allows([bash("x")]);\n' });
    assert.match(loosening.run(ctx(r))[0].note, /moved/);
    assert.deepEqual(carveOuts.run(ctx(r)), []);
  });

  it('handles a test file that is new in the PR', () => {
    const r = make({}, { [T]: 'denies(R, [bash("x")]);\n' });
    assert.deepEqual(loosening.run(ctx(r)), []);
  });

  it('reports a deleted policy test file as removing its deny cases', () => {
    const r = make({ [T]: 'denies(R, [bash("x")]);\n' }, { [T]: null });
    assert.match(loosening.run(ctx(r))[0].note, /deny case\(s\) removed/);
  });

  it('skips a suite over the size cap instead of scanning it', () => {
    const big = `denies(R, [bash("x")]);\n// ${'y'.repeat(MAX_BYTES)}\n`;
    const r = make({ [T]: 'denies(R, [bash("x")]);\n' }, { [T]: big });
    assert.match(loosening.run(ctx(r))[0].note, /deny case\(s\) removed/);
  });

  it('ignores test files outside the policy suites', () => {
    const r = make({ 'src/cli.test.ts': 'denies(R, [bash("x")]);\n' }, { 'src/cli.test.ts': 'allows([bash("x")]);\n' });
    assert.deepEqual(loosening.run(ctx(r)), []);
  });
});

describe('carve-outs', () => {
  it('points at an added early return in a deny function', () => {
    const r = make({ 'src/permissions/shell.ts': 'export function f() {\n  return "no";\n}\n' }, { 'src/permissions/shell.ts': 'export function f() {\n  if (x) return null;\n  return "no";\n}\n' });
    const facts = carveOuts.run(ctx(r));
    assert.equal(facts.length, 1);
    assert.equal(facts[0].file, 'src/permissions/shell.ts');
    assert.equal(facts[0].line, 2);
    assert.match(facts[0].note, /added line\(s\) 2 look like/);
  });

  it('points at exemption-shaped identifiers in the allowlist', () => {
    const r = make({ 'src/allowlist.ts': 'const A = 1;\n' }, { 'src/allowlist.ts': 'const A = 1;\nconst SAFE_KEYS = ["x"];\n' });
    assert.equal(carveOuts.run(ctx(r)).length, 1);
  });

  it('ignores the same line outside the policy', () => {
    const r = make({ 'src/cli.ts': 'x\n' }, { 'src/cli.ts': 'x\n  if (x) return null;\n' });
    assert.deepEqual(carveOuts.run(ctx(r)), []);
  });

  it('gives one fact per file, listing at most ten lines', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `const skip${i} = null;`).join('\n');
    const r = make({ 'src/permissions.ts': 'x\n' }, { 'src/permissions.ts': `x\n${lines}\n` });
    const facts = carveOuts.run(ctx(r));
    assert.equal(facts.length, 1);
    assert.match(facts[0].note, /and 20 more/);
  });

  it('ignores the word allow, camelCase names and trailing comments', () => {
    const r = make(
      { 'src/allowlist.ts': 'x\n' },
      { 'src/allowlist.ts': 'x\nconst allowed = rules.filter((r) => allowRule(r));\nconst safeName = n; // skip this\nconst bySkipCount = 1;\n' },
    );
    assert.deepEqual(carveOuts.run(ctx(r)), []);
  });
});

describe('baseOf', () => {
  it('prefers the kit-supplied merge base when it is a full SHA', async () => {
    const { baseOf } = await import('../lib/sides.mjs');
    const sha = 'a'.repeat(40);
    assert.equal(baseOf({ mergeBase: sha, git: () => { throw new Error('not called'); } }), sha);
    assert.equal(baseOf({ mergeBase: 'HEAD', baseSha: 'b', headSha: 'c', git: () => 'm\n' }), 'm');
  });
});
