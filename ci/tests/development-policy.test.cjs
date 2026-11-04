'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), cp=require('node:child_process');
const policy=require('../development-policy.cjs');
function control(change={}) { return policy.identity({component:'release',version:'3.0.0',source_sha:'a'.repeat(40),tree_sha:'b'.repeat(40),source_ref:'refs/heads/feature/dev',run_id:42,run_attempt:1,control_sha:'c'.repeat(40),repository:'Example/Release',upload:true,...change}); }
function plan() {
 const value=control();
 return {control:value,sourceControl:structuredClone(value),repository:value.repository,defaultBranch:'main',workflow:{id:4,path:'.github/workflows/development.yml'},
 run:{event:'workflow_dispatch',status:'completed',conclusion:'success',head_repository:{full_name:value.repository},repository:{full_name:value.repository},head_branch:'main',path:'.github/workflows/development.yml',workflow_id:4,head_sha:value.control_sha,id:42,run_attempt:1},
 jobs:['source','check','package','verify','development-full-gate'].map(name=>({name,status:'completed',conclusion:'success',labels:['ubuntu-24.04'],run_attempt:1,run_id:42,runner_group_name:'GitHub Actions',head_sha:value.control_sha,started_at:'2026-01-01T00:00:02Z',steps:[{name:'Compile, package and test the original',conclusion:'success',started_at:'2026-01-01T00:00:03Z'}]})),
 controlArtifact:{name:'development-control-42-1',created_at:'2026-01-01T00:00:01Z'},producerArtifact:{name:'development-producer-control-42-1',created_at:'2026-01-01T00:00:02Z'},
 artifacts:[{id:9,name:'release-development-42-1',digest:'sha256:'+'d'.repeat(64),expired:false}]};
}
test('dev channel run identity is stable across full retries and independent across runs',()=>{
 assert.equal(control().delivery.release_version,control({run_attempt:2}).delivery.release_version);
 assert.notEqual(control().delivery.release_version,control({run_id:43}).delivery.release_version);
 assert.equal(control({run_attempt:2}).delivery.run_attempt,2);
 for(const change of [{run_id:0},{run_attempt:0},{source_ref:'main'},{tree_sha:'bad'},{control_sha:'bad'},{version:'03.0.0'},{upload:'true'}]) assert.throws(()=>control(change));
});
test('publication needs no enable variable or GitHub environment and preserves the controller gate',async t=>{
 const before=process.env.GITHUB_WORKFLOW_SHA;
 t.after(()=>{if(before===undefined)delete process.env.GITHUB_WORKFLOW_SHA;else process.env.GITHUB_WORKFLOW_SHA=before;});
 process.env.GITHUB_WORKFLOW_SHA='a'.repeat(40);
 const github={rest:{repos:{
  get:async()=>({data:{default_branch:'main'}}),
  getEnvironment:async()=>{throw new Error('Publication must not query environments');}
 }},paginate:async()=>{throw new Error('Publication must not query branch rules');}};
 const context={repo:{owner:'Example',repo:'GMR'},ref:'refs/heads/main',sha:'a'.repeat(40)};
 await policy.gatePublication({github,context});
 await assert.rejects(policy.gatePublication({github,context:{...context,ref:'refs/heads/feature/test'}}),/default branch/);
 process.env.GITHUB_WORKFLOW_SHA='b'.repeat(40);
 await assert.rejects(policy.gatePublication({github,context}),/default branch/);
});
test('only exact successful hosted gates, source workflow, immutable artifacts and early control authorize publication',()=>{
 assert.equal(policy.publicationPlan(plan()).artifact.id,9);
 const failures=[p=>p.run.conclusion='failure',p=>p.run.head_branch='feature/dev',p=>p.run.path='other.yml',p=>p.run.workflow_id=5,p=>p.run.head_sha='a'.repeat(40),p=>p.control.delivery.source_sha='bad',p=>p.controlArtifact.created_at='2026-01-01T00:00:02Z',p=>p.artifacts[0].expired=true,p=>delete p.artifacts[0].digest,p=>p.artifacts.push({...p.artifacts[0]})];
 for(const status of ['failure','skipped','cancelled']) failures.push(p=>p.jobs[2].conclusion=status);
 failures.push(p=>p.jobs[1].labels=['self-hosted','ubuntu-24.04'],p=>p.jobs[1].run_attempt=0,p=>p.jobs[1].runner_group_name='Default',p=>p.jobs.pop());
 for(const change of failures) {const p=plan();change(p);assert.throws(()=>policy.publicationPlan(p));}
 const p=plan();p.control.upload=false;p.sourceControl.upload=false;assert.equal(policy.publicationPlan(p).upload,false);
});
test('trusted seal binds the two-client receipt and original bytes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-seal-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const original=Buffer.from('inert fixture original');fs.writeFileSync(path.join(root,'release.tar.gz'),original);
 const receipt=path.join(root,'consumer.json'), ctrl=control();
 const value={status:'passed',source_sha:ctrl.delivery.source_sha,version:ctrl.delivery.release_version,archive_sha256:require('node:crypto').createHash('sha256').update(original).digest('hex'),distribution:{status:'passed',protocol:'independent-client/1',receipt_sha256:'e'.repeat(64)}};
 fs.writeFileSync(receipt,JSON.stringify(value));
 const result=policy.seal({directory:root,consumer:receipt,control:ctrl});assert.equal(result.tree_sha,ctrl.tree_sha);assert.equal(result.delivery.kind,'development');
 fs.writeFileSync(path.join(root,'release.tar.gz'),'changed');assert.throws(()=>policy.seal({directory:root,consumer:receipt,control:ctrl}));
 fs.writeFileSync(path.join(root,'release.tar.gz'),original);value.distribution.status='skipped';fs.writeFileSync(receipt,JSON.stringify(value));assert.throws(()=>policy.seal({directory:root,consumer:receipt,control:ctrl}));
});
test('download requires digest and refuses traversal, links, duplicates and unbounded attachments',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-zip-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const zip=(kind)=>cp.execFileSync('python3',['-I','-c',`import io,zipfile,stat,sys\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:\n k=sys.argv[1]\n if k=='link':\n  f=zipfile.ZipInfo('original.tar.gz');f.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(f,'elsewhere')\n elif k=='duplicate':\n  z.writestr('control.json','{}');z.writestr('control.json','{}')\n elif k=='count':\n  for n in range(4): z.writestr(str(n),'x')\n elif k=='large': z.writestr('control.json',b'x'*(1024**2+1))\n else:z.writestr('../escape' if k=='path' else 'control.json','{}')\nsys.stdout.buffer.write(b.getvalue())`,kind],{stdio:['ignore','pipe','ignore'],maxBuffer:4*1024**2});
 let i=0;
 for(const kind of ['ok','path','link','duplicate','count','large','digest']) {
  const bytes=zip(kind),artifact={id:1,expired:false,size_in_bytes:bytes.length,digest:'sha256:'+require('node:crypto').createHash('sha256').update(bytes).digest('hex')};
  if(kind==='digest')artifact.digest='sha256:'+'0'.repeat(64);
  const promise=policy.download({github:{rest:{actions:{downloadArtifact:async()=>({data:bytes})}}},context:{repo:{}},artifact,directory:path.join(root,String(i++))});
  if(kind==='ok')await promise;else await assert.rejects(promise);
 }
 assert.equal(fs.existsSync(path.join(root,'escape')),false);
});
test('resolver binds actual branch commit/tree and default control without requiring a PR',async t=>{
 const cwd=process.cwd(),root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-resolve-')),env=process.env.GITHUB_WORKFLOW_SHA,attempt=process.env.GITHUB_RUN_ATTEMPT;
 t.after(()=>{process.chdir(cwd);fs.rmSync(root,{recursive:true,force:true});if(env===undefined)delete process.env.GITHUB_WORKFLOW_SHA;else process.env.GITHUB_WORKFLOW_SHA=env;if(attempt===undefined)delete process.env.GITHUB_RUN_ATTEMPT;else process.env.GITHUB_RUN_ATTEMPT=attempt;});
 process.chdir(root);process.env.GITHUB_WORKFLOW_SHA='c'.repeat(40);process.env.GITHUB_RUN_ATTEMPT='1';
 const calls=[],github={rest:{repos:{get:async()=>({data:{default_branch:'main',full_name:'Example/Release'}}),getContent:async x=>{calls.push(x);return {data:{type:'file',encoding:'base64',content:Buffer.from('3.0.0\n').toString('base64')}};}},git:{getRef:async x=>{calls.push(x);return {data:{ref:'refs/heads/a/source',object:{type:'commit',sha:'a'.repeat(40)}}};},getCommit:async x=>({data:{sha:x.commit_sha,tree:{sha:'b'.repeat(40)}}})}}};
 const context={repo:{owner:'Example',repo:'Release'},eventName:'workflow_dispatch',ref:'refs/heads/main',sha:'c'.repeat(40),runId:42,payload:{inputs:{source_branch:'a/source',upload:'false'}}};
 const result=await policy.resolve({github,context,core:{setOutput(){}}});
 assert.equal(result.delivery.source_sha,'a'.repeat(40));assert.equal(result.tree_sha,'b'.repeat(40));assert.equal(result.delivery.run_attempt,1);assert.equal(result.upload,false);
 assert.equal(calls[1].ref,'a'.repeat(40));
 context.ref='refs/heads/a/source';await assert.rejects(policy.resolve({github,context,core:{setOutput(){}}}));
});

test('failed-job retries reuse exact earlier source/check or producer originals without changing producer attempt',()=>{
 const p=plan();p.run.run_attempt=3;
 // Source/check and the actual producer succeeded in attempt 1; only trusted
 // consumer/final gate reran in attempt 3. Exact earlier original is preserved.
 p.jobs[3].run_attempt=3;p.jobs[4].run_attempt=3;
 p.artifacts[0].name='release-development-42-3';
 assert.equal(policy.publicationPlan(p).control.delivery.run_attempt,1);
 // A failed later producer supersedes an earlier successful job.
 p.jobs.push({...p.jobs[2],run_attempt:2,conclusion:'failure'});
 assert.throws(()=>policy.publicationPlan(p));
});
test('failed producer retry derives a fresh attempt from fixed trusted source and accepts earlier successful checks',()=>{
 const p=plan();p.run.run_attempt=2;
 p.control=control({run_attempt:2});p.jobs[2].run_attempt=2;p.jobs[3].run_attempt=2;p.jobs[4].run_attempt=2;
 p.producerArtifact.name='development-producer-control-42-2';p.artifacts[0].name='release-development-42-2';
 assert.equal(policy.publicationPlan(p).control.delivery.run_attempt,2);
 p.sourceControl.delivery.source_sha='e'.repeat(40);assert.throws(()=>policy.publicationPlan(p));
});

test('shared metadata builder preserves exact inventory and service-center archive alias',()=>{
 const ctrl=control({component:'service-center'}),files=[{path:'original.tar.gz',sha256:'e'.repeat(64),size:10}];
 assert.equal(policy.deliveryManifest({control:ctrl,files}).component,'servicecenter');
 assert.throws(()=>policy.deliveryManifest({control:ctrl,files:[...files,...files]}));
 assert.throws(()=>policy.deliveryManifest({control:ctrl,files:[{...files[0],path:'../original'}]}));
});
test('formal route records actual main ref without changing formal identity or counters',async t=>{
 const number=process.env.GITHUB_RUN_NUMBER;t.after(()=>{if(number===undefined)delete process.env.GITHUB_RUN_NUMBER;else process.env.GITHUB_RUN_NUMBER=number;});
 process.env.GITHUB_RUN_NUMBER='7';const outputs={};
 await require('../workflow_policy.cjs').route({github:{},context:{repo:{owner:'Example',repo:'Release'},ref:'refs/heads/main',sha:'a'.repeat(40),eventName:'workflow_dispatch',payload:{},runId:42},core:{setOutput(k,v){outputs[k]=v;},info(){}},mode:'formal',cancelObsolete:false});
 const result=JSON.parse(outputs.identity);assert.equal(result.source_ref,'refs/heads/main');assert.equal(result.kind,'formal');
 const expected=require('../workflow_policy.cjs').identity({kind:'formal',version:fs.readFileSync('VERSION','utf8').trim(),offset:JSON.parse(fs.readFileSync('ci/release-policy.json')).formal_build_offset,runNumber:7,runId:42,sha:'a'.repeat(40)});
 assert.equal(result.release_version,expected.release_version);assert.equal(result.build_number,expected.build_number);
});
test('full retries freeze the first admitted source VERSION/commit even if the input branch moves',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dev-frozen-')),cwd=process.cwd();
 const saved=Object.fromEntries(['GITHUB_WORKFLOW_SHA','GITHUB_RUN_ATTEMPT','RUNNER_TEMP'].map(k=>[k,process.env[k]]));
 t.after(()=>{process.chdir(cwd);fs.rmSync(root,{recursive:true,force:true});for(const [k,v] of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 process.chdir(root);process.env.RUNNER_TEMP=root;process.env.GITHUB_WORKFLOW_SHA='c'.repeat(40);process.env.GITHUB_RUN_ATTEMPT='2';
 const value=control();
 const zip=cp.execFileSync('python3',['-I','-c',"import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:z.writestr('development-control.json',sys.stdin.read())\nsys.stdout.buffer.write(b.getvalue())"],{input:JSON.stringify(value)});
 const artifact={id:15,size_in_bytes:zip.length,name:'development-control-42-1',created_at:'2026-01-01T00:00:01Z',digest:'sha256:'+require('node:crypto').createHash('sha256').update(zip).digest('hex')};
 const jobs=()=>{},artifacts=()=>{};
 const github={rest:{repos:{get:async()=>({data:{default_branch:'main',full_name:value.repository}})},actions:{listJobsForWorkflowRunAttempt:jobs,listWorkflowRunArtifacts:artifacts,downloadArtifact:async()=>({data:zip})}},
 paginate:async method=>method===jobs?[{name:'source',conclusion:'success'},{name:'check',started_at:'2026-01-01T00:00:02Z'}]:[artifact]};
 const context={repo:{owner:'Example',repo:'Release'},eventName:'workflow_dispatch',ref:'refs/heads/main',sha:value.control_sha,runId:42,payload:{inputs:{source_branch:'feature/dev',upload:'true'}}};
 const result=await policy.resolve({github,context,core:{setOutput(){}}});
 assert.equal(result.delivery.source_sha,value.delivery.source_sha);assert.equal(result.delivery.version,value.delivery.version);assert.equal(result.delivery.release_version,value.delivery.release_version);assert.equal(result.delivery.run_attempt,2);
});
test('trusted native profiles require exact expanded job names and every actual consumer',()=>{
 for(const name of ['sdk','network','media']) {
  const contract=policy.producerProfile(name),p=plan();p.profile=name;
  p.control=control({component:name});p.sourceControl=p.control;
  p.artifacts[0].name=`${name}-development-42-1`;
  const template=p.jobs[0];p.jobs=contract.gates.map(name=>({...structuredClone(template),name}));
  assert.equal(policy.publicationPlan(p).artifact.id,9);
  for(const missing of contract.gates) {
   const bad=structuredClone(p);bad.jobs=bad.jobs.filter(j=>j.name!==missing);assert.throws(()=>policy.publicationPlan(bad),missing);
   const failed=structuredClone(p);failed.jobs.find(j=>j.name===missing).conclusion='skipped';assert.throws(()=>policy.publicationPlan(failed),missing);
  }
  const renamed=structuredClone(p);renamed.jobs.find(j=>j.name===contract.producer).name='qualify / '+contract.producer;assert.throws(()=>policy.publicationPlan(renamed));
  for(const first of contract.sourceJobs) {
   const early=structuredClone(p);early.jobs.find(j=>j.name===first).started_at='2026-01-01T00:00:00Z';assert.throws(()=>policy.publicationPlan(early),first);
  }
 }
 assert.throws(()=>policy.producerProfile('untrusted'));
 const bad=plan();bad.profile='network';assert.throws(()=>policy.publicationPlan(bad));
});

// GMR calls reviewed main control from the selected branch; only GitHub-hosted
// gates with the exact reusable prefix and an API-verified caller may publish.
function flowPlan() {
 const p=plan(),c=control({component:'gmr',repository:'Example/GMR'});
 p.profile='gmr';p.control=c;p.sourceControl=structuredClone(c);p.repository=c.repository;
 p.run.repository.full_name=c.repository;p.run.head_repository.full_name=c.repository;
 p.run.head_branch='feature/dev';p.run.head_sha=c.delivery.source_sha;
 p.run.referenced_workflows=[{path:`${c.repository}/.github/workflows/development-controller.yml@${c.control_sha}`,ref:'refs/heads/main',sha:c.control_sha}];
 p.callerBlobs={source:'d'.repeat(40),controller:'d'.repeat(40)};
 p.jobs=p.jobs.filter(j=>j.name!=='check').map(j=>({...j,name:'development / '+j.name,head_sha:p.run.head_sha,labels:['ubuntu-24.04'],runner_group_name:'GitHub Actions'}));
 p.artifacts[0].name='gmr-development-42-1';return p;
}
test('GMR publication requires trusted main control, reviewed caller and every GitHub-hosted gate',()=>{
 const p=flowPlan();assert.equal(policy.publicationPlan(p).upload,true);
 for(const mutate of [
  p=>p.jobs.find(j=>j.name==='development / verify').conclusion='skipped',
  p=>p.jobs[0].labels=['self-hosted','ubuntu-24.04'],
  p=>p.jobs[0].labels=['ubuntu-latest'],
  p=>p.jobs[0].runner_group_name='Default',
  p=>p.run.head_branch='other',p=>p.run.head_sha='e'.repeat(40),
  p=>p.run.referenced_workflows=[],p=>p.run.referenced_workflows[0].ref='refs/heads/feature/dev',
  p=>p.callerBlobs.source='e'.repeat(40),p=>delete p.callerBlobs,
  p=>p.jobs.push(structuredClone(p.jobs[0]))
 ]) {const bad=structuredClone(p);mutate(bad);assert.throws(()=>policy.publicationPlan(bad));}
 const source=fs.readFileSync('.github/workflows/development.yml','utf8');
 const controller=fs.readFileSync('.github/workflows/development-controller.yml','utf8');
 const upload=fs.readFileSync('.github/workflows/component-publication.yml','utf8');
 assert.doesNotMatch(source,/source_branch|RELEASE_PUBLISH_KEY|AUTOLIFE_PUBLISH_TOKEN|secrets: inherit/);
 assert.match(source,/development-controller.yml@main/);
 assert.doesNotMatch(controller,/RELEASE_PUBLISH_KEY|AUTOLIFE_PUBLISH_TOKEN/);
 assert.match(controller,/runs-on: ubuntu-24\.04/);
 assert.doesNotMatch(controller,/runs-on: \[self-hosted/);
 assert.match(controller,/bash controller\/ci\/docker.sh full/);
 for(const workflow of [upload,fs.readFileSync('.github/workflows/release.yml','utf8')]) {
  assert.doesNotMatch(workflow,/^\s*environment:|deployments: read/m);assert.match(workflow,/gatePublication/);
 }
 assert.match(upload,/runs-on: ubuntu-24\.04/);assert.doesNotMatch(upload,/runs-on: \[self-hosted/);
 assert.match(upload,/secrets.RELEASE_PUBLISH_KEY/);
 assert.match(upload,/profile:'gmr'/);
});
