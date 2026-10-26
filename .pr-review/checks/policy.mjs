// Project checks for the safety policy (checklist classes 2, 10 and 12; link
// type policy-tests). Hints for the reviewer, never verdicts:
// - policy-loosening: compares the case tables of every policy test suite at
//   the merge base and at the head, across files (cases move between round
//   files). Reports deny cases that became allow cases or vanished, and new
//   allow cases, which is where an intentional loosening shows up (spec G3).
//   Facts give counts and file:line only, never the case text: a loosened
//   deny case may be a working bypass, and the model reads it from pr.diff.
// - carve-outs: added lines in the policy that look like an exemption, one
//   fact per file, where a reviewer should look first.
// Suites with no denies/allows/check tables (loops, plain it() calls) yield
// no cases, so silence here is not coverage of them.
import { caseBlocks } from './lib/case-blocks.mjs';
import { baseOf, showAt } from './lib/sides.mjs';

const POLICY_TEST = /^src\/(?:permissions\/.+|(?:[\w.-]+\/)*(?:permissions|allowlist)[\w.-]*)\.test\.ts$/;
const POLICY_SRC = /^src\/(?:permissions\.ts|allowlist\.ts|permissions\/.+\.ts)$/;
const CARVE_OUT = /\breturn null\b|\b(?:exempt|strip|skip|except|bypass)\w*|\b[A-Z][A-Z_]*_?(?:SAFE|NO_OP|ALLOWED|EXEMPT)[A-Z_]*\b|\b(?:SAFE|NO_OP)_[A-Z_]+\b/;
const MAX_LINES = 10;
const MAX_SUITES = 40;

const isTest = (p) => POLICY_TEST.test(p);
const isSrc = (p) => POLICY_SRC.test(p) && !/\.test\.ts$/.test(p);

function suites(git, sha) {
  if (!sha) return [];
  try {
    return git(['ls-tree', '-r', '--name-only', sha, '--', 'src'])
      .split('\n')
      .filter(isTest)
      .slice(0, MAX_SUITES);
  } catch {
    return [];
  }
}

// literal -> where it sits, per verdict: Map(text -> {file, line}).
function verdicts(git, sha) {
  const deny = new Map();
  const allow = new Map();
  for (const file of suites(git, sha)) {
    for (const b of caseBlocks(showAt(git, sha, file))) {
      const into = b.verdict === 'deny' ? deny : allow;
      b.literals.forEach((l, i) => into.has(l) || into.set(l, { file, line: b.lines[i] }));
    }
  }
  return { deny, allow };
}

// "a.test.ts lines 3, 9; b.test.ts line 12" for a list of {file, line}.
function where(locations) {
  const byFile = new Map();
  for (const { file, line } of locations) byFile.set(file, [...(byFile.get(file) ?? []), line]);
  return [...byFile]
    .map(([file, lines]) => {
      const shown = lines.slice(0, MAX_LINES).join(', ');
      return `${file} line${lines.length > 1 ? 's' : ''} ${shown}${lines.length > MAX_LINES ? ` and ${lines.length - MAX_LINES} more` : ''}`;
    })
    .join('; ');
}

const touchesPolicy = (files) => files.some((f) => [f.file, f.oldFile ?? ''].some((p) => isTest(p) || isSrc(p)));

function loosening(ctx) {
  if (!touchesPolicy(ctx.files)) return [];
  const before = verdicts(ctx.git, baseOf(ctx));
  const after = verdicts(ctx.git, ctx.headSha);
  const moved = [...before.deny.keys()].filter((l) => !after.deny.has(l) && after.allow.has(l)).map((l) => after.allow.get(l));
  const removed = [...before.deny.keys()].filter((l) => !after.deny.has(l) && !after.allow.has(l)).map((l) => before.deny.get(l));
  const added = [...after.allow.keys()].filter((l) => !before.allow.has(l) && !before.deny.has(l)).map((l) => after.allow.get(l));
  const anchor = (list) => ({ file: list[0].file, line: list[0].line });
  const facts = [];
  if (moved.length) facts.push({ ...anchor(moved), note: `${moved.length} case(s) moved from a deny table to an allow table, now at ${where(moved)} (head). A loosening; check the PR text names each as intentional, with a reason.` });
  if (removed.length) facts.push({ ...anchor(removed), note: `${removed.length} deny case(s) removed with no replacement, previously at ${where(removed)} (base side of pr.diff). Check the rule still denies them, or the PR says why not.` });
  if (added.length) facts.push({ ...anchor(added), note: `${added.length} new allow case(s) at ${where(added)} (head). Each is behaviour the policy now promises to allow; any that was denied before is a loosening the PR text must declare.` });
  return facts;
}

const code = (text) => text.replace(/\s\/\/.*$/, '');

function carveOuts({ files }) {
  const facts = [];
  for (const f of files.filter((x) => !x.binary && isSrc(x.file))) {
    const hits = f.added.filter((a) => !/^\s*(?:\/\/|\*|\/\*)/.test(a.text) && CARVE_OUT.test(code(a.text)));
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
