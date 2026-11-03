'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {receipt} = require('../development-receipt.cjs');
function fixture() {
  const result = {failed: false, written: false, table: null, calls: []};
  const summary = {addHeading(){return this;},addLink(){return this;},addRaw(){return this;},
    addTable(rows){result.table=rows;return this;},async write(){result.written=true;}};
  const core = {summary,warning(){},info(){},setFailed(){result.failed=true;}};
  const context = {repo:{owner:'Example',repo:'GMR'},runId:42,sha:'a'.repeat(40)};
  const api = () => {};
  const github = {rest:{actions:{listJobsForWorkflowRunAttempt:api}},async paginate(fn, args){
    result.calls.push(args.attempt_number);
    return args.attempt_number===2 ? [{name:'verify',runner_name:'runner-2',steps:[{name:'Upload final package',conclusion:'failure'}]}] :
      ['source','package'].map(name=>({name,runner_name:'runner-1',steps:[]}));
  }};
  return {result,core,context,github,attempt:2,needs:{source:{result:'success'},package:{result:'success'},verify:{result:'failure'}}};
}
test('artifact failure produces a failed summary with runner and failing step, without Artifact API',async()=>{
  const f=fixture();assert.equal(await receipt(f),false);assert.equal(f.result.written,true);
  assert.equal(f.result.failed,true);assert.deepEqual(f.result.calls,[2,1]);
  assert.deepEqual(f.result.table[3],['verify','failure','runner-2','2','Upload final package']);
});
test('runner lookup failure preserves authoritative job failure and still writes receipt',async()=>{
  const f=fixture();f.github.paginate=async()=>{throw new Error('offline');};
  assert.equal(await receipt(f),false);assert.equal(f.result.written,true);assert.equal(f.result.failed,true);
});
test('all required successes pass; missing or skipped required stages fail',async()=>{
  const f=fixture();f.needs.verify.result='success';assert.equal(await receipt(f),true);assert.equal(f.result.failed,false);
  for (const status of ['skipped','cancelled',undefined]) {
    const g=fixture();g.needs.verify.result=status;assert.equal(await receipt(g),false);
  }
});

test('reusable Development job names remain visible in runner receipts',async()=>{
 const f=fixture();f.needs.verify.result='success';
 f.github.paginate=async()=>['source','package','verify'].map(name=>({name:'development / '+name,runner_name:'self-hosted-test',steps:[]}));
 assert.equal(await receipt(f),true);
 assert.equal(f.result.table[1][2],'self-hosted-test');assert.equal(f.result.table[3][2],'self-hosted-test');
});

// Exercise the real workflow's inline scripts and conditions, including the
// source-bootstrap failure where checkout's default ref would be unsafe.
function gateSteps() {
  const fs=require('node:fs'),path=require('node:path');
  const yaml=fs.readFileSync(path.join(__dirname,'../../.github/workflows/development-controller.yml'),'utf8');
  const gate=yaml.slice(yaml.indexOf('  development-full-gate:'));
  assert.match(gate,/^    if: always\(\)$/m);
  return gate.split(/^      - /m).slice(1).map(block=>({
    block, condition:block.match(/^        if: (.+)$/m)?.[1],
    script:block.match(/^          script: \|\n([\s\S]*)/m)?.[1].replace(/^            /gm,''),
  }));
}
for(const [name,sha,checkoutOutcome,verifyResult] of [
  ['source bootstrap failure','', 'skipped','skipped'],
  ['invalid controller pin','main','skipped','skipped'],
  ['short controller pin','a'.repeat(39),'skipped','skipped'],
  ['trusted checkout failure','a'.repeat(40),'failure','success'],
  ['trusted checkout cancellation','a'.repeat(40),'cancelled','success'],
  ['trusted validation failure','a'.repeat(40),'success','failure'],
  ['successful Development','a'.repeat(40),'success','success'],
]) {
  test(`terminal receipt fails closed: ${name}`,async()=>{
    const vm=require('node:vm'),f=fixture();
    f.needs.source.result=sha.length===40?'success':'failure';
    f.needs.package.result=sha.length===40?'success':'skipped';
    f.needs.verify.result=verifyResult;
    const steps={pin:{outputs:{sha:''}},checkout:{outcome:'skipped'}};
    let required=0,checkedOut=0,inline=0;
    const sandbox={core:{...f.core,setOutput:(key,value)=>steps.pin.outputs[key]=value},
      process:{env:{CONTROLLER_SHA:sha,NEEDS:JSON.stringify(f.needs),GITHUB_RUN_ATTEMPT:'2'}},
      steps,always:()=>true,github:f.github,context:f.context,
      require:module=>{
        required++;assert.equal(module,'./ci/development-receipt.cjs');
        assert.equal(steps.checkout.outcome,'success');
        assert.match(steps.pin.outputs.sha,/^[a-f0-9]{40}$/);
        return {receipt};
      }};
    for(const step of gateSteps()) {
      const enabled=step.condition?vm.runInNewContext(step.condition,sandbox):true;
      if(!enabled)continue;
      if(step.block.startsWith('uses: actions/checkout@v4')) {
        checkedOut++;
        assert.match(step.block,/ref: \$\{\{ steps.pin.outputs.sha \}\}/);
        assert.match(steps.pin.outputs.sha,/^[a-f0-9]{40}$/);
        steps.checkout.outcome=checkoutOutcome;
      } else {
        assert.ok(step.script,'Expected inline github-script');
        if(step.block.includes('Write inline failure receipt'))inline++;
        await vm.runInNewContext(`(async()=>{${step.script}\n})()`,sandbox);
      }
    }
    const trusted=sha.length===40 && checkoutOutcome==='success';
    assert.equal(checkedOut,sha.length===40?1:0);
    assert.equal(required,trusted?1:0);assert.equal(inline,trusted?0:1);
    assert.equal(f.result.written,true);
    assert.equal(f.result.failed,!(trusted && verifyResult==='success'));
    if(!trusted)assert.deepEqual(JSON.parse(JSON.stringify(f.result.table)),[
      ['Stage','Result'],...['source','package','verify'].map(key=>[key,f.needs[key].result])]);
  });
}

test('SDK prefetch runs through the trusted container wrapper with a read-only token',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const yaml=fs.readFileSync(path.join(__dirname,'../../.github/workflows/development-controller.yml'),'utf8');
  const compile=yaml.split('      - name: Compile, package and test the original\n')[1].split('      - uses:')[0];
  assert.match(compile,/GH_TOKEN: \$\{\{ secrets.BINARY_ARTIFACTS_TOKEN \|\| github.token \}\}/);
  assert.match(compile,/bash controller\/ci\/docker.sh full/);
  assert.doesNotMatch(yaml,/python3? ci\/fetch_inputs.py/);
});
