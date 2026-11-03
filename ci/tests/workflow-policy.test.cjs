'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {candidate, classify, identity, requireSuccess, route} = require('../workflow_policy.cjs');
const repository = 'AutoLifeRobot/AutolifeGMR-V3';
const sha = 'a'.repeat(40), base = 'b'.repeat(40);
const ready = () => ({number: 2, state: 'open', draft: false,
  base: {ref: 'main', sha: base, repo: {full_name: repository}},
  head: {ref: 'candidate/3.0.5', sha, repo: {full_name: repository}}});
const event = (options = {}) => classify({event: 'pull_request', action: 'synchronize',
  ref: 'refs/pull/2/merge', repository, pull: ready(), ...options});

for (const action of ['opened', 'reopened', 'synchronize', 'ready_for_review']) {
  test(`Ready candidate ${action} owns full only`, () => {
    assert.deepEqual(event({action}), {quick: false, full: true, reason: 'ready-candidate'});
  });
}
for (const variant of ['draft', 'feature', 'other-base', 'fork']) {
  test(`${variant} is quick only`, () => {
    const pull = ready();
    if (variant === 'draft') pull.draft = true;
    if (variant === 'feature') pull.head.ref = 'hxx/work';
    if (variant === 'other-base') pull.base.ref = 'candidate/3.0.5';
    if (variant === 'fork') pull.head.repo.full_name = 'fork/sdk';
    assert.equal(candidate(pull, repository), false);
    assert.equal(event({pull}).quick, true);
    assert.equal(event({pull}).full, false);
  });
}
for (const action of ['edited', 'closed']) {
  test(`${action} without changed base does not rebuild`, () => {
    assert.equal(event({action}).quick, false);
    assert.equal(event({action}).full, false);
  });
}
test('base edit and Draft conversion reroute current state', () => {
  assert.equal(event({action: 'edited', baseChanged: true}).full, true);
  const pull = ready(); pull.draft = true;
  assert.equal(event({action: 'converted_to_draft', pull}).quick, true);
});
test('push with PR does not repeat PR work; no PR gets quick work', () => {
  const input = {event: 'push', ref: 'refs/heads/candidate/3.0.5'};
  assert.equal(event(input).quick, true);
  assert.equal(event({...input, openPulls: [ready()]}).quick, false);
  assert.equal(event({...input, ref: 'refs/heads/main'}).quick, false);
  assert.equal(event({...input, ref: 'refs/tags/v3.0.5'}).quick, false);
});
test('formal number independent of candidate, product increment, and attempt', () => {
  const input = {kind: 'formal', version: '3.0.5', offset: 149, runNumber: 48, runId: 800, sha};
  assert.equal(identity(input).build_number, 197);
  assert.equal(identity({...input, version: '3.0.6'}).build_number, 197);
  assert.equal(identity({...input, kind: 'candidate'}).build_number, 800);
  assert.throws(() => identity({...input, offset: -1}));
  assert.throws(() => identity({...input, runId: 0}));
  assert.throws(() => identity({...input, sha: 'main'}));
});
for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
  test(`terminal gate rejects ${result}`, () => {
    assert.throws(() => requireSuccess({full: {result}}, ['full']));
  });
}
test('terminal gate requires every named dependency', () => {
  requireSuccess({route: {result: 'success'}, full: {result: 'success'}}, ['route', 'full']);
  assert.throws(() => requireSuccess({full: {result: 'success'}}, ['route', 'full']));
});
test('stale PR cannot build the earlier source or base', async () => {
  for (const field of ['head', 'base']) {
    const outputs = {}, pull = ready(), current = ready(); current[field].sha = 'c'.repeat(40);
    await route({github: {rest: {pulls: {get: async () => ({data: current})}}},
      context: {repo: {owner: 'AutoLifeRobot', repo: 'AutolifeGMR-V3'}, payload: {pull_request: pull}},
      core: {setOutput: (key, value) => outputs[key] = value, info() {}}});
    assert.equal(outputs.full, 'false'); assert.equal(outputs.quick, 'false');
  }
});

test('version and provenance reject ambiguous or overflowing identities', () => {
  const input = {kind: 'formal', version: '3.0.5', offset: 149, runNumber: 48, runId: 800, sha};
  for (const invalid of [{version: '03.0.5'}, {headSha: 'branch'}, {baseSha: 'main'},
    {offset: Number.MAX_SAFE_INTEGER}]) assert.throws(() => identity({...input, ...invalid}));
});
test('cancellation targets only unfinished older runs for this PR', async () => {
  const cancelled = [];
  const {cancelOlder} = require('../workflow_policy.cjs');
  const row = (id, status = 'in_progress', number = 2) => ({id, status, pull_requests: [{number}]});
  await cancelOlder({github: {paginate: async () => [row(1), row(3), row(4), row(0, 'completed'), row(2, 'queued', 9)],
    rest: {actions: {listWorkflowRuns() {}, cancelWorkflowRun: async args => cancelled.push(args.run_id)}}},
    context: {repo: {owner: 'AutoLifeRobot', repo: 'AutolifeGMR-V3'}, runId: 3},
    core: {info() {}}, pull: ready(), mode: 'candidate'});
  assert.deepEqual(cancelled, [1]);
});
test('stale Draft/state/base-ref changes cannot cancel any work', async () => {
  for (const field of ['draft', 'state', 'ref']) {
    const pull = ready(), current = ready(), outputs = {};
    if (field === 'draft') current.draft = true;
    if (field === 'state') current.state = 'closed';
    if (field === 'ref') current.base.ref = 'candidate/3.0.5';
    await route({github: {rest: {pulls: {get: async () => ({data: current})}}},
      context: {repo: {owner: 'AutoLifeRobot', repo: 'AutolifeGMR-V3'}, payload: {pull_request: pull}},
      core: {setOutput: (key, value) => outputs[key] = value, info() {}}});
    assert.equal(outputs.full, 'false'); assert.equal(outputs.quick, 'false');
  }
});
test('title edit observes state without listing or cancelling runs', async () => {
  const pull = ready(), outputs = {};
  await route({github: {rest: {pulls: {get: async () => ({data: pull})}}},
    context: {eventName: 'pull_request', repo: {owner: 'AutoLifeRobot', repo: 'AutolifeGMR-V3'},
      payload: {pull_request: pull, action: 'edited'}, ref: 'refs/pull/2/merge'},
    core: {setOutput: (key, value) => outputs[key] = value, info() {}}});
  assert.equal(outputs.full, 'false'); assert.equal(outputs.quick, 'false');
});

test('opening a PR takes ownership of its older push quick run exactly once', async () => {
  for (const cancelObsolete of [true, false]) {
    const events = [], outputs = {}, pull = ready(); pull.draft = true;
    const run = (id, branch, status = 'in_progress') => ({id, head_branch: branch,
      event: 'push', status, pull_requests: []});
    await route({github: {
      rest: {pulls: {get: async () => {events.push('current'); return {data: pull};}},
        actions: {listWorkflowRuns() {}, cancelWorkflowRun: async ({run_id}) => events.push('cancel-'+run_id)}},
      paginate: async () => {events.push('list'); return [run(1, pull.head.ref),
        run(2, 'candidate/unrelated'), run(4, pull.head.ref), run(0, pull.head.ref, 'completed')];}},
      context: {eventName: 'pull_request', repo: {owner: 'AutoLifeRobot', repo: 'AutolifeGMR-V3'},
        payload: {pull_request: pull, action: 'opened'}, ref: 'refs/pull/2/merge', runId: 3},
      core: {setOutput: (key, value) => outputs[key] = value, info() {}}, cancelObsolete});
    assert.deepEqual(events, cancelObsolete ? ['current', 'list', 'cancel-1'] : ['current']);
    assert.equal(outputs.quick, 'true'); assert.equal(outputs.full, 'false');
  }
});

test('candidate route freezes its PR number without changing public delivery identity', async () => {
  const previous = process.env.GITHUB_RUN_NUMBER; process.env.GITHUB_RUN_NUMBER = '8';
  try {
    for (const manual of [false, true]) {
      const pull=ready(), outputs={},calls=[];
      const context={repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},runId:800,sha,
        eventName:manual?'workflow_dispatch':'pull_request',
        ref:manual?'refs/heads/'+pull.head.ref:'refs/pull/2/merge',
        payload:manual?{}:{pull_request:pull,action:'synchronize'}};
      const github={paginate:async()=>[pull],rest:{pulls:{list(){},get:async ({pull_number})=>{calls.push(pull_number);return {data:pull};}}}};
      await route({github,context,core:{setOutput:(key,value)=>outputs[key]=value,info(){}},
        root:require('node:path').resolve(__dirname,'../..'),mode:'candidate',cancelObsolete:false});
      assert.equal(outputs.pr_number,'2');assert.equal(outputs.full,'true');assert.deepEqual(calls,[2]);
      assert.equal('pr_number' in JSON.parse(outputs.identity),false);
    }
  } finally {if(previous===undefined)delete process.env.GITHUB_RUN_NUMBER;else process.env.GITHUB_RUN_NUMBER=previous;}
});

for (const fault of ['ambiguous','changed-number','changed-head','changed-ref','closed','draft','API-failure']) {
 test(`manual entry rejects ${fault} before locking or starting full`, async()=>{
  const advertised=ready(), current=structuredClone(advertised), outputs={};
  if(fault==='changed-number')current.number=3;
  if(fault==='changed-head')current.head.sha='c'.repeat(40);
  if(fault==='changed-ref')current.head.ref='candidate/other';
  if(fault==='closed')current.state='closed';
  if(fault==='draft')current.draft=true;
  const github={paginate:async()=>fault==='ambiguous'?[advertised,{...advertised,number:3}]:[advertised],
    rest:{pulls:{list(){},get:async()=>{if(fault==='API-failure')throw Error('lookup unavailable');return {data:current};}}}};
  const context={repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},runId:800,sha,
    eventName:'workflow_dispatch',ref:'refs/heads/'+advertised.head.ref,payload:{}};
  await assert.rejects(route({github,context,core:{setOutput:(k,v)=>outputs[k]=v,info(){}},
    root:require('node:path').resolve(__dirname,'../..'),mode:'candidate',cancelObsolete:false}));
  assert.equal(outputs.pr_number,undefined);assert.equal(outputs.full,undefined);
 });
}


test('current closed PR cancels only older quick runs and starts no checks', async () => {
  const pull=ready(); pull.state='closed';
  const outputs={}, calls=[];
  const run=(id, event, branch, number=2)=>({id,event,head_branch:branch,status:'in_progress',pull_requests:event==='pull_request'?[{number}]:[]});
  const github={rest:{pulls:{get:async()=>{calls.push('current');return {data:pull};}},
    actions:{listWorkflowRuns(){},cancelWorkflowRun:async({run_id})=>calls.push('cancel-'+run_id)}},
    paginate:async(method,args)=>{assert.equal(args.workflow_id,'ci.yml');calls.push('list');return [
      run(1,'pull_request',pull.head.ref),run(2,'push',pull.head.ref),run(4,'push',pull.head.ref),run(0,'pull_request','other',9)];}};
  await route({github,context:{eventName:'pull_request',repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},
    payload:{pull_request:pull,action:'closed'},ref:'refs/pull/2/merge',runId:3},
    core:{setOutput:(key,value)=>outputs[key]=value,info(){}},mode:'quick'});
  assert.deepEqual(calls,['current','list','cancel-1','cancel-2']);
  assert.equal(outputs.quick,'false');assert.equal(outputs.full,'false');
});

// Exercise the actual job expression: a skipped fork router must not allocate
// a privileged self-hosted terminal job, while same-repository failures fail closed.
for (const [name, fork, routeResult, full, cancelled, eventName, expected] of [
  ['fork skipped router', true, 'skipped', '', false, 'pull_request', false],
  ['same repository failed router', false, 'failure', '', false, 'pull_request', true],
  ['Ready full route', false, 'success', 'true', false, 'pull_request', true],
  ['quick route', false, 'success', 'false', false, 'pull_request', false],
  ['cancelled route', false, 'success', 'true', true, 'pull_request', false],
  ['manual failed router', false, 'failure', '', false, 'workflow_dispatch', true],
]) {
  test(`candidate terminal runner guard: ${name}`, () => {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const yaml = fs.readFileSync(path.join(__dirname, '../../.github/workflows/candidate.yml'), 'utf8');
    const block = yaml.slice(yaml.indexOf('  candidate-full-gate:'));
    const expression = block.match(/^    if: (.+)$/m)[1];
    const actual = vm.runInNewContext(expression, {
      always: () => true, cancelled: () => cancelled,
      github: {event_name: eventName, repository,
        event: eventName === 'pull_request'
          ? {pull_request: {head: {repo: {full_name: fork ? 'other/fork' : repository}}}}
          : {}},
      needs: {route: {result: routeResult, outputs: {full}}},
    });
    assert.equal(actual, expected);
  });
}

test('Candidate workflow routes Ready PR to full with exact candidate identity',async t=>{
 const before=process.env.GITHUB_RUN_NUMBER;process.env.GITHUB_RUN_NUMBER='9';
 t.after(()=>{if(before===undefined)delete process.env.GITHUB_RUN_NUMBER;else process.env.GITHUB_RUN_NUMBER=before;});
 const pull=ready(),outputs={};
 await route({github:{rest:{pulls:{get:async()=>({data:pull})}}},
  context:{eventName:'pull_request',repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},payload:{pull_request:pull,action:'synchronize'},ref:'refs/pull/2/merge',sha:'c'.repeat(40),runId:50},
  core:{setOutput:(k,v)=>outputs[k]=v,info(){}},mode:'candidate',cancelObsolete:false});
 assert.equal(outputs.full,'true');assert.equal(outputs.quick,'false');
 assert.equal(outputs.head_ref,pull.head.ref);assert.equal(outputs.pr_number,'2');
 assert.equal(outputs.kind,'candidate');assert.equal(outputs.source_sha,'c'.repeat(40));
});
test('PR does not cancel same-commit duplicate push cleanup',async()=>{
 const {cancelOlder}=require('../workflow_policy.cjs'),pull=ready(),cancelled=[];
 const rows=[{id:1,status:'in_progress',event:'push',head_branch:pull.head.ref,head_sha:pull.head.sha},
  {id:2,status:'in_progress',event:'push',head_branch:pull.head.ref,head_sha:'d'.repeat(40)}];
 await cancelOlder({github:{paginate:async()=>rows,rest:{actions:{listWorkflowRuns(){},cancelWorkflowRun:async({run_id})=>cancelled.push(run_id)}}},
  context:{repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},runId:3},core:{info(){}},pull,mode:'checks'});
 assert.deepEqual(cancelled,[2]);
});

for (const state of ['ready', 'draft', 'feature', 'other-base', 'closed']) {
  test(`split workflows select exactly one build path for ${state}`, async t => {
    const previous=process.env.GITHUB_RUN_NUMBER;process.env.GITHUB_RUN_NUMBER="9";
    t.after(()=>{if(previous===undefined)delete process.env.GITHUB_RUN_NUMBER;else process.env.GITHUB_RUN_NUMBER=previous;});
    const pull=ready();
    if(state==='draft')pull.draft=true;
    if(state==='feature')pull.head.ref='feat/work';
    if(state==='other-base')pull.base.ref='develop';
    if(state==='closed')pull.state='closed';
    const selected=[];
    for(const mode of ['quick','candidate']) {
      const outputs={};
      await route({github:{rest:{pulls:{get:async()=>({data:pull})}}},
        context:{eventName:'pull_request',repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},
          payload:{pull_request:pull,action:state==='closed'?'closed':'synchronize'},
          ref:'refs/pull/2/merge',sha,runId:50},
        core:{setOutput:(k,v)=>outputs[k]=v,info(){}},
        root:require('node:path').resolve(__dirname,'../..'),mode,cancelObsolete:false});
      if(outputs.quick==='true')selected.push('quick');
      if(outputs.full==='true')selected.push('candidate');
      if(mode==='quick')assert.equal(outputs.identity,undefined);
    }
    assert.deepEqual(selected,state==='closed'?[]:state==='ready'?['candidate']:['quick']);
  });
}

test('manual CI runs quick without discovering a candidate PR',async()=>{
  const outputs={};
  await route({github:{},context:{eventName:'workflow_dispatch',
    repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},payload:{},ref:'refs/heads/feat/work'},
    core:{setOutput:(k,v)=>outputs[k]=v,info(){}},mode:'quick',cancelObsolete:false});
  assert.equal(outputs.quick,'true');assert.equal(outputs.full,'false');
  assert.equal(outputs.identity,undefined);
});

for(const mode of ['quick','candidate']) {
  for(const state of ['ready','draft','closed','other-base']) {
    test(`${mode} cancels only its own obsolete runs after ${state}`,async t=>{
      const previous=process.env.GITHUB_RUN_NUMBER;process.env.GITHUB_RUN_NUMBER="9";
      t.after(()=>{if(previous===undefined)delete process.env.GITHUB_RUN_NUMBER;else process.env.GITHUB_RUN_NUMBER=previous;});
      const pull=ready(),calls=[],outputs={};
      if(state==='draft')pull.draft=true;
      if(state==='closed')pull.state='closed';
      if(state==='other-base')pull.base.ref='develop';
      const github={rest:{pulls:{get:async()=>({data:pull})},actions:{listWorkflowRuns(){},
        cancelWorkflowRun:async({run_id})=>calls.push(run_id)}},
        paginate:async(method,args)=>{
          assert.equal(args.workflow_id,mode==='candidate'?'candidate.yml':'ci.yml');
          return [{id:1,status:'in_progress',pull_requests:[{number:pull.number}]},
            {id:51,status:'in_progress',pull_requests:[{number:pull.number}]}];
        }};
      await route({github,context:{eventName:'pull_request',
        repo:{owner:'AutoLifeRobot',repo:'AutolifeGMR-V3'},
        payload:{pull_request:pull,action:state==='closed'?'closed':state==='draft'?'converted_to_draft':state==='other-base'?'edited':'synchronize',
          ...(state==='other-base'?{changes:{base:{ref:{from:'main'}}}}:{})},
        ref:'refs/pull/2/merge',sha,runId:50},
        core:{setOutput:(k,v)=>outputs[k]=v,info(){}},
        root:require('node:path').resolve(__dirname,'../..'),mode});
      assert.deepEqual(calls,[1]);
    });
  }
}

test('workflow files expose separate quick and candidate owners with the existing gate',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const quick=fs.readFileSync(path.join(__dirname,'../../.github/workflows/ci.yml'),'utf8');
  const full=fs.readFileSync(path.join(__dirname,'../../.github/workflows/candidate.yml'),'utf8');
  assert.match(quick,/mode: 'quick'/);assert.match(quick,/delivery-kind: quick/);
  assert.doesNotMatch(quick,/candidate-full-gate:|delivery-kind: candidate/);
  assert.match(full,/mode: 'candidate'/);assert.match(full,/delivery-kind: candidate/);
  assert.match(full,/candidate-full-gate:/);assert.doesNotMatch(full,/delivery-kind: quick|^  push:/m);
});

test('Candidate and Release export, validate and upload only the final publication directory',()=>{
 const fs=require('node:fs'),path=require('node:path');
 const yaml=fs.readFileSync(path.join(__dirname,'../../.github/workflows/reusable-full.yml'),'utf8');
 assert.match(yaml,/ci\/seal.py "\$COMPONENT_OUTPUT\/artifacts" --output "\$COMPONENT_OUTPUT\/publication"/);
 assert.match(yaml,/ci\/release_contract.py" --directory "\$COMPONENT_OUTPUT\/publication"/);
 const original=yaml.split('      - uses: actions/upload-artifact@v4\n        id: original\n')[1].split('      - name:')[0];
 assert.match(original,/path: \$\{\{ env.COMPONENT_OUTPUT \}\}\/publication\/\*/);
 assert.doesNotMatch(original,/\/artifacts\//);
});

test('ISO packages are downloadable without the optional Release integration job',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const workflow=fs.readFileSync(path.join(__dirname,'../../.github/workflows/ci.yml'),'utf8');
  const optional=workflow.split('  release-install:\n')[1];
  assert.match(optional,/needs: iso-package/);
  assert.match(optional,/if: vars.ISO_VERIFY_WITH_RELEASE == 'true'/);
  assert.match(optional,/needs.iso-package.outputs.qualification-artifact-id/);
  const build=fs.readFileSync(path.join(__dirname,'../../.github/workflows/reusable-full.yml'),'utf8');
  for(const label of ['Fetch pinned Release import validator','Verify exact original with Release import contract']){
    const step=build.split('      - name: '+label+'\n')[1].split('\n      - ')[0];
    assert.match(step,/!\(inputs.delivery-kind == 'development' && github.event_name == 'push'\)/);
  }
});
