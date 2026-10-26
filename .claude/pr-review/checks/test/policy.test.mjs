import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import * as policy from '../policy.mjs';
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
  it('reports a case moved from a deny block to an allow block', () => {
    const r = make(
      { [T]: 'denies(R, [bash("rm -rf x"), bash("keep")]);\nallows([bash("ls")]);\n' },
      { [T]: 'denies(R, [bash("keep")]);\nallows([bash("ls"), bash("rm -rf x")]);\n' },
    );
    const facts = loosening.run(ctx(r));
    assert.equal(facts.length, 1);
    assert.equal(facts[0].file, T);
    assert.match(facts[0].note, /deny→allow/);
    assert.match(facts[0].note, /rm -rf x/);
  });

  it('reports a deny case removed without replacement', () => {
    const r = make({ [T]: 'denies(R, [bash("cat .e?v"), bash("keep")]);\n' }, { [T]: 'denies(R, [bash("keep")]);\n' });
    const facts = loosening.run(ctx(r));
    assert.equal(facts.length, 1);
    assert.match(facts[0].note, /deny case\(s\) removed/);
    assert.match(facts[0].note, /cat \.e\?v/);
  });

  it('counts an entry leaving the accepted false-positive list as a removed deny case', () => {
    const fp = 'src/permissions-message-false-positives.test.ts';
    const r = make({ [fp]: 'const ACCEPTED_FALSE_POSITIVES = [\n  "a",\n  "b",\n];\n' }, { [fp]: 'const ACCEPTED_FALSE_POSITIVES = [\n  "a",\n];\n' });
    assert.match(loosening.run(ctx(r))[0].note, /deny case\(s\) removed.*"b"/);
  });

  it('is silent when only deny cases are added', () => {
    const r = make({ [T]: 'denies(R, [bash("a")]);\n' }, { [T]: 'denies(R, [bash("a"), bash("b")]);\n' });
    assert.deepEqual(loosening.run(ctx(r)), []);
  });

  it('lists new allow cases, the shape a declared loosening takes', () => {
    const r = make({ [T]: 'allows([bash("ls")]);\n' }, { [T]: 'allows([bash("ls"), bash("GIT_EDITOR=true git rebase")]);\n' });
    const [fact] = loosening.run(ctx(r));
    assert.match(fact.note, /1 new allow case/);
    assert.match(fact.note, /GIT_EDITOR=true/);
  });

  it('follows a case that moves to another suite file', () => {
    const r = make({ [T]: 'denies(R, [bash("x")]);\n' }, { [T]: null, 'src/permissions-round10.test.ts': 'allows([bash("x")]);\n' });
    assert.match(loosening.run(ctx(r))[0].note, /deny→allow.*"x"/);
  });

  it('handles a test file that is new in the PR', () => {
    const r = make({}, { [T]: 'denies(R, [bash("x")]);\n' });
    assert.deepEqual(loosening.run(ctx(r)), []);
  });

  it('reports a deleted policy test file as removing its deny cases', () => {
    const r = make({ [T]: 'denies(R, [bash("x")]);\n' }, { [T]: null });
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

  it('does not treat the word allow in the allowlist module as a carve-out', () => {
    const r = make({ 'src/allowlist.ts': 'x\n' }, { 'src/allowlist.ts': 'x\nconst allowed = rules.filter((r) => allowRule(r));\n' });
    assert.deepEqual(carveOuts.run(ctx(r)), []);
  });
});
