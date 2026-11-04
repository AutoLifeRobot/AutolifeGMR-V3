'use strict';
// Trusted controller. Never load a module, workflow or executable from source artifacts.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const requireThat = (value, message) => { if (!value) throw new Error(message); };
const sha = value => /^[a-f0-9]{40}$/.test(value || '');
const positive = value => Number.isSafeInteger(value) && value > 0;
// Selected only by reviewed default-branch workflow code, never an input or artifact.
const PRODUCER_PROFILES = Object.freeze({
  'gmr':{producer:'package',verify:'verify',gates:['source','package','verify','development-full-gate']},
  release:{producer:'package',verify:'verify',sourceJobs:['check','package'],gates:['source','check','package','verify','development-full-gate']},
  network:{producer:'runtime-packages',verify:'verify',gates:['source','identity','rust','binary-foundation','binary-foundation-consumer','android-public-aar','runtime-packages','delivery-gate','verify','development-full-gate']},
  media:{producer:'binary-consumer',verify:'verify',gates:['source','identity','inputs','binary-consumer','delivery-gate','verify','development-full-gate']},
  sdk:{producer:'package',verify:'verify',sourceJobs:['documentation','sensor-faults','motor-vcan','software-gate','build-simulation-runtime','simulation','package','shm-build'],gates:['source','documentation','sensor-faults','motor-vcan','software-gate','build-simulation-runtime','simulation','package','verify-package','security','software-summary','qualification','shm-build','shm-python',...['pybullet','mujoco','gazebo'].map(b=>'package-simulation-'+b),...['3.8.20','3.9.24','3.10.22','3.11.17','3.12.15','3.13.16','3.14.8','3.15.0rc3','3.16.0a0'].map(v=>'shm-consume-'+v),'verify','development-full-gate']}
});
function producerProfile(name='release') {
  requireThat(Object.hasOwn(PRODUCER_PROFILES,name),'Unknown trusted producer profile');
  const value=PRODUCER_PROFILES[name];
  // Include package-only consumers: executing an original's verification code is
  // still untrusted execution and must follow the immutable source control.
  return {...value,sourceJobs:name==='release'?value.sourceJobs:value.gates.filter(n=>!['source','inputs','verify','development-full-gate'].includes(n))};
}

function identity({component, version, source_sha, tree_sha, source_ref, run_id, run_attempt, control_sha, repository, upload}) {
  requireThat(/^[a-z][a-z0-9-]*$/.test(component || '') && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version || '') &&
    [source_sha,tree_sha,control_sha].every(sha) && /^refs\/heads\/[^\s~^:?*\[\\]+$/.test(source_ref || '') &&
    positive(run_id) && positive(run_attempt) && /^[^/\s]+\/[^/\s]+$/.test(repository || '') && typeof upload === 'boolean', 'Invalid development source identity');
  return {schema:'autolife.development-control/1', component, repository, control_sha, tree_sha, upload,
    delivery:{kind:'development',version,release_version:`${version}+dev.${run_id}`,source_sha,source_ref,run_id,run_attempt}};
}
function validateControl(value) {
  requireThat(value?.schema === 'autolife.development-control/1', 'Missing trusted development control');
  const result = identity({...value,...value.delivery});
  requireThat(require('node:util').isDeepStrictEqual(result,value), 'Development control identity changed');
  return value;
}
function controllerReference(run,repository,defaultBranch) {
  const prefix=`${repository}/.github/workflows/development-controller.yml@`;
  const refs=(run.referenced_workflows || []).filter(r=>typeof r.path==='string' && r.path.startsWith(prefix));
  requireThat(refs.length===1 && refs[0].ref===`refs/heads/${defaultBranch}` && sha(refs[0].sha) &&
    [refs[0].sha,defaultBranch,`refs/heads/${defaultBranch}`].some(ref=>refs[0].path===prefix+ref),
    'Missing exact default-branch development controller');
  return refs[0].sha;
}
async function callerDefinition({github,context,sourceSha,controllerSha}) {
  const files=await Promise.all([sourceSha,controllerSha].map(ref=>github.rest.repos.getContent({
    ...context.repo,path:'.github/workflows/development.yml',ref})));
  const [source,controller]=files.map(result=>result.data);
  requireThat(source.type==='file' && controller.type==='file' && sha(source.sha) && source.sha===controller.sha,
    'Selected branch must use the reviewed Development entrypoint');
  return {source:source.sha,controller:controller.sha};
}
function normalizeJobs(jobs,profile) {
  if(profile!=='gmr') return jobs;
  const prefix='development / ';
  return jobs.filter(job=>job.name.startsWith(prefix)).map(job=>({...job,name:job.name.slice(prefix.length)}));
}
async function frozenSource({github,context,branch,profile='release',controllerSha=context.sha}) {
  const attempt=Number(process.env.GITHUB_RUN_ATTEMPT);
  requireThat(positive(attempt) && attempt <= 100,'Invalid source attempt');
  if(attempt === 1) return null;
  const jobs=[];
  for(let n=1;n<attempt;n++) {
    const entries=await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt,{...context.repo,run_id:context.runId,attempt_number:n,per_page:100});
    jobs.push(...normalizeJobs(entries,profile).map(job=>({...job,run_attempt:n})));
  }
  const source=jobs.filter(job=>job.name==='source' && job.conclusion==='success').sort((a,b)=>a.run_attempt-b.run_attempt)[0];
  if(!source) return null; // No source was ever admitted; no earlier original can exist.
  const artifacts=await github.paginate(github.rest.actions.listWorkflowRunArtifacts,{...context.repo,run_id:context.runId,per_page:100});
  const matches=artifacts.filter(a=>a.name===`development-control-${context.runId}-${source.run_attempt}`);
  requireThat(matches.length===1,'Frozen source control is missing; retry refused');
  const untrusted=jobs.filter(job=>producerProfile(profile).sourceJobs.includes(job.name) && Date.parse(job.started_at));
  requireThat(!untrusted.length || Date.parse(matches[0].created_at)<Math.min(...untrusted.map(job=>Date.parse(job.started_at))), 'Frozen source control was replaced');
  const directory=path.join(process.env.RUNNER_TEMP,`frozen-source-${context.runId}-${attempt}`);
  await download({github,context,artifact:matches[0],directory});
  requireThat(fs.readdirSync(directory).join()==='development-control.json','Unexpected frozen source control');
  const value=validateControl(JSON.parse(fs.readFileSync(path.join(directory,'development-control.json'))));
  requireThat(value.control_sha===controllerSha && value.delivery.run_id===Number(context.runId) &&
    value.delivery.run_attempt===source.run_attempt && value.delivery.source_ref===`refs/heads/${branch}` &&
    value.repository===`${context.repo.owner}/${context.repo.repo}`, 'Frozen source/control differs from original run');
  return value;
}

async function resolve({github,context,core,component='release',profile='release',upload=context.payload.inputs?.upload !== 'false'}) {
  producerProfile(profile);
  const repository = (await github.rest.repos.get(context.repo)).data;
  const selected=profile==='gmr';
  requireThat(context.eventName === 'workflow_dispatch' && sha(process.env.GITHUB_WORKFLOW_SHA) &&
    (selected || process.env.GITHUB_WORKFLOW_SHA === context.sha) &&
    (selected ? /^refs\/heads\/[^\s~^:?*\[\\]+$/.test(context.ref) : context.ref === `refs/heads/${repository.default_branch}`),
    'Development must select a same-repository branch');
  const branch = selected ? context.ref.slice('refs/heads/'.length) : context.payload.inputs?.source_branch;
  requireThat(typeof branch === 'string' && branch.length > 0 && branch.length < 240 && !branch.startsWith('refs/'), 'Invalid source branch');
  let controllerSha=context.sha;
  if(selected) {
    const run=(await github.rest.actions.getWorkflowRun({...context.repo,run_id:context.runId})).data;
    requireThat(run.head_sha===context.sha && run.head_branch===branch && run.event==='workflow_dispatch' &&
      run.repository?.full_name===repository.full_name && run.head_repository?.full_name===repository.full_name,
      'Dispatch source differs from the selected repository branch');
    controllerSha=controllerReference(run,repository.full_name,repository.default_branch);
    requireThat([context.sha,controllerSha].includes(process.env.GITHUB_WORKFLOW_SHA),'Workflow revision differs from selected source and trusted controller');
    await callerDefinition({github,context,sourceSha:context.sha,controllerSha});
  }
  const previous=await frozenSource({github,context,branch,profile,controllerSha});
  let value;
  if(previous) {
    requireThat(previous.component===component && previous.upload===upload,'Frozen source inputs changed');
    value=identity({...previous,...previous.delivery,run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT)});
  } else {
    // Dispatch SHA is immutable even when the selected branch moves or a run retries.
    const ref = selected ? {ref:context.ref,object:{type:'commit',sha:context.sha}} :
      (await github.rest.git.getRef({...context.repo,ref:`heads/${branch}`})).data;
    requireThat(ref.ref === `refs/heads/${branch}` && ref.object.type === 'commit', 'Source must be an exact branch');
    const commit = (await github.rest.git.getCommit({...context.repo,commit_sha:ref.object.sha})).data;
    requireThat(commit.sha===ref.object.sha,'Source commit changed');
    const file = (await github.rest.repos.getContent({...context.repo,path:'VERSION',ref:commit.sha})).data;
    requireThat(file.type === 'file' && file.encoding === 'base64', 'Source VERSION is unavailable');
    value = identity({component,version:Buffer.from(file.content,'base64').toString('utf8').trim(),source_sha:commit.sha,
      tree_sha:commit.tree.sha,source_ref:ref.ref,run_id:Number(context.runId),run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT),
      control_sha:controllerSha,repository:repository.full_name,upload});
  }
  fs.writeFileSync('development-control.json',JSON.stringify(value,null,2)+'\n');
  for (const [key,item] of Object.entries({control:JSON.stringify(value),delivery:JSON.stringify(value.delivery),
    source_sha:value.delivery.source_sha,controller_sha:value.control_sha,version:value.delivery.release_version})) core.setOutput(key,item);
  return value;
}
async function gatePublication({github,context}) {
  const repo = (await github.rest.repos.get(context.repo)).data;
  requireThat(context.ref === `refs/heads/${repo.default_branch}` && process.env.GITHUB_WORKFLOW_SHA === context.sha,
    'Publication controller must execute the default branch');
  return repo;
}
function effectiveJobs(jobs,attempt) {
  const result={};
  for(const job of jobs) {
    requireThat(positive(job.run_attempt) && job.run_attempt <= attempt,'Invalid gate attempt');
    const previous=result[job.name];
    if(!previous || previous.run_attempt < job.run_attempt) result[job.name]=job;
    else if(previous.run_attempt === job.run_attempt) throw new Error('Ambiguous duplicate gate');
  }
  return result;
}
function producerControl({control,context,core}) {
  validateControl(control);
  requireThat((control.component==='gmr' ? control.delivery.source_sha === context.sha && control.delivery.source_ref === context.ref : control.control_sha === context.sha) &&
    control.delivery.run_id === Number(context.runId), 'Producer source/control changed');
  const value=identity({...control,...control.delivery,run_attempt:Number(process.env.GITHUB_RUN_ATTEMPT)});
  fs.writeFileSync('producer-control.json',JSON.stringify(value,null,2)+'\n');
  core.setOutput('control',JSON.stringify(value));core.setOutput('delivery',JSON.stringify(value.delivery));
  core.setOutput('producer_attempt',String(value.delivery.run_attempt));
  return value;
}
function publicationPlan({run,workflow,jobs,artifacts,control,sourceControl,defaultBranch,repository,controlArtifact,producerArtifact,profile='release',callerBlobs}) {
  validateControl(control);validateControl(sourceControl);
  const contract=producerProfile(profile);
  requireThat(profile==='release'||control.component===profile,'Producer profile differs from component');
  const delivery=control.delivery, gates=effectiveJobs(normalizeJobs(jobs,profile),Number(run.run_attempt));
  const controllerSha=profile==='gmr'?controllerReference(run,repository,defaultBranch):run.head_sha;
  if(profile==='gmr') requireThat(sha(callerBlobs?.source) && callerBlobs.source===callerBlobs.controller,
    'Unreviewed Development caller workflow');
  requireThat(run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success' &&
    run.head_repository?.full_name === repository && run.repository?.full_name === repository &&
    (profile==='gmr' ? delivery.source_ref===`refs/heads/${run.head_branch}` && delivery.source_sha===run.head_sha : run.head_branch === defaultBranch) && run.path === '.github/workflows/development.yml' &&
    workflow.path === '.github/workflows/development.yml' && Number(run.workflow_id) === Number(workflow.id) &&
    control.repository === repository && control.control_sha === controllerSha && delivery.run_id === Number(run.id) &&
    delivery.run_attempt === gates[contract.producer]?.run_attempt &&
    require('node:util').isDeepStrictEqual(identity({...control,...control.delivery,run_attempt:sourceControl.delivery.run_attempt}),sourceControl),
    'Source run is not the trusted completed development workflow');
  for (const name of contract.gates) {
    const job=gates[name];
    requireThat(job?.conclusion === 'success' && job.status === 'completed' &&
      job.labels?.includes('ubuntu-24.04') && !job.labels.includes('self-hosted') && job.runner_group_name === 'GitHub Actions' &&
      job.head_sha === run.head_sha && Number(job.run_id) === Number(run.id), `Required runner gate did not succeed: ${name}`);
  }
  requireThat(sourceControl.delivery.run_attempt === gates.source.run_attempt && contract.gates.every(name=>gates[name].run_attempt>=gates.source.run_attempt) &&
    gates[contract.producer].run_attempt<=gates[contract.verify].run_attempt && gates[contract.verify].run_attempt<=gates['development-full-gate'].run_attempt,'Effective gates do not qualify this fixed source and producer');
  if(profile==='release') requireThat(
    gates.source.run_attempt <= gates.check.run_attempt && gates.source.run_attempt <= gates.package.run_attempt &&
    gates.check.run_attempt <= gates.package.run_attempt && gates.package.run_attempt <= gates.verify.run_attempt &&
    gates.verify.run_attempt <= gates['development-full-gate'].run_attempt, 'Effective gates do not qualify this fixed source and producer');
  const compile=gates[contract.producer].steps?.filter(step=>step.name === 'Compile, package and test the original');
  const firstSource=Math.min(...contract.sourceJobs.map(name=>Date.parse(gates[name]?.started_at)));
  requireThat(Number.isFinite(firstSource) && Date.parse(controlArtifact.created_at) < firstSource &&
    controlArtifact.name === `development-control-${run.id}-${gates.source.run_attempt}` &&
    compile?.length === 1 && compile[0].conclusion === 'success' &&
    Date.parse(producerArtifact.created_at) < Date.parse(compile[0].started_at) &&
    producerArtifact.name === `development-producer-control-${run.id}-${delivery.run_attempt}`, 'Control artifact was not sealed before untrusted execution');
  const selected=artifacts.filter(a=>a.name === `${control.component}-development-${run.id}-${gates.verify.run_attempt}`);
  requireThat(selected.length === 1 && !selected[0].expired && /^sha256:[a-f0-9]{64}$/.test(selected[0].digest || ''), 'Missing immutable original artifact digest');
  return {upload:control.upload,artifact:selected[0],control};
}
function deliveryManifest({control,files}) {
  validateControl(control);
  requireThat(Array.isArray(files) && files.length > 0 && files.length <= 200000 &&
    new Set(files.map(f=>f.path)).size === files.length && files.every(f=>
      Object.keys(f).sort().join() === 'path,sha256,size' && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(f.path || '') &&
      !['delivery-manifest.json','SHA256SUMS'].includes(f.path) && /^[a-f0-9]{64}$/.test(f.sha256 || '') &&
      Number.isSafeInteger(f.size) && f.size >= 0), 'Invalid exact original inventory');
  return {schema:'autolife.component-delivery/1',component:control.component === 'service-center' ? 'servicecenter' : control.component,
    version:control.delivery.version,source_sha:control.delivery.source_sha,tree_sha:control.tree_sha,source_dirty:false,delivery:control.delivery,files};
}

function seal({directory,consumer,control}) {
  validateControl(control);
  const receipt=JSON.parse(fs.readFileSync(consumer));
  const files=fs.readdirSync(directory).filter(n=>n.endsWith('.tar.gz'));
  requireThat(files.length === 1 && receipt.status === 'passed' && receipt.source_sha === control.delivery.source_sha &&
    receipt.version === control.delivery.release_version && receipt.distribution?.status === 'passed' &&
    receipt.distribution?.protocol === 'independent-client/1' && /^[a-f0-9]{64}$/.test(receipt.distribution?.receipt_sha256 || ''), 'Full original and two-client distribution gates are required');
  const file=path.join(directory,files[0]);
  requireThat(fs.lstatSync(file).isFile(), 'Original must be a regular file');
  const bytes=fs.readFileSync(file), original={path:files[0],sha256:sha256(bytes),size:bytes.length};
  requireThat(original.sha256 === receipt.archive_sha256, 'Consumer verified different original bytes');
  const manifest=deliveryManifest({control,files:[original]});
  const data=JSON.stringify(manifest,null,2)+'\n';
  fs.writeFileSync(path.join(directory,'delivery-manifest.json'),data);
  fs.writeFileSync(path.join(directory,'SHA256SUMS'),`${original.sha256}  ${original.path}\n${sha256(data)}  delivery-manifest.json\n`);
  return manifest;
}
// Use the REST archive digest, not download-artifact's warning-only digest comparison.
async function download({github,context,artifact,directory}) {
  requireThat(!artifact.expired && /^sha256:[a-f0-9]{64}$/.test(artifact.digest || '') &&
    positive(artifact.size_in_bytes) && artifact.size_in_bytes <= 2*1024**3, 'Artifact digest or bounded size unavailable');
  const response=await github.rest.actions.downloadArtifact({...context.repo,artifact_id:artifact.id,archive_format:'zip'});
  const bytes=Buffer.from(response.data);
  requireThat(bytes.length <= 2*1024**3 && `sha256:${sha256(bytes)}` === artifact.digest, 'Downloaded artifact digest mismatch');
  fs.mkdirSync(directory,{recursive:false}); fs.writeFileSync(`${directory}.zip`,bytes);
  // No archive member is executed. Reject nested paths, links, duplicates and oversized archives.
  require('node:child_process').execFileSync('python3',['-I','-c',
    'import sys,zipfile,pathlib,stat\nz=zipfile.ZipFile(sys.argv[1]); seen=set(); total=0\nif len(z.infolist())>3: raise ValueError("Too many artifact members")\nfor f in z.infolist():\n n=f.filename; total+=f.file_size\n if not n or n in (".","..") or n in seen or pathlib.PurePosixPath(n).name!=n or "\\\\" in n or stat.S_IFMT(f.external_attr>>16) not in (0,stat.S_IFREG) or (n.endswith(".json") and f.file_size>1024**2) or total>2*1024**3: raise ValueError("Unsafe artifact")\n seen.add(n)\n pathlib.Path(sys.argv[2],n).write_bytes(z.read(f))',`${directory}.zip`,directory],{stdio:'pipe'});
  return directory;
}
async function preparePublication({github,context,core,profile='release'}) {
  const contract=producerProfile(profile);
  const repo=(await github.rest.repos.get(context.repo)).data;
  const event=context.payload.workflow_run;
  requireThat(positive(event?.id), 'Missing source run');
  const run=(await github.rest.actions.getWorkflowRun({...context.repo,run_id:event.id})).data;
  const workflow=(await github.rest.actions.getWorkflow({...context.repo,workflow_id:'development.yml'})).data;
  requireThat(positive(Number(run.run_attempt)) && run.run_attempt <= 100,'Invalid or excessive run attempts');
  const jobs=[];
  for(let attempt=1;attempt<=run.run_attempt;attempt++) {
    const entries=await github.paginate(github.rest.actions.listJobsForWorkflowRunAttempt,{...context.repo,run_id:run.id,attempt_number:attempt,per_page:100});
    jobs.push(...entries.map(job=>({...job,run_attempt:attempt})));
  }
  const gates=effectiveJobs(normalizeJobs(jobs,profile),Number(run.run_attempt));
  requireThat(gates.source && gates[contract.producer],'Missing source or producer gate');
  const artifacts=await github.paginate(github.rest.actions.listWorkflowRunArtifacts,{...context.repo,run_id:run.id,per_page:100});
  const exact=name=>{const matches=artifacts.filter(a=>a.name===name);requireThat(matches.length===1,'Missing exact control artifact');return matches[0];};
  const sourceArtifact=exact(`development-control-${run.id}-${gates.source.run_attempt}`);
  const producerArtifact=exact(`development-producer-control-${run.id}-${gates[contract.producer].run_attempt}`);
  const base=path.join(process.env.RUNNER_TEMP,`component-${run.id}-${run.run_attempt}`);
  await download({github,context,artifact:sourceArtifact,directory:`${base}-source`});
  await download({github,context,artifact:producerArtifact,directory:`${base}-control`});
  requireThat(fs.readdirSync(`${base}-source`).join() === 'development-control.json' &&
    fs.readdirSync(`${base}-control`).join() === 'producer-control.json','Unexpected control files');
  const sourceControl=JSON.parse(fs.readFileSync(`${base}-source/development-control.json`));
  const control=JSON.parse(fs.readFileSync(`${base}-control/producer-control.json`));
  const callerBlobs=profile==='gmr'?await callerDefinition({github,context,sourceSha:run.head_sha,controllerSha:controllerReference(run,repo.full_name,repo.default_branch)}):undefined;
  const plan=publicationPlan({run,workflow,jobs,artifacts,control,sourceControl,callerBlobs,defaultBranch:repo.default_branch,repository:repo.full_name,controlArtifact:sourceArtifact,producerArtifact,profile});
  core.setOutput('upload',String(plan.upload));
  if (!plan.upload) return plan;
  await download({github,context,artifact:plan.artifact,directory:`${base}-original`});
  core.setOutput('directory',`${base}-original`); core.setOutput('identity',`${base}-control/producer-control.json`);
  core.setOutput('artifact_id',String(plan.artifact.id));
  return plan;
}
module.exports={controllerReference,callerDefinition,normalizeJobs,producerProfile,frozenSource,deliveryManifest,effectiveJobs,producerControl,identity,validateControl,resolve,gatePublication,publicationPlan,seal,download,preparePublication};
