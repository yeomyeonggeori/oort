// Node-only test fixture for `direct-copy-ci.test.ts` (#5589 r2 M1); not part of the runtime exports.
//
// Runs the real "직접 문구 장부" step of `.github/workflows/pr-ci.yml` in a throwaway repository, on a
// shallow checkout of a PR merge ref (as actions/checkout makes it), with GitHub's expressions filled in
// the way GitHub fills them. The review's reproduction:
//   u1 (v2 ledger) → PR-A lands with raise #5700 (u2) → PR-B, branched from u1, changes no copy.
//   GitHub's `pull_request.base.sha` for PR-B stays u1 (the merge-base). Against u1, PR-B would "add"
//   #5700, and after an approved re-anchor lands (u3) it would go RED.
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ANCHOR_SEAL, LEDGER_PATH, TOOL_PATH, anchorSeal, serializeLedger} from './direct-copy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const STEP = /^(\s*)- name: 직접 문구 장부/;
const indentOf = line => line.length - line.trimStart().length;

/** A file of this repository, read from disk (tests in the core have no Node types). */
export function readRepoFile(file) {
  return readFileSync(join(ROOT, file), 'utf8');
}

/** The ledger step's `env:` map and `run: |` script, as written in the workflow. */
export function workflowLedgerStep(workflow = readRepoFile('.github/workflows/pr-ci.yml')) {
  const lines = workflow.split('\n');
  const start = lines.findIndex(line => STEP.test(line));
  if (start < 0) throw new Error('pr-ci.yml: the direct-copy ledger step is missing');
  const indent = STEP.exec(lines[start])[1].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && indentOf(line) <= indent) break;
    body.push(line);
  }
  const keyIndent = indent + 2;
  const at = key => body.findIndex(line => indentOf(line) === keyIndent && line.trimStart().startsWith(`${key}:`));
  const block = from => {
    const out = [];
    for (const line of body.slice(from + 1)) {
      if (line.trim() && indentOf(line) <= keyIndent) break;
      out.push(line);
    }
    return out;
  };
  const env = {};
  if (at('env') >= 0) {
    for (const line of block(at('env'))) {
      const match = /^\s*([A-Z_][A-Z0-9_]*):\s*(.*)$/.exec(line);
      if (match) env[match[1]] = match[2];
    }
  }
  const run = at('run');
  if (run < 0 || !/run:\s*\|\s*$/.test(body[run])) throw new Error('pr-ci.yml: the ledger step needs a `run: |` block');
  return {env, script: block(run).map(line => line.slice(keyIndent + 2)).join('\n')};
}

const A = 'clients/web/src/A.tsx';
const C = 'clients/web/src/C.tsx';
const REASON = 'Banner sentence waits for the P1 web extraction of this screen.';

/**
 * Builds the track history, runs the workflow step on four refs and removes everything.
 * Returns `{runs: {afterRaise, afterReanchor, notMerge, unraisedCopy}, u2, u3}`; each run is `{status, out, mergeBase}`.
 */
export function runLedgerStepScenario({workflow} = {}) {
  const step = workflowLedgerStep(workflow);
  const work = mkdtempSync(join(tmpdir(), 'oort-direct-copy-ci-'));
  try {
    writeFileSync(join(work, 'gitconfig'), '[init]\n\tdefaultBranch = track\n[commit]\n\tgpgsign = false\n[core]\n\thooksPath = /dev/null\n');
    // Never the developer's git: no inherited GIT_DIR, hooks, signing or global config.
    const gitEnv = {
      PATH: process.env.PATH ?? '', HOME: work, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(work, 'gitconfig'),
      GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    };
    const git = (cwd, ...args) => execFileSync('git', args, {cwd, env: gitEnv, encoding: 'utf8'}).trim();
    const realTool = readRepoFile(TOOL_PATH);
    const sealed = (anchorHead, anchor, raises = []) => {
      const ledger = {version: 2, anchorHead, anchor, lowered: {}, raises};
      // The real tool, with the fixture's seal in place of the committed one.
      const tool = realTool.replace(`export const ANCHOR_SEAL = '${ANCHOR_SEAL}';`, `export const ANCHOR_SEAL = '${anchorSeal(ledger)}';`);
      if (tool === realTool) throw new Error('could not place the fixture seal in direct-copy.mjs');
      return {[TOOL_PATH]: tool, [LEDGER_PATH]: serializeLedger(ledger)};
    };
    const write = (repo, files) => {
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(repo, file)), {recursive: true});
        writeFileSync(join(repo, file), text);
      }
    };

    const origin = join(work, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q');
    // GitHub serves a reachable commit by its id; a local origin needs this to do the same.
    git(origin, 'config', 'uploadpack.allowReachableSHA1InWant', 'true');
    write(origin, {...sealed('1'.repeat(40), {[A]: {ko: 1, en: 0}}), [A]: 'export const A = () => <p>새 글이 있어요</p>;\n', 'notes.md': 'one\n'});
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'u1: #5598 landed (v2 ledger)');
    const u1 = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'checkout', '-qb', 'pr-b', u1);
    write(origin, {'notes.md': 'one\ntwo\n'});
    git(origin, 'commit', '-qam', 'PR-B: no copy change');
    const prB = git(origin, 'rev-parse', 'HEAD');

    git(origin, 'checkout', '-qb', 'pr-a', u1);
    write(origin, {
      [LEDGER_PATH]: sealed('1'.repeat(40), {[A]: {ko: 1, en: 0}}, [{file: A, issue: 5700, ko: 1, reason: REASON}])[LEDGER_PATH],
      [A]: 'export const A = () => <><p>새 글이 있어요</p><p>다시 볼까요</p></>;\n',
    });
    git(origin, 'commit', '-qam', 'PR-A: one raise #5700');
    git(origin, 'checkout', '-q', 'track');
    git(origin, 'merge', '-q', '--no-ff', '-m', 'u2: PR-A landed', 'pr-a');
    const u2 = git(origin, 'rev-parse', 'HEAD');

    const refs = {};
    const mergeRef = (name, track, head) => {
      git(origin, 'checkout', '-q', '--detach', track);
      git(origin, 'merge', '-q', '--no-ff', '-m', `Merge ${head} into ${track}`, head);
      const merge = git(origin, 'rev-parse', 'HEAD');
      git(origin, 'update-ref', `refs/pull/${name}/merge`, merge);
      refs[name] = {merge, head, mergeBase: git(origin, 'merge-base', track, head)};
      git(origin, 'checkout', '-q', 'track');
    };
    mergeRef('1', u2, prB);
    // An approved re-anchor lands on the track: a new anchor and a new seal.
    write(origin, sealed('2'.repeat(40), {[A]: {ko: 2, en: 0}}));
    git(origin, 'commit', '-qam', 'u3: approved re-anchor');
    const u3 = git(origin, 'rev-parse', 'HEAD');
    mergeRef('2', u3, prB);
    // PR-C, after the re-anchor: a new file with two Korean lines and a raise for only one of them.
    git(origin, 'checkout', '-qb', 'pr-c', u3);
    write(origin, {
      [LEDGER_PATH]: sealed('2'.repeat(40), {[A]: {ko: 2, en: 0}}, [{file: C, issue: 5701, ko: 1, reason: REASON}])[LEDGER_PATH],
      [C]: 'export const C = () => <><p>처음 보는 글</p><p>올리지 않은 글</p></>;\n',
    });
    git(origin, 'add', '-A');
    git(origin, 'commit', '-qm', 'PR-C: one raise, two lines');
    const prC = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'track');
    mergeRef('4', u3, prC);
    // Not a merge ref: the PR head itself.
    git(origin, 'update-ref', 'refs/pull/3/merge', prB);
    refs['3'] = {merge: prB, head: prB, mergeBase: u1};

    const bin = join(work, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 0\n'); // no labels
    chmodSync(join(bin, 'gh'), 0o755);

    const run = name => {
      const ci = join(work, `ci-${name}`);
      mkdirSync(ci);
      git(ci, 'init', '-q');
      git(ci, 'remote', 'add', 'origin', `file://${origin}`);
      git(ci, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', `refs/pull/${name}/merge`);
      git(ci, 'checkout', '-q', '--detach', 'FETCH_HEAD');
      symlinkSync(join(ROOT, 'node_modules'), join(ci, 'node_modules'));
      const context = {
        'secrets.GITHUB_TOKEN': 'fixture-not-a-credential',
        'github.repository': 'example/oort',
        'github.event.pull_request.number': name,
        'github.event.pull_request.base.sha': refs[name].mergeBase,
        'github.event.pull_request.head.sha': refs[name].head,
        'github.sha': refs[name].merge,
      };
      const fill = text => text.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
        if (!Object.hasOwn(context, expr)) throw new Error(`the ledger step uses \${{ ${expr} }}; teach this fixture what GitHub puts there`);
        return context[expr];
      });
      const env = Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, fill(value)]));
      const result = spawnSync('bash', ['-c', fill(step.script)], {
        cwd: ci, encoding: 'utf8', timeout: 60_000, env: {...gitEnv, PATH: `${bin}:${gitEnv.PATH}`, ...env},
      });
      return {status: result.status, out: `${result.stdout ?? ''}\n${result.stderr ?? ''}`, mergeBase: refs[name].mergeBase};
    };
    return {runs: {afterRaise: run('1'), afterReanchor: run('2'), notMerge: run('3'), unraisedCopy: run('4')}, u2, u3};
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}
