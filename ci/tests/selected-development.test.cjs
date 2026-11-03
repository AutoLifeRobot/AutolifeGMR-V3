'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),crypto=require('node:crypto');
const policy=require('../development-policy.cjs');
const source='a'.repeat(40),controller='c'.repeat(40),tree='b'.repeat(40),blob='d'.repeat(40),repository='Example/GMR';
function setup(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmr-selected-')),cwd=process.cwd();
 const keys=['GITHUB_WORKFLOW_SHA','GITHUB_RUN_ATTEMPT','RUNNER_TEMP'];const env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.chdir(root);Object.assign(process.env,{GITHUB_WORKFLOW_SHA:source,GITHUB_RUN_ATTEMPT:'1',RUNNER_TEMP:root});
 t.after(()=>{process.chdir(cwd);fs.rmSync(root,{recursive:true,force:true});for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;});
 const context={repo:{owner:'Example',repo:'GMR'},eventName:'workflow_dispatch',ref:'refs/heads/feature/work',sha:source,runId:42,payload:{inputs:{upload:'true'}}};
 const run={id:42,run_attempt:1,head_sha:source,head_branch:'feature/work',event:'workflow_dispatch',repository:{full_name:repository},head_repository:{full_name:repository},
  referenced_workflows:[{path:`${repository}/.github/workflows/development-controller.yml@${controller}`,ref:'refs/heads/main',sha:controller}]};
 const requests=[];
 const github={rest:{repos:{get:async()=>({data:{default_branch:'main',full_name:repository}}),getContent:async req=>{
  requests.push(req);return {data:req.path==='VERSION'?{type:'file',encoding:'base64',content:Buffer.from('1.1.5\n').toString('base64')}:{type:'file',sha:blob}};
 }},git:{getRef:async()=>{throw Error('Do not resolve a moving branch head');},getCommit:async({commit_sha})=>{assert.equal(commit_sha,source);return {data:{sha:source,tree:{sha:tree}}};}},
 actions:{getWorkflowRun:async()=>({data:run})}}};
 return {root,context,run,github,requests};
}
test('selected feature branch freezes dispatch SHA and version, while controller remains main',async t=>{
 const f=setup(t),out={};
 const value=await policy.resolve({...f,core:{setOutput:(k,v)=>out[k]=v},component:'gmr',profile:'gmr',upload:false});
 assert.equal(value.delivery.source_ref,f.context.ref);assert.equal(value.delivery.source_sha,source);
 assert.equal(value.control_sha,controller);assert.equal(value.tree_sha,tree);assert.equal(value.upload,false);
 assert.equal(out.controller_sha,controller);assert.equal(value.delivery.release_version,'1.1.5+dev.42');
 assert.equal(f.requests.find(r=>r.path==='VERSION').ref,source);
 assert.equal(fs.existsSync(path.join(f.root,'development-control.json')),true);
});
for(const fault of ['tag','wrong-run-sha','wrong-branch','fork','missing-controller','wrong-controller-ref','ambiguous-controller','different-caller','wrong-workflow-sha']) {
 test(`selected branch admission rejects ${fault}`,async t=>{
  const f=setup(t);
  if(fault==='tag')f.context.ref='refs/tags/test';
  if(fault==='wrong-run-sha')f.run.head_sha='e'.repeat(40);
  if(fault==='wrong-branch')f.run.head_branch='other';
  if(fault==='fork')f.run.head_repository.full_name='Other/GMR';
  if(fault==='missing-controller')f.run.referenced_workflows=[];
  if(fault==='wrong-controller-ref')f.run.referenced_workflows[0].ref='refs/heads/feature/work';
  if(fault==='ambiguous-controller')f.run.referenced_workflows.push({...f.run.referenced_workflows[0]});
  if(fault==='different-caller')f.github.rest.repos.getContent=async r=>({data:{type:'file',sha:r.ref===source?blob:'e'.repeat(40)}});
  if(fault==='wrong-workflow-sha')process.env.GITHUB_WORKFLOW_SHA='e'.repeat(40);
  await assert.rejects(policy.resolve({...f,core:{setOutput(){}},component:'gmr',profile:'gmr'}));
  assert.equal(fs.existsSync(path.join(f.root,'development-control.json')),false);
 });
}
test('producer retries keep selected source identity rather than requiring controller SHA as source',t=>{
 const f=setup(t);process.env.GITHUB_RUN_ATTEMPT='2';
 const c=policy.identity({component:'gmr',version:'1.1.5',source_sha:source,tree_sha:tree,source_ref:f.context.ref,
  control_sha:controller,repository,upload:true,run_id:42,run_attempt:1});
 const fresh=policy.producerControl({control:c,context:f.context,core:{setOutput(){}}});
 assert.equal(fresh.delivery.run_attempt,2);assert.equal(fresh.control_sha,controller);assert.equal(fresh.delivery.source_sha,source);
 assert.throws(()=>policy.producerControl({control:c,context:{...f.context,sha:controller},core:{setOutput(){}}}));
});
test('selected source retry loads original control before any branch lookup',async t=>{
 const f=setup(t);process.env.GITHUB_RUN_ATTEMPT='2';
 const c=policy.identity({component:'gmr',version:'1.1.5',source_sha:source,tree_sha:tree,source_ref:f.context.ref,
  control_sha:controller,repository,upload:true,run_id:42,run_attempt:1});
 const bytes=cp.execFileSync('python3',['-I','-c',"import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,'w') as z:z.writestr('development-control.json',sys.stdin.read())\nsys.stdout.buffer.write(b.getvalue())"],{input:JSON.stringify(c)});
 const artifact={id:7,name:'development-control-42-1',size_in_bytes:bytes.length,digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex'),created_at:'2026-01-01T00:00:01Z'};
 const jobs=()=>{},artifacts=()=>{};
 Object.assign(f.github.rest.actions,{listJobsForWorkflowRunAttempt:jobs,listWorkflowRunArtifacts:artifacts,downloadArtifact:async()=>({data:bytes})});
 f.github.paginate=async method=>method===jobs?[{name:'development / source',conclusion:'success'},
  {name:'development / package',started_at:'2026-01-01T00:00:02Z'}]:[artifact];
 const value=await policy.resolve({...f,core:{setOutput(){}},component:'gmr',profile:'gmr'});
 assert.equal(value.delivery.source_sha,source);assert.equal(value.delivery.run_attempt,2);assert.equal(value.control_sha,controller);
 assert.equal(f.requests.some(r=>r.path==='VERSION'),false);
});
