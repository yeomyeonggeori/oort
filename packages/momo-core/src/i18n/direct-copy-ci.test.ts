// #5589 r2 M1: PR CI compares the ledger with the base of the *merge ref* (the track tip it merged), not
// with GitHub's `pull_request.base.sha` (the merge-base). The fixture runs the workflow step as written.
import {beforeAll, describe, expect, it} from 'vitest';
import {runLedgerStepScenario, workflowLedgerStep} from './tooling/direct-copy-ci-fixture.mjs';

describe('PR CI ledger step compares with the merge ref base (#5589 r2 M1)', () => {
  let scenario: ReturnType<typeof runLedgerStepScenario>;
  beforeAll(() => { scenario = runLedgerStepScenario(); }, 60_000);

  it('after another PR landed a raise, the PR is not charged with it', () => {
    const {runs: {afterRaise}, u2} = scenario;
    expect(afterRaise.mergeBase).not.toBe(u2); // GitHub's base.sha is the old track tip here
    expect(afterRaise.out).toContain(`direct-copy: 0 new raise(s) against base ${u2.slice(0, 12)}`);
    expect(afterRaise.out).not.toContain('#5700');
    expect(afterRaise.status).toBe(0);
  });

  it('after an approved re-anchor landed, an unlabelled PR without copy changes stays green', () => {
    const {runs: {afterReanchor}, u3} = scenario;
    expect(afterReanchor.out).toContain(`direct-copy: 0 new raise(s) against base ${u3.slice(0, 12)}`);
    expect(afterReanchor.out).not.toMatch(/differs from the base/);
    expect(afterReanchor.status).toBe(0);
  });

  it('refuses a checkout that is not a merge ref instead of guessing a base', () => {
    expect(scenario.runs.notMerge.out).toMatch(/병합 ref\(부모 둘\)가 아니에요/);
    expect(scenario.runs.notMerge.status).not.toBe(0);
  });

  it('runs the three-surface check first and keeps the token away from node (r2 L-a, L-c)', () => {
    const {script, env} = workflowLedgerStep();
    expect(script).toMatch(/env -u GH_TOKEN node "\$tool" check\n/);
    expect(script).toMatch(/env -u GH_TOKEN DIRECT_COPY_REANCHOR_APPROVED="\$approved" node "\$tool" compare-base "\$base"/);
    expect(Object.keys(env)).not.toContain('BASE_SHA');
  });
});
