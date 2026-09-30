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
import Setting from './models/Setting.js';
import Message from './models/Message.js';

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
  RESEND_API_KEY,
  RESEND_FROM,
  CONTACT_TO,
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
const isEmail = (v) => {
  const e = String(v ?? '').trim();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
};
const urlOrEmpty = (u) => (u ? cleanUrl(u) || '' : '');
const HEX = /^#[0-9a-fA-F]{6}$/;
const color = (v) => (HEX.test(String(v ?? '').trim()) ? String(v).trim() : '');
const TYPES = ['image', 'video', 'youtube'];
const YOUTUBE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/;
function detectType(url) {
  if (YOUTUBE.test(url)) return 'youtube';
  if (/\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(url)) return 'video';
  return 'image';
}

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
  for (const k of ['frameColor', 'numberColor', 'buttonColor', 'hoverColor']) {
    if (k in body) out[k] = color(body[k]);
  }
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
      .map((p) => {
        const url = cleanUrl(p?.url);
        if (!url) return null;
        return { url, type: TYPES.includes(p?.type) ? p.type : detectType(url), caption: str(p?.caption, 200) };
      })
      .filter(Boolean);
    if (photos.length === 0) return res.status(400).json({ error: 'Aucune URL valide (http/https)' });
    album.photos.push(...photos.slice(0, 50));
    if (!album.cover) {
      const firstImage = album.photos.find((p) => p.type === 'image');
      if (firstImage) album.cover = firstImage.url;
    }
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
      photo.type = detectType(url);
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

/* ------------------------- Réglages du site ------------------------- */

function cleanSettings(b = {}) {
  const hero = b.hero || {};
  const about = b.about || {};
  const marquee = b.marquee || {};
  const contact = b.contact || {};
  const list = (arr, max) => (Array.isArray(arr) ? arr.map(urlOrEmpty).filter(Boolean).slice(0, max) : []);
  return {
    hero: { base: urlOrEmpty(hero.base), reveal: urlOrEmpty(hero.reveal) },
    about: {
      image: urlOrEmpty(about.image),
      heading: str(about.heading, 300),
      paragraph: str(about.paragraph, 2000),
      touring: str(about.touring, 200),
      stats: (Array.isArray(about.stats) ? about.stats : [])
        .slice(0, 8)
        .map((x) => ({
          value: str(x?.value, 12),
          label: str(x?.label, 30),
          color: ACCENTS.includes(x?.color) ? x.color : 'green',
        }))
        .filter((x) => x.value || x.label),
    },
    marquee: { label: str(marquee.label, 60), topRow: list(marquee.topRow, 40), bottomRow: list(marquee.bottomRow, 40) },
    contact: {
      instagram: urlOrEmpty(contact.instagram),
      email: isEmail(contact.email) ? str(contact.email, 120) : '',
      intro: str(contact.intro, 500),
    },
  };
}

app.get(
  '/api/settings',
  wrap(async (_req, res) => {
    const doc = await Setting.findOne({ key: 'site' });
    res.json(doc?.data ?? {});
  }),
);

app.put(
  '/api/settings',
  requireAuth,
  wrap(async (req, res) => {
    const data = cleanSettings(req.body || {});
    await Setting.findOneAndUpdate({ key: 'site' }, { data }, { upsert: true, new: true });
    res.json(data);
  }),
);

/* ------------------------------ Contact ------------------------------ */

async function notifyByEmail({ name, email, message }) {
  if (!RESEND_API_KEY || !CONTACT_TO) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM || 'swagtrickryan <onboarding@resend.dev>',
        to: [CONTACT_TO],
        reply_to: email,
        subject: `Nouveau message de ${name}`,
        text: `${name} <${email}>\n\n${message}`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.error('Resend', r.status, await r.text());
  } catch (e) {
    console.error('Resend', e.message);
  }
}

app.post(
  '/api/contact',
  rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many messages, please try again later.' },
  }),
  wrap(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.json({ ok: true }); // champ piège pour les robots
    const name = str(b.name, 80);
    const email = str(b.email, 120);
    const message = str(b.message, 3000);
    if (!name || !isEmail(email) || message.length < 5) {
      return res.status(400).json({ error: 'Please fill in your name, a valid email and a message.' });
    }
    await Message.create({ name, email, message });
    notifyByEmail({ name, email, message }); // sans attendre : le message est déjà enregistré
    res.status(201).json({ ok: true });
  }),
);

app.get(
  '/api/messages',
  requireAuth,
  wrap(async (_req, res) => {
    res.json(await Message.find().sort({ createdAt: -1 }).limit(200));
  }),
);

app.put(
  '/api/messages/:id',
  requireAuth,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Message introuvable' });
    const msg = await Message.findByIdAndUpdate(req.params.id, { read: !!req.body?.read }, { new: true });
    if (!msg) return res.status(404).json({ error: 'Message introuvable' });
    res.json(msg);
  }),
);

app.delete(
  '/api/messages/:id',
  requireAuth,
  wrap(async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Message introuvable' });
    await Message.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
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

const EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const MAX_IMAGE = 20 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
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
    if (!req.file) {
      return res.status(400).json({ error: 'Fichier invalide (images jpg/png/webp/gif/avif, vidéos mp4/webm/mov — 100 Mo max)' });
    }
    const isVideo = req.file.mimetype.startsWith('video/');
    if (!isVideo && req.file.size > MAX_IMAGE) {
      return res.status(400).json({ error: 'Image trop lourde (20 Mo max)' });
    }
    const key = `albums/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${EXT[req.file.mimetype]}`;
    await s3.send(
      new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: req.file.buffer, ContentType: req.file.mimetype }),
    );
    res.json({ url: `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`, type: isVideo ? 'video' : 'image' });
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
