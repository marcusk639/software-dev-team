// Project checks for the safety policy (checklist classes 2, 10 and 12; link
// type policy-tests). Hints for the reviewer, never verdicts:
// - policy-loosening: compares the case tables of every policy test suite at
//   the merge base and at the head, across files (cases move between round
//   files). Reports deny cases that became allow cases or vanished, and lists
//   new allow cases, which is where an intentional loosening shows up (spec
//   G3: every loosening is named in the PR text).
// - carve-outs: added lines in the policy that look like an exemption, one
//   fact per file, where a reviewer should look first.
import { caseBlocks } from './lib/case-blocks.mjs';
import { baseOf, listOf, showAt } from './lib/sides.mjs';

const POLICY_TEST = /^src\/(?:permissions|allowlist)[\w.-]*\.test\.ts$/;
const POLICY_SRC = /^src\/(?:permissions\.ts|allowlist\.ts|permissions\/.+\.ts)$/;
const CARVE_OUT = /\breturn null\b|\b(?:exempt|strip|skip|except|bypass)\w*|\b[A-Z][A-Z_]*_?(?:SAFE|NO_OP|ALLOWED|EXEMPT)[A-Z_]*\b|\b(?:SAFE|NO_OP)_[A-Z_]+\b/i;
const MAX_LINES = 10;

function suites(git, sha) {
  if (!sha) return [];
  try {
    return git(['ls-tree', '-r', '--name-only', sha, '--', 'src'])
      .split('\n')
      .filter((p) => POLICY_TEST.test(p));
  } catch {
    return [];
  }
}

function verdicts(git, sha) {
  const deny = new Set();
  const allow = new Set();
  for (const path of suites(git, sha)) {
    for (const b of caseBlocks(showAt(git, sha, path))) for (const l of b.literals) (b.verdict === 'deny' ? deny : allow).add(l);
  }
  return { deny, allow };
}

const touchesPolicy = (files) => files.some((f) => [f.file, f.oldFile ?? ''].some((p) => POLICY_TEST.test(p) || POLICY_SRC.test(p)));

function loosening(ctx) {
  if (!touchesPolicy(ctx.files)) return [];
  const before = verdicts(ctx.git, baseOf(ctx));
  const after = verdicts(ctx.git, ctx.headSha);
  const moved = [...before.deny].filter((l) => !after.deny.has(l) && after.allow.has(l));
  const removed = [...before.deny].filter((l) => !after.deny.has(l) && !after.allow.has(l));
  const added = [...after.allow].filter((l) => !before.allow.has(l) && !before.deny.has(l));
  const file = (ctx.files.find((f) => POLICY_TEST.test(f.file)) ?? ctx.files.find((f) => POLICY_SRC.test(f.file)))?.file ?? 'src';
  const facts = [];
  if (moved.length) facts.push({ file, note: `${moved.length} case(s) moved deny→allow across the policy suites: ${listOf(moved)}. A loosening; check the PR text names each as intentional, with a reason.` });
  if (removed.length) facts.push({ file, note: `${removed.length} deny case(s) removed with no allow or deny replacement: ${listOf(removed)}. Check the rule still denies them, or the PR says why not.` });
  if (added.length) facts.push({ file, note: `${added.length} new allow case(s): ${listOf(added)}. Each is behaviour the policy now promises to allow; any that was denied before is a loosening the PR text must declare.` });
  return facts;
}

function carveOuts({ files }) {
  const facts = [];
  for (const f of files.filter((x) => !x.binary && POLICY_SRC.test(x.file))) {
    const hits = f.added.filter((a) => CARVE_OUT.test(a.text) && !/^\s*(?:\/\/|\*|\/\*)/.test(a.text));
    if (!hits.length) continue;
    const lines = hits.slice(0, MAX_LINES).map((a) => a.line);
    const more = hits.length > MAX_LINES ? ` and ${hits.length - MAX_LINES} more` : '';
    facts.push({ file: f.file, line: lines[0], note: `added line(s) ${lines.join(', ')}${more} look like a carve-out (early allow, exemption or stripping); check what each lets through` });
  }
  return facts;
}

export default [
  { name: 'policy-loosening', run: loosening },
  { name: 'carve-outs', run: carveOuts },
];
