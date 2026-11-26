'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createTestGlb } = require('./test-model');

const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), '.studio-arsitektur-test-'));
const password = 'correct horse battery staple';
const salt = crypto.randomBytes(16).toString('hex');
process.env.APP_DATA_DIR = dataDirectory;
process.env.ADMIN_USERNAME = 'admin-test';
process.env.ADMIN_PASSWORD_HASH = `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
process.env.ADMIN_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
process.env.MAX_GLB_MB = '10';
process.env.NODE_ENV = 'test';

const { app } = require('../server');

test('admin import, gzip preservation, public project and expiring share flow', async t => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sharePage = await fetch(`${origin}/share.html`);
  assert.match(sharePage.headers.get('content-security-policy'), /connect-src[^;]*blob:/u);

  const loader = await fetch(`${origin}/vendor/GLTFLoader.js`);
  assert.equal(loader.status, 200);
  assert.match(await loader.text(), /BufferGeometryUtils\.js/u);
  const geometryUtils = await fetch(`${origin}/utils/BufferGeometryUtils.js`);
  assert.equal(geometryUtils.status, 200);

  const denied = await fetch(`${origin}/api/admin/projects`);
  assert.equal(denied.status, 401);

  const login = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin-test', password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const upload = new FormData();
  upload.set('title', 'Rumah Uji');
  upload.set('location', 'Bandung');
  upload.set('year', '2026');
  upload.set('floorCount', '2');
  upload.set('northDegrees', '0');
  upload.set('isPublic', 'true');
  upload.set('floorManifest', new Blob([JSON.stringify({
    format: 'studio-arsitektur-floor-manifest',
    version: 1,
    units: 'm',
    northDegrees: 45,
    floors: [
      { name: 'Lantai Dasar', groupName: 'Lantai Dasar', baseElevation: 102, elevation: 103.2, baseElevationRatio: 0, elevationRatio: 0.4 },
      { name: 'Lantai 1', groupName: 'Lantai 1', baseElevation: 103.5, elevation: 104.6, baseElevationRatio: 0.5, elevationRatio: 0.8666667 }
    ]
  })], { type: 'application/json' }), 'rumah-uji.floor-manifest.json');
  upload.set('model', new Blob([createTestGlb()], { type: 'model/gltf-binary' }), 'rumah-uji.glb');
  const imported = await fetch(`${origin}/api/admin/projects`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: upload
  });
  assert.equal(imported.status, 201);
  const project = (await imported.json()).project;
  assert.equal(project.metadata.floorCount, 2);
  assert.equal(project.metadata.floorSource, 'sketchup-manifest');
  assert.equal(project.metadata.northDegrees, 45);
  assert.equal(project.floors[0].title, 'Lantai Dasar');
  assert.equal(project.floors[0].elevation, 3.2);
  assert.equal(project.floors[0].baseElevation, 2);
  assert.equal(project.metadata.dimensions.width, 4);
  assert.equal(fs.existsSync(path.join(dataDirectory, 'projects', project.id, 'preview.svg')), true);

  const estimatedUpload = new FormData();
  estimatedUpload.set('title', 'Proyek Tanpa Manifest');
  estimatedUpload.set('year', '2026');
  estimatedUpload.set('northDegrees', '0');
  estimatedUpload.set('floorManifest', new Blob([]), '');
  estimatedUpload.set('model', new Blob([createTestGlb()], { type: 'model/gltf-binary' }), 'tanpa-manifest.glb');
  const estimatedImport = await fetch(`${origin}/api/admin/projects`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: estimatedUpload
  });
  assert.equal(estimatedImport.status, 201);
  assert.equal((await estimatedImport.json()).project.metadata.floorSource, 'estimated');

  const adminPreview = await fetch(`${origin}/api/admin/projects/${project.id}/preview.svg`, {
    headers: { Cookie: cookie }
  });
  const adminPreviewSvg = await adminPreview.text();
  assert.equal(adminPreview.status, 200, adminPreviewSvg);
  assert.match(adminPreviewSvg, /<svg/u);

  const adminPlan = await fetch(`${origin}/api/admin/projects/${project.id}/plans/denah-lantai-1.svg`, {
    headers: { Cookie: cookie }
  });
  assert.equal(adminPlan.status, 200);
  const updated = await fetch(`${origin}/api/admin/projects/${project.id}`, {
    method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      floorCount: 2,
      northDegrees: 45,
      floorLabels: ['Lantai Dasar', 'Lantai 1'],
      isPublic: true
    })
  });
  assert.equal(updated.status, 200);
  const updatedProject = (await updated.json()).project;
  assert.equal(updatedProject.metadata.floorSource, 'sketchup-manifest');
  assert.equal(updatedProject.floors[0].elevation, 3.2);

  const original = await fetch(`${origin}/api/admin/projects/${project.id}/original.glb`, {
    headers: { Cookie: cookie }
  });
  assert.equal(original.status, 200);
  const originalBytes = Buffer.from(await original.arrayBuffer());
  const optimized = await fetch(`${origin}/api/projects/${project.id}/model.glb`);
  assert.equal(optimized.headers.get('content-encoding'), 'gzip');
  assert.deepEqual(Buffer.from(await optimized.arrayBuffer()), originalBytes);

  const publicView = await fetch(`${origin}/api/projects/${project.id}`);
  assert.equal(publicView.status, 200);
  const publicData = (await publicView.json()).project;
  assert.equal(publicData.floors.length, 2);
  assert.ok(publicData.metadata.bounds);
  const preview = await fetch(`${origin}${publicData.previewUrl}`);
  assert.equal(preview.status, 200);
  const plan = await fetch(`${origin}${publicData.floors[0].planUrl}`);
  assert.equal(plan.status, 200);
  assert.match(await plan.text(), /Arah mata angin: Utara/u);

  const shareResponse = await fetch(`${origin}/api/admin/projects/${project.id}/share`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresDays: 3 })
  });
  assert.equal(shareResponse.status, 201);
  const share = await shareResponse.json();
  const token = new URL(share.url).pathname.split('/').pop();
  const sharedProject = await fetch(`${origin}/api/share/${token}`);
  assert.equal(sharedProject.status, 200);
  const shareData = (await sharedProject.json()).project;
  assert.equal(shareData.title, 'Rumah Uji');
  assert.equal((await fetch(`${origin}${shareData.previewUrl}`)).status, 200);
  assert.equal((await fetch(`${origin}${shareData.floors[0].planUrl}`)).status, 200);

  const consentRequired = await fetch(`${origin}/api/admin/projects/${project.id}/ai-suggest`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent: false })
  });
  assert.equal(consentRequired.status, 400);

  process.env.AI_BASE_URL = 'https://provider.test/v1';
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'test-model';
  const originalFetch = globalThis.fetch;
  let upstreamStatus = 429;
  let upstreamBody;
  globalThis.fetch = async (input, options) => {
    if (String(input) === 'https://provider.test/v1/chat/completions') {
      upstreamBody = JSON.parse(options.body);
      return new Response(JSON.stringify({ error: { type: 'provider_unavailable' } }), {
        status: upstreamStatus,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return originalFetch(input, options);
  };
  try {
    const rateLimited = await originalFetch(`${origin}/api/admin/projects/${project.id}/ai-suggest`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true })
    });
    assert.equal(rateLimited.status, 429);
    assert.match((await rateLimited.json()).error, /kuota\/kredit API/u);
    const aiContext = JSON.parse(upstreamBody.messages[1].content);
    assert.equal(aiContext.floorSource, 'sketchup-manifest');
    assert.equal(aiContext.floors[0].name, 'Lantai Dasar');
    assert.equal(aiContext.floors[0].planElevationMeters, 3.2);

    upstreamStatus = 503;
    const unavailable = await originalFetch(`${origin}/api/admin/projects/${project.id}/ai-suggest`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true })
    });
    assert.equal(unavailable.status, 503);
    assert.match((await unavailable.json()).error, /sementara tidak tersedia/u);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const revoke = await fetch(`${origin}/api/admin/projects/${project.id}/share`, {
    method: 'DELETE',
    headers: { Cookie: cookie }
  });
  assert.equal(revoke.status, 200);
  const expiredShare = await fetch(`${origin}/api/share/${token}`);
  assert.equal(expiredShare.status, 404);
});

