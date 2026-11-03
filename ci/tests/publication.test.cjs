'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {validate,publish}=require('../publish.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const matchingTag=context=>({getRef:async({ref})=>({data:{ref:'refs/'+ref,object:{type:'commit',sha:context.sha}}})});
function fixture(t) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'gmr-publication-test-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  process.env.EXPECTED_BUILD='7';process.env.GITHUB_RUN_ATTEMPT='2';
  const context={ref:'refs/heads/main',eventName:'push',sha:'a'.repeat(40),runId:12,repo:{owner:'Example',repo:'GMR'}};
  const put=(n,v)=>fs.writeFileSync(path.join(directory,n),typeof v==='string'?v:JSON.stringify(v));
  put('gmr.tar.gz','test original');put('inputs.lock.json','{}');
  put('source.json',{status:'passed',source_sha:context.sha});
  put('build-metadata.json',{kind:'formal',source_dirty:false,source_sha:context.sha,tree_sha:'b'.repeat(40),run_id:12,build_number:7,run_attempt:1,base_version:'1.1.5',version:'1.1.5+build7'});
  put('consumer.json',{status:'passed',installed_package:'passed',source_sha:context.sha,archive_sha256:hash('test original'),inputs_sha256:hash('{}')});
  const proof={schema:'autolife.component-delivery/1',component:'gmr',source_dirty:false,source_sha:context.sha,tree_sha:'b'.repeat(40),version:'1.1.5',delivery:{kind:'formal',source_ref:'refs/heads/main',source_sha:context.sha,run_id:12,build_number:7,release_version:'1.1.5+build7'},files:fs.readdirSync(directory).map(name=>{const b=fs.readFileSync(path.join(directory,name));return {path:name,sha256:hash(b),size:b.length};})};
  put('delivery-manifest.json',proof);
  put('SHA256SUMS',fs.readdirSync(directory).sort().map(n=>`${hash(fs.readFileSync(path.join(directory,n)))}  ${n}\n`).join(''));
  return {directory,context,put};
}
test('same-run publication retry accepts earlier validated attempt',t=>{
 const f=fixture(t); assert.equal(validate(f.directory,f.context).tag,'v1.1.5-build7');
});
test('a development proof is rejected even if submitted through the main publisher',t=>{
 const f=fixture(t),file=path.join(f.directory,'delivery-manifest.json');
 const proof=JSON.parse(fs.readFileSync(file));proof.delivery.kind='development';f.put('delivery-manifest.json',proof);
 assert.throws(()=>validate(f.directory,f.context),/Wrong qualified run/);
});
for (const change of ['bytes','source','branch','extra-file','checksums']) test(`reject ${change} before remote writes`,t=>{
 const f=fixture(t);
 if(change==='bytes')f.put('gmr.tar.gz','changed');
 if(change==='source')f.context.sha='c'.repeat(40);
 if(change==='branch')f.context.ref='refs/heads/feature';
 if(change==='extra-file')f.put('private.key','never-publish');
 if(change==='checksums')f.put('SHA256SUMS','wrong');
 assert.throws(()=>validate(f.directory,f.context));
});
test('different remote same-name bytes are never overwritten or published',async t=>{
 const f=fixture(t);let writes=0;
 const github={paginate:async()=>[{id:1,name:'gmr.tar.gz'}],rest:{git:matchingTag(f.context),repos:{
  getReleaseByTag:async()=>({data:{id:2,target_commitish:f.context.sha,prerelease:true,draft:true}}),
  getReleaseAsset:async()=>({data:Buffer.from('different bytes')}),
  uploadReleaseAsset:async()=>{writes++},updateRelease:async()=>{writes++}
 }}};
 // Force comparison of the existing original first by also providing exact other assets.
 const files=validate(f.directory,f.context).names;
 github.paginate=async()=>files.map((name,i)=>({id:i,name}));
 github.rest.repos.getReleaseAsset=async({asset_id})=>({data:files[asset_id]==='gmr.tar.gz'?Buffer.from('different'):fs.readFileSync(path.join(f.directory,files[asset_id]))});
 await assert.rejects(publish({...f,github}),/differ/);assert.equal(writes,0);
});

test('publish a draft completely before exposing a prerelease; rerun is read-only',async t=>{
 const f=fixture(t),assets=[],writes=[];let release;
 const github={paginate:async()=>assets,rest:{git:matchingTag(f.context),repos:{
  getReleaseByTag:async()=>{if(!release)throw Object.assign(new Error('missing'),{status:404});return {data:release}},
  createRelease:async options=>{writes.push('create');assert.equal(options.draft,true);assert.equal(options.make_latest,'false');release={...options,id:3};return {data:release}},
  uploadReleaseAsset:async options=>{assert.equal(release.draft,true);writes.push(options.name);assets.push({id:assets.length,name:options.name,data:options.data})},
  getReleaseAsset:async({asset_id})=>({data:assets[asset_id].data}),
  updateRelease:async options=>{assert.equal(assets.length,validate(f.directory,f.context).names.length);assert.equal(options.prerelease,true);assert.equal(options.make_latest,'false');writes.push('publish');release={...release,...options}}
 }}};
 const result=await publish({...f,github});assert.equal(result.tag,'v1.1.5-build7');assert.equal(writes.at(-1),'publish');
 const before=[...writes];await publish({...f,github});assert.deepEqual(writes,before);
});

test('a failed draft upload resumes without replacing earlier bytes',async t=>{
 const f=fixture(t),assets=[];let completed=false,fail=true;
 const github={paginate:async()=>assets,rest:{git:matchingTag(f.context),repos:{
  getReleaseByTag:async()=>({data:{id:3,target_commitish:f.context.sha,draft:true,prerelease:true}}),
  uploadReleaseAsset:async options=>{if(assets.length===2 && fail){fail=false;throw new Error('upload interrupted')}assets.push({id:assets.length,name:options.name,data:options.data})},
  getReleaseAsset:async({asset_id})=>({data:assets[asset_id].data}),
  updateRelease:async()=>{completed=true}
 }}};
 await assert.rejects(publish({...f,github}),/interrupted/);assert.equal(completed,false);assert.equal(assets.length,2);
 await publish({...f,github});assert.equal(completed,true);
 assert.equal(assets.length,validate(f.directory,f.context).names.length);assert.equal(new Set(assets.map(x=>x.name)).size,assets.length);
});

for (const annotated of [false,true]) test(`wrong ${annotated?'annotated':'lightweight'} tag is rejected before writes`,async t=>{
 const f=fixture(t);let writes=0;
 const github={rest:{git:{getRef:async({ref})=>({data:{ref:'refs/'+ref,object:{type:annotated?'tag':'commit',sha:'b'.repeat(40)}}})},repos:{
  getReleaseByTag:async()=>{throw Object.assign(new Error('no release'),{status:404});},
  getCommit:async({ref})=>{assert.equal(ref,'tags/v1.1.5-build7');return {data:{sha:'b'.repeat(40)}};},
  createRelease:async()=>{writes++;throw new Error('must not create');},
  uploadReleaseAsset:async()=>{writes++;},updateRelease:async()=>{writes++;}
 }}};
 await assert.rejects(publish({...f,github}),/another source commit/);assert.equal(writes,0);
});

test('new draft can defer tag creation until publication and rerun is read-only',async t=>{
 const f=fixture(t),assets=[];let release,tagExists=false,exposed=0;
 const github={paginate:async()=>assets,rest:{git:{getRef:async({ref})=>{
  if(!tagExists)throw Object.assign(new Error('tag absent'),{status:404});
  return {data:{ref:'refs/'+ref,object:{type:'commit',sha:f.context.sha}}};
 }},repos:{
  getReleaseByTag:async()=>{if(!release)throw Object.assign(new Error('absent'),{status:404});return {data:release};},
  createRelease:async options=>({data:release={...options,id:9}}),
  uploadReleaseAsset:async options=>{assets.push({id:assets.length,name:options.name,data:options.data});},
  getReleaseAsset:async({asset_id})=>({data:assets[asset_id].data}),
  updateRelease:async options=>{tagExists=true;exposed++;release={...release,...options};}
 }}};
 await publish({...f,github});assert.equal(exposed,1);
 // A public release's target_commitish can be a branch: the actual tag is authoritative.
 release.target_commitish='main';await publish({...f,github});assert.equal(exposed,1);
 tagExists=false;await assert.rejects(publish({...f,github}),/tag absent/);
});

test('matching annotated tag resolves in tag namespace and can publish',async t=>{
 const f=fixture(t),assets=[];let exposed=false;
 const github={paginate:async()=>assets,rest:{git:{getRef:async({ref})=>({data:{ref:'refs/'+ref,object:{type:'tag',sha:'b'.repeat(40)}}})},repos:{
  getReleaseByTag:async()=>({data:{id:3,target_commitish:f.context.sha,draft:true,prerelease:true}}),
  getCommit:async({ref})=>{assert.equal(ref,'tags/v1.1.5-build7');return {data:{sha:f.context.sha}};},
  uploadReleaseAsset:async options=>{assets.push({id:assets.length,name:options.name,data:options.data});},
  updateRelease:async()=>{exposed=true;}
 }}};
 await publish({...f,github});assert.equal(exposed,true);
});

test('tag changed during upload is rejected before exposing the draft',async t=>{
 const f=fixture(t),assets=[];let reads=0,exposed=false;
 const github={paginate:async()=>assets,rest:{git:{getRef:async({ref})=>({data:{ref:'refs/'+ref,object:{type:'commit',sha:++reads===1?f.context.sha:'b'.repeat(40)}}})},repos:{
  getReleaseByTag:async()=>({data:{id:3,target_commitish:f.context.sha,draft:true,prerelease:true}}),
  uploadReleaseAsset:async options=>{assets.push({id:assets.length,name:options.name,data:options.data});},
  updateRelease:async()=>{exposed=true;}
 }}};
 await assert.rejects(publish({...f,github}),/another source commit/);assert.equal(exposed,false);
});

for (const listed of [false,true]) test(`standalone wheel ${listed?'declared in proof':'outside proof'} is rejected before publication`,async t=>{
 const f=fixture(t),bytes='duplicate build product';f.put('gmr.whl',bytes);
 if(listed) {
  const proof=JSON.parse(fs.readFileSync(path.join(f.directory,'delivery-manifest.json')));
  proof.files.push({path:'gmr.whl',size:Buffer.byteLength(bytes),sha256:hash(bytes)});
  f.put('delivery-manifest.json',proof);
 }
 // A self-consistent checksum index cannot turn an intermediate wheel into an attachment.
 if(listed) f.put('SHA256SUMS',fs.readdirSync(f.directory).filter(n=>n!=='SHA256SUMS').sort()
  .map(n=>`${hash(fs.readFileSync(path.join(f.directory,n)))}  ${n}\n`).join(''));
 let requests=0;
 const github={rest:{repos:{getReleaseByTag:async()=>{requests++;throw Error('must not reach network');}}}};
 await assert.rejects(publish({...f,github}),listed?/Standalone wheels/:/Unexpected publication files/);
 assert.equal(requests,0);
});

test('GitHub final assets contain archive and bound evidence, with no standalone wheel',async t=>{
 const f=fixture(t),assets=[];let exposed=false;
 const expected=['SHA256SUMS','build-metadata.json','consumer.json','delivery-manifest.json',
  'gmr.tar.gz','inputs.lock.json','source.json'].sort();
 const github={paginate:async()=>[],rest:{git:matchingTag(f.context),repos:{
  getReleaseByTag:async()=>({data:{id:3,target_commitish:f.context.sha,draft:true,prerelease:true}}),
  uploadReleaseAsset:async({name,data})=>{assets.push(name);assert.deepEqual(data,fs.readFileSync(path.join(f.directory,name)));},
  updateRelease:async()=>{exposed=true;}
 }}};
 await publish({...f,github});
 assert.equal(exposed,true);assert.deepEqual(assets.sort(),expected);
 assert.equal(assets.some(name=>name.endsWith('.whl')),false);
});
