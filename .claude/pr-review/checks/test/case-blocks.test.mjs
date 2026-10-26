import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { caseBlocks } from '../lib/case-blocks.mjs';

describe('caseBlocks', () => {
  it('reads a denies() block', () => {
    assert.deepEqual(caseBlocks('denies(R, [bash("rm -rf x")]);'), [{ verdict: 'deny', literals: ['rm -rf x'] }]);
  });

  it('reads allows() and takes check()\'s verdict from its last argument', () => {
    const src = `allows([bash('ls')]);\ncheck([bash('a'), ["Read", { file_path: "b" }]], "allow");`;
    const blocks = caseBlocks(src);
    assert.deepEqual(blocks[0], { verdict: 'allow', literals: ['ls'] });
    assert.equal(blocks[1].verdict, 'allow');
    assert.deepEqual(blocks[1].literals, ['a', 'b']);
  });

  it('skips function declarations named denies or allows', () => {
    const src = 'function denies(reason, cases) { for (const c of cases) it(`deny ${c}`, () => {}); }\ndenies(R, [bash("y")]);';
    assert.deepEqual(caseBlocks(src), [{ verdict: 'deny', literals: ['y'] }]);
  });

  it('treats the accepted false-positive list as deny cases', () => {
    const src = 'const ACCEPTED_FALSE_POSITIVES = [\n  "git commit -m \\"x\\"",\n  \'gh pr create -t a\',\n];';
    assert.deepEqual(caseBlocks(src), [{ verdict: 'deny', literals: ['git commit -m "x"', 'gh pr create -t a'] }]);
  });

  it('is not thrown off by a regex literal holding parens and quotes', () => {
    const src = 'denies(/\\(x\\) it\'s "q"/, [bash("y")]);\nallows([bash("z")]);';
    assert.deepEqual(caseBlocks(src), [
      { verdict: 'deny', literals: ['y'] },
      { verdict: 'allow', literals: ['z'] },
    ]);
  });

  it('ignores comments and template literals with substitutions', () => {
    const src = 'denies(R, [\n  // bash("commented")\n  bash(`a ${b}`),\n  bash(`plain`),\n]);';
    assert.deepEqual(caseBlocks(src), [{ verdict: 'deny', literals: ['plain'] }]);
  });

  it('survives unbalanced input', () => {
    assert.doesNotThrow(() => caseBlocks('denies([bash("z")'));
    assert.doesNotThrow(() => caseBlocks('"unterminated'));
  });

  it('leaves a check() without a verdict word out', () => {
    assert.deepEqual(caseBlocks('check([bash("q")], expected);'), []);
  });
});
