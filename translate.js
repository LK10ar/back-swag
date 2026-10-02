// Traduction automatique : DeepL (si DEEPL_API_KEY) → Google (gratuit, sans clé) → MyMemory.
// Les marques de couleur *vert*  ~rose~  ^orange^  [blue:bleu] et les retours à la ligne sont conservés.
// Chaque moteur qui échoue est noté dans opts.stats.errors pour que l'admin sache POURQUOI.

const MARKS = /(\*[^*\n]+\*|~[^~\n]+~|\^[^^\n]+\^|\[blue:[^\]\n]+\])/;

const DEEPL_TARGET = { fr: 'FR', en: 'EN-GB', es: 'ES', de: 'DE', it: 'IT', pt: 'PT-PT', nl: 'NL' };

const decodeEntities = (t) =>
  t
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export function splitChunks(text, max) {
  const parts = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + ' ' + p).trim().length > max && cur) {
      chunks.push(cur);
      cur = p;
    } else cur = (cur + ' ' + p).trim();
  }
  if (cur) chunks.push(cur);
  return chunks.flatMap((c) => (c.length > max ? c.match(new RegExp(`.{1,${max}}`, 'g')) : [c]));
}

async function deepl(text, from, to, f, key) {
  const host = key.endsWith(':fx') ? 'api-free.deepl.com' : 'api.deepl.com';
  const body = new URLSearchParams({ text, target_lang: DEEPL_TARGET[to] || to.toUpperCase() });
  if (from !== 'auto') body.set('source_lang', from.toUpperCase());
  const r = await f(`https://${host}/v2/translate`, {
    method: 'POST',
    headers: { Authorization: `DeepL-Auth-Key ${key}` },
    body,
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const out = j?.translations?.[0]?.text;
  if (!out) throw new Error('réponse inattendue');
  return out;
}

async function google(text, from, to, f) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await f(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j?.[0])) throw new Error('réponse inattendue');
  return j[0].map((seg) => seg?.[0] ?? '').join('');
}

async function myMemory(text, from, to, f, email) {
  const pair = `${from === 'auto' ? 'Autodetect' : from}|${to}`;
  const out = [];
  for (const piece of splitChunks(text, 450)) {
    const url =
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(piece)}&langpair=${pair}` +
      (email ? `&de=${encodeURIComponent(email)}` : '');
    const r = await f(url, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    const t = j?.responseData?.translatedText ?? '';
    if (j.responseStatus !== 200 || /^MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(t)) {
      throw new Error(String(j.responseDetails || t || `HTTP ${r.status}`).slice(0, 120));
    }
    out.push(decodeEntities(t));
  }
  return out.join(' ');
}

/** Traduit un morceau de texte brut (sans marques) */
async function translatePlain(text, from, to, opts) {
  const f = opts.fetchImpl ?? fetch;
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const core = text.trim();
  // rien à traduire : ponctuation, chiffres, symboles…
  if (!core || !/\p{L}/u.test(core)) return text;

  const engines = [];
  if (opts.deeplKey) engines.push(['deepl', (t) => deepl(t, from, to, f, opts.deeplKey)]);
  engines.push(['google', (t) => google(t, from, to, f)]);
  engines.push(['mymemory', (t) => myMemory(t, from, to, f, opts.email)]);

  const out = [];
  for (const chunk of splitChunks(core, 1200)) {
    let res;
    const errs = [];
    for (const [name, run] of engines) {
      try {
        const piece = await run(chunk);
        if (piece && piece.trim()) {
          res = piece.trim();
          if (opts.stats) opts.stats[name] = (opts.stats[name] || 0) + 1;
          break;
        }
        errs.push(`${name}: réponse vide`);
      } catch (e) {
        errs.push(`${name}: ${e.message}`);
      }
    }
    if (opts.stats) for (const e of errs) if (!opts.stats.errors.includes(e)) opts.stats.errors.push(e);
    if (res === undefined) throw new Error(`Traduction impossible (${errs.join(' · ')})`);
    out.push(res);
  }
  return lead + out.join(' ') + trail;
}

/** Traduit un texte du site en gardant les couleurs et les lignes */
export async function translateText(text, from, to, opts = {}) {
  if (opts.stats && !opts.stats.errors) opts.stats.errors = [];
  const lines = String(text).split('\n');
  const done = [];
  for (const line of lines) {
    const parts = line.split(MARKS);
    const res = [];
    for (const part of parts) {
      const m = part.match(/^(\*|~|\^)([^]*)\1$/);
      if (m) res.push(m[1] + (await translatePlain(m[2], from, to, opts)) + m[1]);
      else if (/^\[blue:[^\]]+\]$/.test(part)) res.push('[blue:' + (await translatePlain(part.slice(6, -1), from, to, opts)) + ']');
      else res.push(await translatePlain(part, from, to, opts));
    }
    done.push(res.join(''));
  }
  return done.join('\n');
}
