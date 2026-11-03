'use strict';
// A downloadable development original, never a system channel or formal release.
function identity({repository, ref, sha, eventName, runId, attempt, date = new Date()}) {
  const isoPush = eventName === 'push' && ref === 'refs/heads/feat/v3-release-iso';
  if ((!isoPush && eventName !== 'workflow_dispatch') || !ref.startsWith('refs/heads/'))
    throw new Error('Development packaging requires a manual branch run or an ISO branch push');
  if (!/^[^/]+\/[^/]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(sha) ||
      ![runId, attempt].every(n => /^[1-9][0-9]*$/.test(String(n)) && Number.isSafeInteger(Number(n))) ||
      !(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw new Error('Invalid development identity');
  const slug = value => value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 80) || 'branch';
  const branch = ref.slice('refs/heads/'.length);
  // UTC milliseconds distinguish separate manual runs and retries of one commit.
  const timestamp = date.toISOString().replace(/[-:.]/g, '');
  return {name: `${slug(repository.split('/')[1])}-${slug(branch)}-${timestamp}-${sha.slice(0, 8)}`,
    build_number: String(runId), branch, source_sha: sha};
}
module.exports = {identity};
