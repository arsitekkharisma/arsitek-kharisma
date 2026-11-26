'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
require('dotenv').config();

const { analyzeGlb } = require('./lib/glb-analysis');

const ROOT = __dirname;
const PRIVATE_ROOT = process.env.APP_DATA_DIR || path.join(ROOT, '.private-data');
const UPLOAD_TEMP = path.join(PRIVATE_ROOT, 'temporary');
const PROJECT_STORAGE = path.join(PRIVATE_ROOT, 'projects');
const DATA_FILE = path.join(PRIVATE_ROOT, 'projects.json');
const PORT = Number(process.env.PORT || 3000);
const MAX_GLB_MB = Number(process.env.MAX_GLB_MB || 200);
const MAX_GLB_BYTES = MAX_GLB_MB * 1024 * 1024;
const MAX_FLOOR_MANIFEST_BYTES = 1024 * 1024;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'studio_admin';
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

class ClientError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

for (const directory of [PRIVATE_ROOT, UPLOAD_TEMP, PROJECT_STORAGE]) {
  fs.mkdirSync(directory, { recursive: true });
}

function readState() {
  if (!fs.existsSync(DATA_FILE)) return { projects: [] };
  try {
    const state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!state || !Array.isArray(state.projects)) {
      throw new Error('projects.json tidak memiliki daftar proyek yang valid.');
    }
    return state;
  } catch (error) {
    throw new Error(`Data proyek tidak dapat dibaca: ${error.message}`);
  }
}

function saveState(state) {
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, DATA_FILE);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parsePasswordHash(encoded) {
  const match = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/u.exec(encoded || '');
  if (!match) return null;
  return { salt: match[1], hash: Buffer.from(match[2], 'hex') };
}

function verifyPassword(password) {
  const stored = parsePasswordHash(process.env.ADMIN_PASSWORD_HASH);
  if (!stored || typeof password !== 'string' || password.length > 1024) return false;
  const candidate = crypto.scryptSync(password, stored.salt, 64);
  return crypto.timingSafeEqual(candidate, stored.hash);
}

function validateConfiguration() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('PORT harus berupa angka antara 1 sampai 65535.');
  }
  if (!Number.isFinite(MAX_GLB_MB) || MAX_GLB_MB < 1 || MAX_GLB_MB > 2048) {
    throw new Error('MAX_GLB_MB harus berada di antara 1 sampai 2048.');
  }
  if (!process.env.ADMIN_USERNAME || process.env.ADMIN_USERNAME.length > 128) {
    throw new Error('ADMIN_USERNAME belum diatur. Jalankan npm run setup untuk membuat kredensial admin.');
  }
  if (!parsePasswordHash(process.env.ADMIN_PASSWORD_HASH)) {
    throw new Error('ADMIN_PASSWORD_HASH tidak valid. Jalankan npm run setup untuk membuat kredensial admin.');
  }
  if (!process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET.length < 32) {
    throw new Error('ADMIN_SESSION_SECRET belum diatur atau terlalu pendek. Jalankan npm run setup.');
  }
}

function readCookies(request) {
  const cookies = {};
  for (const piece of (request.headers.cookie || '').split(';')) {
    const separator = piece.indexOf('=');
    if (separator <= 0) continue;
    const key = piece.slice(0, separator).trim();
    try {
      cookies[key] = decodeURIComponent(piece.slice(separator + 1).trim());
    } catch {
      continue;
    }
  }
  return cookies;
}

function signSessionId(id) {
  return crypto.createHmac('sha256', process.env.ADMIN_SESSION_SECRET).update(id).digest('hex');
}

const sessions = new Map();
const loginAttempts = new Map();

function getSession(request) {
  const cookie = readCookies(request)[SESSION_COOKIE];
  if (!cookie) return null;
  const separator = cookie.indexOf('.');
  if (separator <= 0) return null;
  const token = cookie.slice(0, separator);
  const signature = cookie.slice(separator + 1);
  const expected = signSessionId(token);
  if (!/^[a-f0-9]{64}$/u.test(signature) ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, expiresAt };
}

function requireAdmin(request, response, next) {
  if (!getSession(request)) {
    response.status(401).json({ error: 'Silakan masuk sebagai admin terlebih dahulu.' });
    return;
  }
  response.set('Cache-Control', 'no-store');
  next();
}

function requireSameOrigin(request, response, next) {
  const origin = request.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== request.get('host')) {
        response.status(403).json({ error: 'Permintaan lintas situs tidak diizinkan.' });
        return;
      }
    } catch {
      response.status(403).json({ error: 'Header Origin tidak valid.' });
      return;
    }
  }
  next();
}

function loginIsLimited(key) {
  const entry = loginAttempts.get(key);
  if (!entry || entry.until <= Date.now()) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_ATTEMPTS;
}

function recordLoginFailure(key) {
  const current = loginAttempts.get(key);
  if (!current || current.until <= Date.now()) {
    loginAttempts.set(key, { count: 1, until: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  current.count += 1;
}

function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

function boundedText(value, fallback, maximum) {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maximum) || fallback;
}

function parseProjectFields(fields, existing) {
  const title = boundedText(fields.title, existing?.title || 'Proyek Arsitektur', 100);
  const description = boundedText(fields.description, existing?.description || '', 500);
  const location = boundedText(fields.location, existing?.location || '', 120);
  const yearValue = String(fields.year ?? existing?.year ?? new Date().getFullYear());
  const year = /^\d{4}$/u.test(yearValue) && Number(yearValue) >= 1800 && Number(yearValue) <= 2200
    ? Number(yearValue)
    : null;
  if (year === null) throw new ClientError('Tahun harus berupa angka empat digit yang valid.');

  const northDegrees = Number(fields.northDegrees ?? existing?.metadata?.northDegrees ?? 0);
  if (!Number.isFinite(northDegrees) || northDegrees < 0 || northDegrees >= 360) {
    throw new ClientError('Arah utara harus berupa sudut antara 0 sampai kurang dari 360 derajat.');
  }

  const floorValue = fields.floorCount === '' || fields.floorCount === undefined
    ? existing?.metadata?.floorCount
    : Number(fields.floorCount);
  if (floorValue !== undefined && (!Number.isInteger(floorValue) || floorValue < 1 || floorValue > 12)) {
    throw new ClientError('Jumlah lantai harus berada di antara 1 sampai 12.');
  }
  return { title, description, location, year, northDegrees, floorCount: floorValue };
}

function parseFloorLabels(value, floorCount) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== floorCount) {
    throw new ClientError('Nama lantai harus diisi satu per baris sesuai jumlah lantai.');
  }
  const labels = value.map(label => boundedText(label, '', 50));
  if (labels.some(label => !label)) throw new ClientError('Nama lantai tidak boleh kosong.');
  return labels;
}

function parseFloorManifest(file) {
  if (!file) return undefined;
  if (file.size > MAX_FLOOR_MANIFEST_BYTES) {
    throw new ClientError('Manifest lantai melebihi batas ukuran 1 MB.');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file.path, 'utf8'));
  } catch {
    throw new ClientError('File manifest lantai bukan JSON yang valid.');
  }
  if (
    manifest?.format !== 'studio-arsitektur-floor-manifest' ||
    manifest.version !== 1 ||
    manifest.units !== 'm' ||
    !Array.isArray(manifest.floors) ||
    manifest.floors.length < 1 ||
    manifest.floors.length > 12
  ) {
    throw new ClientError('Format manifest lantai tidak dikenali atau jumlah lantainya tidak valid.');
  }

  const northDegrees = manifest.northDegrees;
  if (typeof northDegrees !== 'number' || !Number.isFinite(northDegrees) || northDegrees < 0 || northDegrees >= 360) {
    throw new ClientError('Arah utara di manifest harus berupa sudut 0 sampai kurang dari 360 derajat.');
  }
  const floors = manifest.floors.map((floor, index) => {
    const title = boundedText(floor?.name, '', 50);
    const elevation = floor?.elevation;
    const baseElevation = floor?.baseElevation;
    const elevationRatio = floor?.elevationRatio;
    const baseElevationRatio = floor?.baseElevationRatio;
    if (
      !title ||
      typeof elevation !== 'number' ||
      !Number.isFinite(elevation) ||
      typeof baseElevation !== 'number' ||
      !Number.isFinite(baseElevation) ||
      typeof elevationRatio !== 'number' ||
      !Number.isFinite(elevationRatio) ||
      elevationRatio <= 0 ||
      elevationRatio >= 1 ||
      typeof baseElevationRatio !== 'number' ||
      !Number.isFinite(baseElevationRatio) ||
      baseElevationRatio < 0 ||
      baseElevationRatio >= 1
    ) {
      throw new ClientError(`Nama atau elevasi pada lantai manifest ke-${index + 1} tidak valid.`);
    }
    return {
      title,
      elevation,
      baseElevation,
      elevationRatio,
      baseElevationRatio,
      groupName: boundedText(floor?.groupName, title, 100)
    };
  });
  const uniqueNames = new Set(floors.map(floor => floor.title.toLocaleLowerCase('id-ID')));
  if (uniqueNames.size !== floors.length) {
    throw new ClientError('Nama setiap lantai di manifest harus unik.');
  }
  return { northDegrees, floors };
}

function publicProject(project) {
  return {
    id: project.id,
    title: project.title,
    description: project.description,
    location: project.location,
    year: project.year,
    isPublic: project.isPublic,
    createdAt: project.createdAt,
    metadata: {
      dimensions: project.metadata.dimensions,
      bounds: project.metadata.bounds,
      floorCount: project.metadata.floorCount,
      estimatedFloorCount: project.metadata.estimatedFloorCount,
      floorSource: project.metadata.floorSource,
      northDegrees: project.metadata.northDegrees,
      triangleCount: project.metadata.triangleCount
    },
    floors: project.floors.map(floor => ({
      index: floor.index,
      title: floor.title,
      elevation: floor.elevation,
      ...(Number.isFinite(floor.baseElevation) ? { baseElevation: floor.baseElevation } : {})
    })),
    previewUrl: `/api/projects/${project.id}/preview.svg`
  };
}

function adminProject(project) {
  return {
    ...publicProject(project),
    nodeNames: project.metadata.nodeNames,
    originalSize: project.originalSize,
    compressedSize: project.compressedSize,
    deliveryGzip: project.deliveryGzip,
    shareLinks: (project.shareLinks || [])
      .filter(link => Date.parse(link.expiresAt) > Date.now())
      .map(link => ({ expiresAt: link.expiresAt }))
  };
}

function projectDirectory(id) {
  return path.join(PROJECT_STORAGE, id);
}

function writeAnalysisFiles(project, analysis) {
  const directory = projectDirectory(project.id);
  const plansDirectory = path.join(directory, 'plans');
  fs.mkdirSync(plansDirectory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'preview.svg'), analysis.previewSvg);
  for (const floor of analysis.floors) {
    fs.writeFileSync(path.join(plansDirectory, floor.fileName), floor.svg);
  }
  project.floors = analysis.floors.map(({ svg, ...floor }) => floor);
  project.metadata = analysis.metadata;
}

function sendGzippedGlb(response, project) {
  const file = path.join(projectDirectory(project.id), 'model.delivery');
  if (!fs.existsSync(file)) {
    response.status(404).json({ error: 'Berkas model tidak ditemukan.' });
    return;
  }
  const headers = {
    'Content-Type': 'model/gltf-binary',
    'Content-Disposition': `inline; filename="${project.id}.glb"`,
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff'
  };
  if (project.deliveryGzip) headers['Content-Encoding'] = 'gzip';
  response.set(headers);
  fs.createReadStream(file).pipe(response);
}

function findShare(token) {
  if (!/^[a-f0-9]{64}$/u.test(token || '')) return null;
  const tokenHash = sha256(token);
  const state = readState();
  for (const project of state.projects) {
    const share = (project.shareLinks || []).find(item =>
      item.tokenHash === tokenHash && Date.parse(item.expiresAt) > Date.now()
    );
    if (share) return project;
  }
  return null;
}

const app = express();
app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'https://unpkg.com', 'blob:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_request, response) => response.sendFile(path.join(ROOT, 'index.html')));
app.get(['/index.html', '/projects.html', '/admin.html', '/share.html'], (request, response, next) => {
  const page = path.basename(request.path);
  response.sendFile(path.join(ROOT, page), error => {
    if (error) next(error);
  });
});
app.use('/assets', express.static(path.join(ROOT, 'assets'), { fallthrough: false, maxAge: '1d' }));
app.get(['/admin-client.js', '/share-client.js', '/projects-client.js'], (request, response, next) => {
  response.sendFile(path.join(ROOT, path.basename(request.path)), error => {
    if (error) next(error);
  });
});
app.get('/vendor/:name', (request, response, next) => {
  const vendorFiles = {
    'three.module.js': path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js'),
    'GLTFLoader.js': path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'loaders', 'GLTFLoader.js'),
    'OrbitControls.js': path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'controls', 'OrbitControls.js')
  };
  const file = vendorFiles[request.params.name];
  if (!file) return response.status(404).end();
  response.type('text/javascript').sendFile(file, error => {
    if (error) next(error);
  });
});
app.get('/utils/BufferGeometryUtils.js', (request, response, next) => {
  const file = path.join(ROOT, 'node_modules', 'three', 'examples', 'jsm', 'utils', 'BufferGeometryUtils.js');
  response.type('text/javascript').sendFile(file, error => {
    if (error) next(error);
  });
});
app.get('/share/:token', (request, response) => {
  if (!findShare(request.params.token)) {
    response.status(404).send('Tautan berbagi tidak ditemukan atau sudah kedaluwarsa.');
    return;
  }
  response.sendFile(path.join(ROOT, 'share.html'));
});
app.get('/project/:id', (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id && item.isPublic);
  if (!project) {
    response.status(404).send('Proyek tidak ditemukan atau belum dipublikasikan.');
    return;
  }
  response.sendFile(path.join(ROOT, 'share.html'));
});

app.get('/api/auth/me', (request, response) => {
  const session = getSession(request);
  response.json({
    authenticated: Boolean(session),
    username: session ? process.env.ADMIN_USERNAME : null
  });
});

app.post('/api/auth/login', requireSameOrigin, (request, response) => {
  const key = request.ip || request.socket.remoteAddress || 'unknown';
  if (loginIsLimited(key)) {
    response.status(429).json({ error: 'Terlalu banyak percobaan masuk. Coba lagi dalam beberapa menit.' });
    return;
  }
  const { username, password } = request.body || {};
  const usernameValid = typeof username === 'string' &&
    crypto.timingSafeEqual(
      Buffer.from(sha256(username)),
      Buffer.from(sha256(process.env.ADMIN_USERNAME || ''))
    );
  if (!usernameValid || !verifyPassword(password)) {
    recordLoginFailure(key);
    response.status(401).json({ error: 'Nama pengguna atau kata sandi salah.' });
    return;
  }
  clearLoginFailures(key);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  const sessionCookie = `${token}.${signSessionId(token)}`;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${sessionCookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
  );
  response.json({ authenticated: true, username: process.env.ADMIN_USERNAME });
});

app.post('/api/auth/logout', requireSameOrigin, requireAdmin, (request, response) => {
  const session = getSession(request);
  if (session) sessions.delete(session.token);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
  response.json({ authenticated: false });
});

app.get('/api/projects', (_request, response) => {
  const projects = readState().projects
    .filter(project => project.isPublic)
    .map(publicProject);
  response.json({ projects });
});

app.get('/api/projects/:id', (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id && item.isPublic);
  if (!project) {
    response.status(404).json({ error: 'Proyek tidak ditemukan atau belum dipublikasikan.' });
    return;
  }
  response.json({
    project: {
      ...publicProject(project),
      modelUrl: `/api/projects/${project.id}/model.glb`,
      floors: project.floors.map(floor => ({
        ...floor,
        planUrl: `/api/projects/${project.id}/plans/${floor.fileName}`
      }))
    }
  });
});

app.get('/api/projects/:id/preview.svg', (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id && item.isPublic);
  if (!project) {
    response.status(404).json({ error: 'Proyek tidak ditemukan.' });
    return;
  }
  response.type('image/svg+xml').sendFile(
    path.join(projectDirectory(project.id), 'preview.svg'),
    { dotfiles: 'allow' }
  );
});

app.get('/api/projects/:id/plans/:fileName', (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id && item.isPublic);
  if (!project || !/^denah-lantai-\d+\.svg$/u.test(request.params.fileName)) {
    response.status(404).json({ error: 'Denah tidak ditemukan.' });
    return;
  }
  response.type('image/svg+xml').sendFile(
    path.join(projectDirectory(project.id), 'plans', request.params.fileName),
    { dotfiles: 'allow' }
  );
});

app.get('/api/projects/:id/model.glb', (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id && item.isPublic);
  if (!project) {
    response.status(404).json({ error: 'Proyek tidak ditemukan.' });
    return;
  }
  sendGzippedGlb(response, project);
});

app.get('/api/admin/projects', requireAdmin, (_request, response) => {
  response.json({ projects: readState().projects.map(adminProject) });
});

const upload = multer({
  dest: UPLOAD_TEMP,
  limits: { fileSize: MAX_GLB_BYTES, files: 2, fields: 12, fieldSize: 4096 },
  fileFilter: (_request, file, callback) => {
    if (file.fieldname === 'floorManifest' && !file.originalname) {
      callback(null, false);
      return;
    }
    const allowed = file.fieldname === 'model'
      ? /\.glb$/iu.test(file.originalname)
      : file.fieldname === 'floorManifest' && /\.json$/iu.test(file.originalname);
    if (!allowed) {
      callback(new ClientError('Pilih file GLB dan manifest JSON lantai yang valid.'));
      return;
    }
    callback(null, true);
  }
});

app.post('/api/admin/projects', requireSameOrigin, requireAdmin, upload.fields([
  { name: 'model', maxCount: 1 },
  { name: 'floorManifest', maxCount: 1 }
]), (request, response, next) => {
  let projectDirectoryPath;
  try {
    const modelFile = request.files?.model?.[0];
    if (!modelFile) throw new ClientError('Pilih file GLB terlebih dahulu.');
    const manifest = parseFloorManifest(request.files?.floorManifest?.[0]);
    const fields = parseProjectFields(request.body);
    if (manifest) {
      if (fields.floorCount !== undefined && fields.floorCount !== manifest.floors.length) {
        throw new ClientError('Jumlah lantai harus sama dengan manifest SketchUp.');
      }
      fields.floorCount = manifest.floors.length;
      fields.northDegrees = manifest.northDegrees;
    }
    const buffer = fs.readFileSync(modelFile.path);
    const id = crypto.randomUUID();
    let analysis;
    try {
      analysis = analyzeGlb(buffer, {
        title: fields.title,
        floorCount: fields.floorCount,
        northDegrees: fields.northDegrees,
        floors: manifest?.floors,
        floorSource: manifest ? 'sketchup-manifest' : undefined
      });
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
    const directory = projectDirectory(id);
    projectDirectoryPath = directory;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'model.glb'), buffer, { mode: 0o600 });
    const gzipCandidate = zlib.gzipSync(buffer, { level: 9, mtime: 0 });
    const deliveryGzip = gzipCandidate.length < buffer.length;
    const delivery = deliveryGzip ? gzipCandidate : buffer;
    fs.writeFileSync(path.join(directory, 'model.delivery'), delivery, { mode: 0o600 });

    const project = {
      id,
      title: fields.title,
      description: fields.description,
      location: fields.location,
      year: fields.year,
      isPublic: request.body.isPublic === 'true',
      createdAt: new Date().toISOString(),
      originalSize: buffer.length,
      compressedSize: delivery.length,
      deliveryGzip,
      shareLinks: []
    };
    writeAnalysisFiles(project, analysis);
    const state = readState();
    state.projects.unshift(project);
    saveState(state);
    response.status(201).json({ project: adminProject(project) });
  } catch (error) {
    if (projectDirectoryPath && fs.existsSync(projectDirectoryPath)) {
      fs.rmSync(projectDirectoryPath, { recursive: true, force: true });
    }
    next(error);
  } finally {
    const uploadedFiles = Object.values(request.files || {}).flat();
    for (const file of uploadedFiles) {
      if (file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
  }
});

app.get('/api/admin/projects/:id/preview.svg', requireAdmin, (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id);
  if (!project) return response.status(404).json({ error: 'Proyek tidak ditemukan.' });
  response.type('image/svg+xml').sendFile(
    path.join(projectDirectory(project.id), 'preview.svg'),
    { dotfiles: 'allow' }
  );
});

app.get('/api/admin/projects/:id/plans/:fileName', requireAdmin, (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id);
  if (!project || !/^denah-lantai-\d+\.svg$/u.test(request.params.fileName)) {
    return response.status(404).json({ error: 'Denah tidak ditemukan.' });
  }
  response.type('image/svg+xml').sendFile(
    path.join(projectDirectory(project.id), 'plans', request.params.fileName),
    { dotfiles: 'allow' }
  );
});

app.get('/api/admin/projects/:id/model.glb', requireAdmin, (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id);
  if (!project) return response.status(404).json({ error: 'Proyek tidak ditemukan.' });
  sendGzippedGlb(response, project);
});

app.get('/api/admin/projects/:id/original.glb', requireAdmin, (request, response) => {
  const project = readState().projects.find(item => item.id === request.params.id);
  if (!project) return response.status(404).json({ error: 'Proyek tidak ditemukan.' });
  response.type('model/gltf-binary')
    .attachment(`${project.id}-asli.glb`)
    .sendFile(path.join(projectDirectory(project.id), 'model.glb'), { dotfiles: 'allow' });
});

app.patch('/api/admin/projects/:id', requireSameOrigin, requireAdmin, (request, response, next) => {
  try {
    const state = readState();
    const project = state.projects.find(item => item.id === request.params.id);
    if (!project) return response.status(404).json({ error: 'Proyek tidak ditemukan.' });

    const fields = parseProjectFields(request.body || {}, project);
    const isPublic = request.body.isPublic === undefined ? project.isPublic : request.body.isPublic === true;
    const floorLabels = parseFloorLabels(request.body.floorLabels, fields.floorCount);
    project.title = fields.title;
    project.description = fields.description;
    project.location = fields.location;
    project.year = fields.year;
    project.isPublic = isPublic;

    const original = fs.readFileSync(path.join(projectDirectory(project.id), 'model.glb'));
    let analysis;
    try {
      analysis = analyzeGlb(original, {
        title: project.title,
        floorCount: fields.floorCount,
        northDegrees: fields.northDegrees,
        floorLabels,
        floors: fields.floorCount === project.floors.length
          ? project.floors.map((floor, index) => ({
            ...floor,
            title: floorLabels?.[index] || floor.title
          }))
          : undefined,
        floorSource: fields.floorCount === project.floors.length
          ? (project.metadata.floorSource || 'estimated')
          : undefined
      });
    } catch (error) {
      error.statusCode = 400;
      throw error;
    }
    writeAnalysisFiles(project, analysis);
    saveState(state);
    response.json({ project: adminProject(project) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/projects/:id/share', requireSameOrigin, requireAdmin, (request, response) => {
  const state = readState();
  const project = state.projects.find(item => item.id === request.params.id);
  if (!project) {
    response.status(404).json({ error: 'Proyek tidak ditemukan.' });
    return;
  }
  const days = Number(request.body?.expiresDays ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    response.status(400).json({ error: 'Masa berlaku tautan harus 1 sampai 365 hari.' });
    return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  project.shareLinks = (project.shareLinks || []).filter(link => Date.parse(link.expiresAt) > Date.now());
  project.shareLinks.push({ tokenHash: sha256(token), expiresAt });
  saveState(state);
  const baseUrl = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/u, '');
  response.status(201).json({ url: `${baseUrl}/share/${token}`, expiresAt });
});

app.delete('/api/admin/projects/:id/share', requireSameOrigin, requireAdmin, (request, response) => {
  const state = readState();
  const project = state.projects.find(item => item.id === request.params.id);
  if (!project) return response.status(404).json({ error: 'Proyek tidak ditemukan.' });
  project.shareLinks = [];
  saveState(state);
  response.json({ revoked: true });
});

app.delete('/api/admin/projects/:id', requireSameOrigin, requireAdmin, (request, response) => {
  const state = readState();
  const projectIndex = state.projects.findIndex(item => item.id === request.params.id);
  if (projectIndex < 0) return response.status(404).json({ error: 'Proyek tidak ditemukan.' });
  const [project] = state.projects.splice(projectIndex, 1);
  saveState(state);
  fs.rmSync(projectDirectory(project.id), { recursive: true, force: true });
  response.json({ deleted: true });
});

app.get('/api/share/:token', (request, response) => {
  const project = findShare(request.params.token);
  if (!project) {
    response.status(404).json({ error: 'Tautan berbagi tidak ditemukan atau sudah kedaluwarsa.' });
    return;
  }
  response.set('Cache-Control', 'no-store').json({
    project: {
      ...publicProject(project),
      modelUrl: `/api/share/${request.params.token}/model.glb`,
      previewUrl: `/api/share/${request.params.token}/preview.svg`,
      floors: project.floors.map(floor => ({
        ...floor,
        planUrl: `/api/share/${request.params.token}/plans/${floor.fileName}`
      }))
    }
  });
});

app.get('/api/share/:token/preview.svg', (request, response) => {
  const project = findShare(request.params.token);
  if (!project) return response.status(404).json({ error: 'Tautan berbagi tidak ditemukan atau sudah kedaluwarsa.' });
  response.type('image/svg+xml').sendFile(
    path.join(projectDirectory(project.id), 'preview.svg'),
    { dotfiles: 'allow' }
  );
});

app.get('/api/share/:token/model.glb', (request, response) => {
  const project = findShare(request.params.token);
  if (!project) return response.status(404).json({ error: 'Tautan berbagi tidak ditemukan atau sudah kedaluwarsa.' });
  sendGzippedGlb(response, project);
});

app.get('/api/share/:token/plans/:fileName', (request, response) => {
  const project = findShare(request.params.token);
  if (!project || !/^denah-lantai-\d+\.svg$/u.test(request.params.fileName)) {
    return response.status(404).json({ error: 'Denah tidak ditemukan.' });
  }
  response.type('image/svg+xml').sendFile(
    path.join(projectDirectory(project.id), 'plans', request.params.fileName),
    { dotfiles: 'allow' }
  );
});

app.post('/api/admin/projects/:id/ai-suggest', requireSameOrigin, requireAdmin, async (request, response) => {
  if (request.body?.consent !== true) {
    response.status(400).json({ error: 'Konfirmasi pengiriman metadata kepada AI terlebih dahulu.' });
    return;
  }
  if (!process.env.AI_BASE_URL || !process.env.AI_API_KEY || !process.env.AI_MODEL) {
    response.status(503).json({ error: 'AI belum dikonfigurasi. Atur AI_BASE_URL, AI_API_KEY, dan AI_MODEL di .env.' });
    return;
  }
  const project = readState().projects.find(item => item.id === request.params.id);
  if (!project) {
    response.status(404).json({ error: 'Proyek tidak ditemukan.' });
    return;
  }

  const endpoint = `${process.env.AI_BASE_URL.replace(/\/+$/u, '')}/chat/completions`;
  const context = {
    title: project.title,
    description: project.description,
    location: project.location,
    dimensionsMeters: project.metadata.dimensions,
    floorCount: project.metadata.floorCount,
    floorSource: project.metadata.floorSource,
    floors: project.floors.map(floor => ({
      name: floor.groupName || floor.title,
      baseElevationMeters: floor.baseElevation,
      planElevationMeters: floor.elevation
    })),
    nodeNames: project.metadata.nodeNames
  };
  try {
    const result = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'Bantu menyusun metadata proyek arsitektur. Gunakan nama dan elevasi grup lantai sebagai acuan; jangan mengarang jumlah atau ketinggian lantai. Data model adalah petunjuk, bukan fakta yang boleh ditebak. Balas JSON saja dengan title, description, dan floorLabels (array string). Jangan mengubah angka ukuran.'
          },
          { role: 'user', content: JSON.stringify(context) }
        ]
      }),
      signal: AbortSignal.timeout(25000)
    });
    if (!result.ok) {
      if (result.status === 429) {
        response.status(429).json({
          error: 'Batas permintaan AI tercapai atau kuota/kredit API habis. Periksa limit dan billing penyedia AI, lalu coba lagi.'
        });
        return;
      }
      if (result.status === 503) {
        response.status(503).json({
          error: 'Penyedia AI sedang sibuk atau sementara tidak tersedia. Tunggu sebentar lalu coba lagi; jika berulang, periksa status model atau gunakan model lain.'
        });
        return;
      }
      response.status(502).json({ error: `Layanan AI mengembalikan status ${result.status}.` });
      return;
    }
    const payload = await result.json();
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('Respons AI tidak memiliki konten teks.');
    let suggestions;
    try {
      suggestions = JSON.parse(content);
    } catch {
      throw new Error('Respons AI tidak berisi JSON yang valid.');
    }
    response.json({
      suggestions: {
        title: boundedText(suggestions.title, project.title, 100),
        description: boundedText(suggestions.description, project.description, 500),
        floorLabels: Array.isArray(suggestions.floorLabels)
          ? suggestions.floorLabels.slice(0, 12).map((label, index) => boundedText(label, `Lantai ${index + 1}`, 50))
          : project.floors.map(floor => floor.title)
      },
      note: 'Saran dibuat dari metadata dan nama komponen saja. Periksa sebelum menyimpan.'
    });
  } catch (error) {
    const status = error.name === 'TimeoutError' ? 504 : 502;
    response.status(status).json({ error: `Analisis AI gagal: ${error.message}` });
  }
});

app.use((error, _request, response, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? `Ukuran GLB melebihi batas ${Math.floor(MAX_GLB_BYTES / (1024 * 1024))} MB.`
      : `Unggahan ditolak: ${error.message}`;
    response.status(400).json({ error: message });
    return;
  }
  const status = error.statusCode || 500;
  if (status >= 500) console.error(error);
  response.status(status).json({
    error: status < 500 ? error.message : 'Terjadi kesalahan internal. Periksa log server.'
  });
});

function startServer(port = PORT) {
  validateConfiguration();
  return app.listen(port, () => {
    console.log(`Studio Arsitektur berjalan di http://localhost:${port}`);
  });
}

if (require.main === module) {
  try {
    startServer();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { app, startServer };
