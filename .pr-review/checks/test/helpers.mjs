// Test fixtures: a throwaway git repo with a base and a head commit, and the
// diff in the shape the engine hands project checks
// ({file, oldFile, status, binary, added[{line,text}], removed[{line,text}]}).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const run = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function write(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const full = join(dir, path);
    if (text === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
  }
}

function parse(diff) {
  const files = [];
  let cur = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / a\/(.+) b\/(.+)$/.exec(line);
      cur = { oldFile: m[1], file: m[2], status: 'M', binary: false, added: [], removed: [] };
      files.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('new file mode')) cur.status = 'A';
    else if (line.startsWith('deleted file mode')) cur.status = 'D';
    else if (line.startsWith('@@')) {
      const m = /-(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      oldLine = Number(m[1]);
      newLine = Number(m[2]);
    } else if (line.startsWith('+++') || line.startsWith('---')) continue;
    else if (line.startsWith('+')) cur.added.push({ line: newLine++, text: line.slice(1) });
    else if (line.startsWith('-')) cur.removed.push({ line: oldLine++, text: line.slice(1) });
    else if (line.startsWith(' ')) (oldLine++, newLine++);
  }
  return files;
}

// base, head: {path: text | null}. head is applied on top of base.
export function repo(base, head) {
  const dir = mkdtempSync(join(tmpdir(), 'sdt-checks-'));
  run(dir, ['init', '-q', '-b', 'main']);
  run(dir, ['config', 'user.email', 't@example.com']);
  run(dir, ['config', 'user.name', 't']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  write(dir, { 'README.md': 'x\n', ...base });
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', 'base']);
  const baseSha = run(dir, ['rev-parse', 'HEAD']).trim();
  write(dir, head);
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '--allow-empty', '-m', 'head']);
  const headSha = run(dir, ['rev-parse', 'HEAD']).trim();
  const files = parse(run(dir, ['diff', '--no-color', '-M', `${baseSha}...${headSha}`]));
  return { dir, baseSha, headSha, files, git: (args) => run(dir, args), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// The context the engine passes to run().
export const ctx = (r) => ({ files: r.files, repoRoot: r.dir, baseSha: r.baseSha, headSha: r.headSha, title: 't', config: {}, git: r.git });

export const byName = (mod, name) => mod.default.find((c) => c.name === name);
