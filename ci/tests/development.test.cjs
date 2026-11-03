'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {identity} = require('../development.cjs');
const input = {repository:'AutoLifeRobot/AutolifeGMR-V3',ref:'refs/heads/feat/demo',sha:'a'.repeat(40),
  eventName:'workflow_dispatch',runId:123,attempt:1,date:new Date('2026-10-27T06:07:08.009Z')};
test('development download name includes repository branch UTC timestamp and eight SHA characters',()=>{
  assert.equal(identity(input).name,'AutolifeGMR-V3-feat-demo-20261027T060708009Z-aaaaaaaa');
  assert.equal(identity(input).build_number,'123');
});
for (const change of [{eventName:'push'},{eventName:'pull_request'},
  {ref:'refs/tags/test'},{sha:'short'},{runId:0},{attempt:0},{repository:'missing-owner'},{date:new Date('invalid')}])
  test(`reject invalid development input ${JSON.stringify(change)}`,()=>assert.throws(()=>identity({...input,...change})));
test('branch text cannot escape the artifact filename or workflow output',()=>{
  const result=identity({...input,ref:'refs/heads/feat/测试/$(touch pwn)\nname=other'});
  assert.match(result.name,/^[A-Za-z0-9][A-Za-z0-9._-]+$/);
  assert.ok(result.name.length<=240);
});
test('a later manual retry gets a separate downloadable original',()=>{
  assert.notEqual(identity(input).name,identity({...input,attempt:2,date:new Date('2026-10-27T06:07:08.010Z')}).name);
});

test('only an ISO branch push can build the automatic development original', () => {
  const iso = {...input, ref:'refs/heads/feat/v3-release-iso', eventName:'push'};
  assert.equal(identity(iso).branch, 'feat/v3-release-iso');
  for (const ref of ['refs/heads/main','refs/heads/feat/other','refs/tags/feat/v3-release-iso'])
    assert.throws(() => identity({...iso,ref}));
  assert.throws(() => identity({...iso,eventName:'pull_request'}));
});
