import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import Album from './models/Album.js';

const {
  PORT = 5000,
  MONGODB_URI,
  ADMIN_PASSWORD,
  JWT_SECRET,
  CORS_ORIGINS = '',
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_URL,
} = process.env;

for (const [k, v] of Object.entries({ MONGODB_URI, ADMIN_PASSWORD, JWT_SECRET })) {
  if (!v) {
    console.error(`Variable d'environnement manquante : ${k}`);
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', 1); // Render est derrière un proxy
app.use(express.json({ limit: '1mb' }));

const allowed = CORS_ORIGINS.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || allowed.length === 0 || allowed.includes(origin)),
  }),
);

/* ------------------------------ Helpers ------------------------------ */

const ACCENTS = ['green', 'orange', 'pink', 'blue'];
const str = (v, max) => String(v ?? '').trim().slice(0, max);

function cleanUrl(u) {
  try {
    const x = new URL(String(u).trim());
    return ['http:', 'https:'].includes(x.protocol) ? String(u).trim() : null;
  } catch {
    return null;
  }
}

function albumFields(body, { partial }) {
  const out = {};
  if ('title' in body || !partial) out.title = str(body.title, 120);
  if ('year' in body) out.year = str(body.year, 10);
  if ('location' in body) out.location = str(body.location, 80);
  if ('accent' in body && ACCENTS.includes(body.accent)) out.accent = body.accent;
  if ('cover' in body) out.cover = body.cover ? cleanUrl(body.cover) || '' : '';
  if ('order' in body && Number.isFinite(Number(body.order))) out.order = Number(body.order);
  return out;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée, reconnecte-toi.' });
  }
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

async function findAlbum(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'Album introuvable' });
    return null;
  }
  const album = await Album.findById(req.params.id);
  if (!album) res.status(404).json({ error: 'Album introuvable' });
  return album;
}

/* ------------------------------- Routes ------------------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post(
  '/api/login',
  rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false }),
  (req, res) => {
    const ok = crypto.timingSafeEqual(sha(req.body?.password), sha(ADMIN_PASSWORD));
    if (!ok) return res.status(401).json({ error: 'Mot de passe incorrect' });
    res.json({ token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '12h' }) });
  },
);

// Public
app.get(
  '/api/albums',
  wrap(async (_req, res) => {
    res.json(await Album.find().sort({ order: 1, createdAt: -1 }));
  }),
);

// Albums (admin)
app.post(
  '/api/albums',
  requireAuth,
  wrap(async (req, res) => {
    const data = albumFields(req.body || {}, { partial: false });
    if (!data.title) return res.status(400).json({ error: 'Le titre est obligatoire' });
    res.status(201).json(await Album.create(data));
  }),
);

app.put(
  '/api/albums/:id',
  requireAuth,
  wrap(async (req, res) => {
    const album = await findAlbum(req, res);
    if (!album) return;
    const data = albumFields(req.body || {}, { partial: true });
    if ('title' in data && !data.title) return res.status(400).json({ error: 'Le titre est obligatoire' });
    album.set(data);
    res.json(await album.save());
  }),
);

app.delete(
  '/api/albums/:id',
  requireAuth,
  wrap(async (req, res) => {
    const album = await findAlbum(req, res);
    if (!album) return;
    await album.deleteOne();
    res.json({ ok: true });
  }),
);

// Photos (admin)
app.post(
  '/api/albums/:id/photos',
  requireAuth,
  wrap(async (req, res) => {
    const album = await findAlbum(req, res);
    if (!album) return;
    const list = Array.isArray(req.body?.photos) ? req.body.photos : [];
    const photos = list
      .map((p) => ({ url: cleanUrl(p?.url), caption: str(p?.caption, 200) }))
      .filter((p) => p.url);
    if (photos.length === 0) return res.status(400).json({ error: 'Aucune URL valide (http/https)' });
    album.photos.push(...photos.slice(0, 50));
    if (!album.cover) album.cover = album.photos[0].url;
    res.json(await album.save());
  }),
);

app.put(
  '/api/albums/:id/reorder',
  requireAuth,
  wrap(async (req, res) => {
    const album = await findAlbum(req, res);
    if (!album) return;
    const ids = Array.isArray(req.body?.photoIds) ? req.body.photoIds.map(String) : [];
    const byId = new Map(album.photos.map((p) => [String(p._id), p.toObject()]));
    const ordered = ids.filter((id) => byId.has(id)).map((id) => byId.get(id));
    const rest = album.photos.filter((p) => !ids.includes(String(p._id))).map((p) => p.toObject());
    album.photos = [...ordered, ...rest];
    res.json(await album.save());
  }),
);

app.put(
  '/api/albums/:id/photos/:photoId',
  requireAuth,
  wrap(async (req, res) => {
    const album = await findAlbum(req, res);
    if (!album) return;
    const photo = album.photos.id(req.params.photoId);
    if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
    if ('url' in req.body) {
      const url = cleanUrl(req.body.url);
      if (!url) return res.status(400).json({ error: 'URL invalide' });
      if (album.cover === photo.url) album.cover = url;
      photo.url = url;
    }
    if ('caption' in req.body) photo.caption = str(req.body.caption, 200);
    res.json(await album.save());
  }),
);

app.delete(
  '/api/albums/:id/photos/:photoId',
  requireAuth,
  wrap(async (req, res) => {
    const album = await findAlbum(req, res);
    if (!album) return;
    const photo = album.photos.id(req.params.photoId);
    if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
    if (album.cover === photo.url) album.cover = '';
    album.photos.pull(req.params.photoId);
    res.json(await album.save());
  }),
);

/* ---------------------- Upload vers Cloudflare R2 ---------------------- */

const r2Ready = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL;
const s3 = r2Ready
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    })
  : null;

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, file.mimetype in EXT),
});

app.post(
  '/api/upload',
  requireAuth,
  upload.single('file'),
  wrap(async (req, res) => {
    if (!s3) {
      return res.status(501).json({ error: "Upload R2 non configuré : ajoute les photos par URL, ou renseigne les variables R2_*." });
    }
    if (!req.file) return res.status(400).json({ error: 'Fichier image invalide (jpg, png, webp, gif, avif — 20 Mo max)' });
    const key = `albums/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[req.file.mimetype]}`;
    await s3.send(
      new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }),
    );
    res.json({ url: `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}` });
  }),
);

/* ------------------------------- Erreurs ------------------------------- */

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err instanceof multer.MulterError ? 400 : 500).json({ error: err.message || 'Erreur serveur' });
});

mongoose
  .connect(MONGODB_URI)
  .then(() => app.listen(PORT, () => console.log(`API prête sur le port ${PORT}`)))
  .catch((e) => {
    console.error('Connexion MongoDB impossible :', e.message);
    process.exit(1);
  });
