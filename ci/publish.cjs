'use strict';
// Publish the qualified main original to GitHub; a separate job registers the
// same bytes in component dev. Neither job advances system alpha/stable.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const check = (ok, message) => { if (!ok) throw new Error(message); };
function validate(directory, context, build = process.env.EXPECTED_BUILD) {
  check(context.ref === 'refs/heads/main' && ['push', 'workflow_dispatch'].includes(context.eventName), 'Formal publication requires main');
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name)));
  const proof = read('delivery-manifest.json'), meta = read('build-metadata.json'), report = read('consumer.json');
  check(proof.schema === 'autolife.component-delivery/1' && proof.component === 'gmr' && proof.source_dirty === false, 'Invalid GMR delivery proof');
  check(proof.delivery.kind === 'formal' && proof.source_sha === context.sha && proof.delivery.source_sha === context.sha &&
    proof.delivery.run_id === Number(context.runId) && proof.delivery.build_number === Number(build), 'Wrong qualified run/source/build');
  check(meta.kind === 'formal' && meta.source_dirty === false && meta.source_sha === context.sha &&
    meta.run_id === Number(context.runId) && meta.build_number === Number(build) &&
    Number.isInteger(meta.run_attempt) && meta.run_attempt > 0 && meta.run_attempt <= Number(process.env.GITHUB_RUN_ATTEMPT), 'Invalid producer attempt');
  check(report.status === 'passed' && report.installed_package === 'passed' && report.source_sha === context.sha, 'Consumer is not qualified');
  const names = new Set();
  for (const item of proof.files) {
    check(!/\.whl$/i.test(item.path), 'Standalone wheels are build products, not publication attachments');
    check(/^[a-zA-Z0-9_.+-]+$/.test(item.path) && !['.', '..', 'delivery-manifest.json','SHA256SUMS'].includes(item.path) && !names.has(item.path), 'Unsafe or duplicate artifact');
    names.add(item.path);
    const filename = path.join(directory, item.path);
    check(fs.lstatSync(filename).isFile(), 'Only regular files may be published');
    const bytes = fs.readFileSync(filename);
    check(bytes.length === item.size && hash(bytes) === item.sha256, 'Changed original: ' + item.path);
  }
  for (const name of ['build-metadata.json','consumer.json','source.json','inputs.lock.json']) check(names.has(name), 'Missing evidence: ' + name);
  const archives = [...names].filter(n => n.endsWith('.tar.gz'));
  check(archives.length === 1 && hash(fs.readFileSync(path.join(directory, archives[0]))) === report.archive_sha256, 'Wrong consumer original');
  check(hash(fs.readFileSync(path.join(directory,'inputs.lock.json'))) === report.inputs_sha256, 'Wrong consumer input lock');
  check(read('source.json').status === 'passed' && read('source.json').source_sha === context.sha, 'Source checks did not pass');
  check(proof.delivery.source_ref === 'refs/heads/main', 'Formal source ref must be main');
  check(proof.version === meta.base_version && proof.tree_sha === meta.tree_sha && proof.delivery.release_version === meta.version &&
        meta.version === `${proof.version}+build${Number(build)}`, 'Version/tree identity mismatch');
  names.add('delivery-manifest.json');
  const checksums = [...names].sort().map(n => `${hash(fs.readFileSync(path.join(directory,n)))}  ${n}\n`).join('');
  check(fs.readFileSync(path.join(directory,'SHA256SUMS'),'utf8') === checksums, 'Checksum index differs');
  names.add('SHA256SUMS');
  check(fs.readdirSync(directory).length === names.size, 'Unexpected publication files');
  return {names: [...names].sort(), tag: `v${proof.version}-build${Number(build)}`, proof};
}
async function verifyTag({github, context, tag, allowMissing}) {
  let reference;
  try { reference = (await github.rest.git.getRef({...context.repo, ref: `tags/${tag}`})).data; }
  catch (error) {
    // GitHub can defer creating a new draft's tag until it is made public.
    if (error.status === 404 && allowMissing) return;
    throw error;
  }
  const target = reference.object || {};
  check(reference.ref === `refs/tags/${tag}` && ['commit', 'tag'].includes(target.type) &&
        /^[a-f0-9]{40}$/.test(target.sha || ''), 'Invalid exact release tag reference');
  let commit = target.sha;
  if (target.type === 'tag') {
    // Resolve annotated tags in the tag namespace, never a same-named branch.
    commit = (await github.rest.repos.getCommit({...context.repo, ref: `tags/${tag}`})).data.sha;
  }
  check(commit === context.sha, 'Release tag points to another source commit');
}
async function publish({github, context, directory}) {
  const {names, tag, proof} = validate(directory, context);
  let release;
  try { release = (await github.rest.repos.getReleaseByTag({...context.repo, tag})).data; }
  catch (e) { if (e.status !== 404) throw e; }
  await verifyTag({github, context, tag, allowMissing: !release || release.draft === true});
  if (!release) release = (await github.rest.repos.createRelease({...context.repo, tag_name: tag,
    target_commitish: context.sha, name: tag, draft: true, prerelease: true, make_latest: 'false',
    body: `GMR Pre-release from main ${context.sha}.\n\nSource, installed-package software checks passed. Hardware and external business platform unverified. The following server-publish job registers these same bytes in component dev with formal qualification; check its result separately. System alpha/stable are unchanged.`})).data;
  check(release.prerelease === true && typeof release.draft === 'boolean' &&
        (!release.draft || release.target_commitish === context.sha), 'Existing release has another identity/type');
  const existing = await github.paginate(github.rest.repos.listReleaseAssets,{...context.repo,release_id:release.id,per_page:100});
  check(existing.every(a => names.includes(a.name)), 'Existing release has unexpected assets');
  for (const name of names) {
    const bytes=fs.readFileSync(path.join(directory,name));
    const found=existing.find(a => a.name===name);
    if (found) {
      // Verify original remote bytes; never overwrite different same-name assets.
      const remote=await github.rest.repos.getReleaseAsset({...context.repo,asset_id:found.id,headers:{accept:'application/octet-stream'}});
      check(hash(Buffer.from(remote.data))===hash(bytes), 'Existing published bytes differ: '+name);
    } else {
      check(release.draft, 'Refusing to repair an already published incomplete release');
      await github.rest.repos.uploadReleaseAsset({...context.repo,release_id:release.id,name,data:bytes,
        headers:{'content-type':'application/octet-stream','content-length':bytes.length}});
    }
  }
  // Recheck immediately before exposing uploaded assets and again after tag creation.
  await verifyTag({github, context, tag, allowMissing: release.draft});
  if (release.draft) await github.rest.repos.updateRelease({...context.repo,release_id:release.id,draft:false,prerelease:true,make_latest:'false'});
  await verifyTag({github, context, tag, allowMissing: false});
  return {tag, source:proof.source_sha};
}
module.exports={validate,publish};
