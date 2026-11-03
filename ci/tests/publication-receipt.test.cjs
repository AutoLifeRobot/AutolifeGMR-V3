'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {receipt}=require('../publication-receipt.cjs');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gmr-publication-receipt-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const version='1.1.5+dev.42',identity=path.join(root,'control.json'),result=path.join(root,'result.json');
  fs.writeFileSync(identity,JSON.stringify({delivery:{release_version:version}}));
  fs.writeFileSync(result,JSON.stringify({id:'a'.repeat(32),phase:'committed',version}));
  const state={failed:false,written:false,rows:[],commands:[]};
  const summary={addHeading(){return this;},addTable(rows){state.rows=rows;return this;},
    addLink(){return this;},addRaw(){return this;},addCodeBlock(s){state.commands.push(s);return this;},
    async write(){state.written=true;}};
  return {state,identity,result,server:'https://release.example',outcome:'success',jobStatus:'success',
    core:{summary,info(){},setFailed(){state.failed=true;}},context:{payload:{workflow_run:{html_url:'https://github.com/Example/GMR/actions/runs/42'}}}};
}
test('successful Release helper response produces server delivery receipt and exact commands',async t=>{
  const f=fixture(t);assert.equal(await receipt(f),'SUCCESS');assert.equal(f.state.written,true);
  assert.equal(f.state.failed,false);assert.ok(f.state.commands[0].includes('--version 1.1.5+dev.42'));
  assert.ok(f.state.rows.some(row=>row[0]==='Delivery verification'&&row[1]==='verified'));
});
test('failed upload or missing result never shows success or installation commands',async t=>{
  for(const outcome of ['failure','success']) {
    const f=fixture(t);fs.unlinkSync(f.result);f.outcome=outcome;
    assert.equal(await receipt(f),'FAILED');assert.equal(f.state.written,true);
    assert.equal(f.state.failed,true);assert.equal(f.state.commands.length,0);
  }
});
test('skipped upload is explicit; mismatched version and uncommitted response are rejected',async t=>{
  const f=fixture(t);f.outcome='skipped';assert.equal(await receipt(f),'NOT UPLOADED');assert.equal(f.state.failed,false);
  for(const change of [{version:'1.1.5+dev.43'},{phase:'uploading'}]) {
    const g=fixture(t),value=JSON.parse(fs.readFileSync(g.result));Object.assign(value,change);
    fs.writeFileSync(g.result,JSON.stringify(value));assert.equal(await receipt(g),'FAILED');
  }
});
