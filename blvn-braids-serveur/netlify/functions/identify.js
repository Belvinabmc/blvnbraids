/* Reconnaissance d’une photo d’inspiration : l’IA choisit le modèle le plus proche DANS la grille du site.
   Elle ne peut jamais inventer un prix : si rien ne correspond, la cliente envoie sa photo à la coiffeuse.
   Deux fournisseurs possibles, au choix (variables Netlify) :
   - GRATUIT : Cloudflare Workers AI → CF_ACCOUNT_ID + CF_API_TOKEN (quota gratuit quotidien, modèle Mistral)
   - payant à l’usage : Claude → ANTHROPIC_API_KEY
   Sans aucune des deux : { unavailable: true } et le site propose d’envoyer la photo à la coiffeuse. */
const L = require('./_lib');
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
const CF_MODEL = process.env.CF_AI_MODEL || '@cf/mistralai/mistral-small-3.1-24b-instruct';
const useCF = () => !!(process.env.CF_ACCOUNT_ID && process.env.CF_API_TOKEN);

/* Chaque fournisseur renvoie le texte de la réponse, ou lève une erreur */
async function askCloudflare(dataUrl, prompt) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/v1/chat/completions`, {
    method: 'POST', headers: { authorization: 'Bearer ' + process.env.CF_API_TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ model: CF_MODEL, max_tokens: 400, temperature: 0.1, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Cloudflare AI', r.status, JSON.stringify(j).slice(0, 500)); throw new Error('cf ' + r.status); }
  const c = (((j.choices || [])[0] || {}).message || {}).content;
  return Array.isArray(c) ? c.map(x => x.text || '').join('') : String(c || '');
}
async function askClaude(mime, data, prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data } }, { type: 'text', text: prompt }] }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Anthropic', r.status, JSON.stringify(j).slice(0, 500)); throw new Error('anthropic ' + r.status); }
  return (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
}
exports.handler = async ev => {
  if (ev.httpMethod !== 'POST') return L.bad('Méthode non autorisée', 405);
  if (await L.tooMany('identify:' + L.clientIp(ev), 12, 10)) return L.bad('Trop d’envois en peu de temps. Réessayez dans quelques minutes.', 429);
  if (!useCF() && !process.env.ANTHROPIC_API_KEY) return L.json(200, { unavailable: true });
  let b; try { b = JSON.parse(ev.body || '{}'); } catch { return L.bad('Requête illisible'); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.image || '');
  if (!m) return L.bad('Image invalide');
  if (m[2].length > 3000000) return L.bad('Image trop lourde');
  try {
    const cat = await L.catalog();
    const rows = [];
    for (const s of cat.services) {
      const c = cat.categories.find(x => x.id === s.cat);
      if (!s.visible || (c && !c.active)) continue;
      for (const v of s.variants) if (!v.hidden && v.p != null) rows.push({ id: `${s.id}:${v.id}`, s, v, line: `${s.id}:${v.id} | ${s.name}${v.g ? ' – ' + v.g : ''} – ${v.l}` });
    }
    if (!rows.length) return L.json(200, { match: null, why: 'Grille vide' });
    const prompt = `Tu aides une coiffeuse (tresses, locks, ponytails, coiffures afro et autres prestations beauté). Voici sa liste de prestations, une par ligne : identifiant | prestation.\n${rows.map(r => r.line).join('\n')}\n\nRegarde la photo jointe. Choisis dans cette liste la prestation la plus proche de ce qui est visible. N’invente rien : si aucune ligne ne correspond raisonnablement, ou si la photo ne montre pas une coiffure ou une prestation de la liste, mets "id" à null.\nRéponds uniquement en JSON, sans texte autour : {"id": "<identifiant exact ou null>", "confiance": "haute" | "moyenne" | "faible", "nom_du_style": "nom courant du style visible, en français", "pourquoi": "une phrase courte en français pour la cliente"}`;
    let raw; try { raw = useCF() ? await askCloudflare(b.image, prompt) : await askClaude(m[1], m[2], prompt); }
    catch (e) { return L.bad('L’analyse automatique est momentanément indisponible.', 502); }
    const txt = raw.replace(/```json|```/g, '').trim();
    let out; try { out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch { out = {}; }
    const hit = rows.find(x => x.id === out.id);
    const sugg = { id: out.id || null, conf: out.confiance || null, style: out.nom_du_style || null, why: out.pourquoi || null, label: hit ? `${hit.s.name} · ${hit.v.l}` : null };
    if (!hit) return L.json(200, { match: null, style: sugg.style, why: sugg.why, sugg });
    return L.json(200, { match: { serviceId: hit.s.id, variantId: hit.v.id, conf: out.confiance || 'moyenne', why: out.pourquoi || '', style: out.nom_du_style || '' }, sugg });
  } catch (e) { console.error(e); return L.bad('Analyse indisponible pour le moment', 500); }
};
