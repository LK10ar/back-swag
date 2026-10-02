// Traduction automatique : Google (gratuit, sans clé) en premier, MyMemory en secours.
// Les marques de couleur *vert*  ~rose~  ^orange^  [blue:bleu] et les retours à la ligne sont conservés.

const MARKS = /(\*[^*\n]+\*|~[^~\n]+~|\^[^^\n]+\^|\[blue:[^\]\n]+\])/;

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

async function google(text, from, to, f) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  const r = await f(url, { signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`Google ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j?.[0])) throw new Error('Réponse Google inattendue');
  return j[0].map((seg) => seg?.[0] ?? '').join('');
}

async function myMemory(text, from, to, f, email) {
  const pair = `${from === 'auto' ? 'Autodetect' : from}|${to}`;
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${pair}` +
    (email ? `&de=${encodeURIComponent(email)}` : '');
  const r = await f(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (j.responseStatus !== 200) throw new Error(j.responseDetails || 'MyMemory indisponible');
  return decodeEntities(j.responseData.translatedText);
}

/** Traduit un morceau de texte brut (sans marques) */
async function translatePlain(text, from, to, opts) {
  const f = opts.fetchImpl ?? fetch;
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const core = text.trim();
  // rien à traduire : ponctuation, chiffres, symboles…
  if (!core || !/\p{L}/u.test(core)) return text;
  const out = [];
  for (const chunk of splitChunks(core, 1200)) {
    let res;
    try {
      res = await google(chunk, from, to, f);
    } catch {
      res = await myMemory(chunk.slice(0, 480), from, to, f, opts.email);
    }
    out.push(res.trim());
  }
  return lead + out.join(' ') + trail;
}

/** Traduit un texte du site en gardant les couleurs et les lignes */
export async function translateText(text, from, to, opts = {}) {
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
