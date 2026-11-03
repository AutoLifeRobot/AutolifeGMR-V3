'use strict';

// Repository-local routing; only obsolete Actions runs may be cancelled here.
const fs = require('node:fs');
const path = require('node:path');

function candidate(pull, repository) {
  return pull && pull.state === 'open' && !pull.draft &&
    pull.base.ref === 'main' && pull.head.ref.startsWith('candidate/') &&
    pull.head.repo?.full_name === repository && pull.base.repo?.full_name === repository;
}

function classify({event, action, ref, repository, pull, openPulls = [], baseChanged = false}) {
  if (event === 'pull_request') {
    if (action === 'closed' || (action === 'edited' && !baseChanged)) {
      return {quick: false, full: false, reason: 'closed-or-non-code-edit'};
    }
    const full = candidate(pull, repository);
    return {quick: !full, full: Boolean(full), reason: full ? 'ready-candidate' : 'development-or-draft'};
  }
  if (event === 'push') {
    if (ref === 'refs/heads/main' || !ref.startsWith('refs/heads/')) {
      return {quick: false, full: false, reason: 'formal-or-non-branch'};
    }
    // PR events own both quick and full checks when a PR is open.
    return {quick: openPulls.length === 0, full: false,
      reason: openPulls.length ? 'owned-by-pr-event' : 'development-push'};
  }
  if (event === 'workflow_dispatch') return {quick: true, full: false, reason: 'manual-check'};
  throw new Error('Unsupported workflow event');
}

function identity({kind, version, offset, runNumber, runId, sha, headSha = sha, baseSha = ''}) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) || !['candidate', 'formal'].includes(kind)) {
    throw new Error('Invalid delivery version/kind');
  }
  for (const value of [runNumber, runId]) {
    if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) throw new Error('Invalid Actions identity');
  }
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      ![sha, headSha].every(value => /^[a-f0-9]{40}$/.test(value)) ||
      (baseSha !== '' && !/^[a-f0-9]{40}$/.test(baseSha))) {
    throw new Error('Invalid release offset/source SHA');
  }
  // Candidate run IDs are diagnostic identities, never formal release counters.
  const build = kind === 'formal' ? offset + Number(runNumber) : Number(runId);
  if (!Number.isSafeInteger(build)) throw new Error('Build number overflow');
  return {kind, version, build_number: build, release_version: `${version}+build${build}`,
    release_id: `${version}-build${build}`, source_sha: sha, head_sha: headSha,
    base_sha: baseSha, run_id: Number(runId)};
}

async function cancelOlder({github, context, core, pull, mode}) {
  // Never let a delayed event cancel a newer run. Metadata-only edits return
  // before this function; a base edit or Draft conversion may retire old full work.
  const workflow = mode === 'candidate' ? 'candidate.yml' : 'ci.yml';
  const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
    ...context.repo, workflow_id: workflow, per_page: 100,
    ...(pull ? {} : {branch: context.ref.slice('refs/heads/'.length)})});
  for (const run of runs) {
    const sameSource = pull
      ? (run.pull_requests || []).some(item => item.number === pull.number) ||
        (['push', 'workflow_dispatch'].includes(run.event) && run.head_branch === pull.head.ref)
      : run.event === 'push' && run.head_branch === context.ref.slice('refs/heads/'.length);
    // Let same-commit push routers finish normally when a PR owns validation.
    // Cancelling their cleanup produces misleading failed/cancelled checks.
    if (pull && run.event === 'push' && run.head_sha === pull.head.sha && pull.state === 'open') continue;
    if (!sameSource || Number(run.id) >= Number(context.runId) ||
        !['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)) continue;
    try {
      await github.rest.actions.cancelWorkflowRun({...context.repo, run_id: run.id});
      core.info(`Cancelled obsolete ${workflow} run ${run.id}`);
    } catch (error) {
      // A concurrently completed run is harmless; authentication/network failures are not.
      if (error.status !== 409) throw error;
    }
  }
}

async function route({github, context, core, root = process.cwd(), mode = 'quick', cancelObsolete = true}) {
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  let pull = context.payload.pull_request;
  // Read current state, rejecting obsolete synchronize jobs rather than building stale code.
  if (pull) {
    const current = (await github.rest.pulls.get({...context.repo, pull_number: pull.number})).data;
    if (['head', 'base'].some(side => current[side].sha !== pull[side].sha ||
          current[side].ref !== pull[side].ref) ||
        current.state !== pull.state || current.draft !== pull.draft) {
      core.setOutput('quick', 'false'); core.setOutput('full', 'false');
      core.info('PR source/base changed since this event; the new event owns validation.');
      return;
    }
    pull = current;
  }
  let openPulls = [];
  if (context.eventName === 'push' && context.ref.startsWith('refs/heads/') && context.ref !== 'refs/heads/main') {
    openPulls = await github.paginate(github.rest.pulls.list, {...context.repo, state: 'open',
      head: `${context.repo.owner}:${context.ref.slice('refs/heads/'.length)}`, per_page: 100});
  }
  let decision;
  if (mode === 'formal') {
    if (context.ref !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(context.eventName)) {
      throw new Error('Formal publication requires a main release event');
    }
    decision = {quick: false, full: true, reason: 'formal-main-rebuild'};
  } else {
    decision = classify({event: context.eventName, action: context.payload.action,
      ref: context.ref, repository, pull, openPulls, baseChanged: Boolean(context.payload.changes?.base)});
    if (['candidate', 'checks'].includes(mode) && context.eventName === 'workflow_dispatch') {
      const prs = await github.paginate(github.rest.pulls.list, {...context.repo, state: 'open',
        base: 'main', head: `${context.repo.owner}:${context.ref.slice('refs/heads/'.length)}`, per_page: 100});
      const matches = prs.filter(p => candidate(p, repository) && p.head.sha === context.sha &&
        context.ref === `refs/heads/${p.head.ref}`);
      if (matches.length !== 1) throw new Error('Manual candidate validation requires one current Ready candidate-to-main PR');
      pull = (await github.rest.pulls.get({...context.repo, pull_number: matches[0].number})).data;
      if (!candidate(pull, repository) || pull.number !== matches[0].number || pull.head.sha !== context.sha ||
          context.ref !== `refs/heads/${pull.head.ref}`) {
        throw new Error('Manual candidate PR changed after branch discovery');
      }
      decision = {quick: false, full: true, reason: 'manual-ready-candidate'};
    }
  }
  // Each workflow owns one path; both still retire their own obsolete runs
  // after Draft/base/closed changes, even when no new build is selected.
  if (mode === 'quick') decision = {...decision, full: false};
  if (mode === 'candidate') decision = {...decision, quick: false};
  if (cancelObsolete && decision.reason !== 'owned-by-pr-event' && mode !== 'formal' && !(context.payload.action === 'edited' && !context.payload.changes?.base)) {
    await cancelOlder({github, context, core, pull, mode});
  }
  for (const [key, value] of Object.entries(decision)) core.setOutput(key, String(value));
  if (decision.full) {
    const policy = JSON.parse(fs.readFileSync(path.join(root, 'ci/release-policy.json'), 'utf8'));
    const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    const result = identity({kind: mode === 'formal' ? 'formal' : 'candidate', version,
      offset: policy.formal_build_offset, runNumber: process.env.GITHUB_RUN_NUMBER,
      runId: context.runId, sha: context.sha, headSha: pull?.head.sha || context.sha,
      baseSha: pull?.base.sha || ''});
    result.source_ref = context.ref;
    for (const [key, value] of Object.entries(result)) core.setOutput(key, String(value));
    // Internal qualification lock only: public delivery identity stays unchanged.
    core.setOutput('head_ref', mode !== 'formal' && pull ? pull.head.ref : '');
    core.setOutput('pr_number', mode !== 'formal' && pull ? String(pull.number) : '');
    core.setOutput('identity', JSON.stringify(result));
  }
  core.info(`DevOps v1.1: ${decision.reason}`);
}

function requireSuccess(needs, required) {
  const failed = required.filter(name => !needs[name] || needs[name].result !== 'success');
  if (failed.length) throw new Error(`Required jobs did not succeed: ${failed.join(', ')}`);
}

module.exports = {candidate, classify, identity, route, requireSuccess, cancelOlder};
