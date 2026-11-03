'use strict';
// Summary survives Artifact service failures. Required job results remain authoritative.
async function receipt({github, context, core, needs, attempt}) {
  const names = ['source', 'package', 'verify'];
  const selected = new Map();
  let lookupError = '';
  try {
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 100) throw new Error('Invalid attempt');
    // Partial retries reuse successful upstream jobs from earlier attempts.
    for (let n = attempt; n >= 1 && selected.size < names.length; n--) {
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt,
        {...context.repo, run_id: context.runId, attempt_number: n, per_page: 100});
      for (const job of jobs)
        {
          const name=job.name.replace(/^development \/ /,'');
          if(names.includes(name) && !selected.has(name)) selected.set(name,{...job,name,attempt:n});
        }
    }
  } catch (error) {
    lookupError = 'Runner details unavailable; required job results are shown below.';
    core.warning(lookupError);
  }
  const passed = names.every(name => needs[name]?.result === 'success');
  const rows = [[ 'Stage', 'Result', 'Runner', 'Attempt', 'Failed step' ]];
  for (const name of names) {
    const job = selected.get(name);
    rows.push([name, needs[name]?.result || 'missing', job?.runner_name || 'unavailable',
      String(job?.attempt || ''), (job?.steps || []).filter(s => s.conclusion === 'failure').map(s => s.name).join(', ') || '—']);
  }
  const url = `${context.serverUrl || 'https://github.com'}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}/attempts/${attempt}`;
  core.summary.addHeading(`Development receipt: ${passed ? 'SUCCESS' : 'FAILED'}`)
    .addLink('Run and job logs', url).addRaw('\n')
    .addRaw(`\nSelected source commit: ${context.sha}. Run ${context.runId}, attempt ${attempt}.\n`)
    .addTable(rows)
    .addRaw('\nThis receipt covers build, verification and GitHub artifact delivery. Release server publication has its own workflow result.\n');
  core.summary.addLink('Check Component publication for server upload results',
    `${context.serverUrl || 'https://github.com'}/${context.repo.owner}/${context.repo.repo}/actions/workflows/component-publication.yml`).addRaw('\n');
  if (lookupError) core.summary.addRaw(`\n${lookupError}\n`);
  await core.summary.write();
  core.info(`Development receipt: ${passed ? 'SUCCESS' : 'FAILED'}. ${url}`);
  if (!passed) core.setFailed('Development failed; see the receipt for stage and runner details');
  return passed;
}
module.exports = {receipt};
