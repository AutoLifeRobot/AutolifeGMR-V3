'use strict';
const fs = require('node:fs');
function read(filename) {
  try {return JSON.parse(fs.readFileSync(filename,'utf8'));} catch {return null;}
}
async function receipt({core,context,outcome,jobStatus,server,identity,result}) {
  const control=read(identity), response=read(result);
  const version=control?.delivery?.release_version;
  const validVersion=typeof version==='string' && /^[0-9][A-Za-z0-9.+:~-]{0,127}$/.test(version);
  const verified=outcome==='success' && response?.phase==='committed' &&
    /^[a-f0-9]{32}$/.test(response?.id || '') && validVersion && response.version===version;
  const failed=outcome==='failure' || jobStatus==='failure' || (outcome==='success'&&!verified);
  const status=failed?'FAILED':verified?'SUCCESS':'NOT UPLOADED';
  core.summary.addHeading(`GMR server upload: ${status}`).addTable([
    ['Field','Result'],['Server',server],['Version',validVersion?version:'unavailable'],
    ['Runner',process.env.RUNNER_NAME || 'unavailable'],['Upload step',outcome || 'not started'],
    ['Server commit',verified?'committed':'not confirmed'],
    // The pinned Release helper exits successfully only after delivery verification.
    ['Delivery verification',verified?'verified':'not confirmed'],
    ['Publication session',/^[a-f0-9]{32}$/.test(response?.id || '')?response.id:'unavailable']
  ]);
  const source=context.payload?.workflow_run?.html_url;
  if(source) core.summary.addLink('Source Development run',source).addRaw('\n');
  if(verified) core.summary.addCodeBlock(
    `just download gmr --version ${version} --channel dev\njust install --component gmr --version ${version} --channel dev --yes`,'bash');
  else core.summary.addRaw('\nServer publication is not confirmed. Check the admission and upload step logs.\n');
  await core.summary.write();
  core.info(`GMR server upload: ${status}`);
  if(failed) core.setFailed('Server upload failed or its receipt is incomplete');
  return status;
}
module.exports={receipt};
