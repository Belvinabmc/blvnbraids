/* Vérifie un code promo pendant la réservation (le serveur revérifie au moment de payer) */
const L = require('./_lib');
exports.handler = async ev => {
  if (ev.httpMethod !== 'POST') return L.bad('Méthode non autorisée', 405);
  let b; try { b = JSON.parse(ev.body || '{}'); } catch { return L.bad('Requête illisible'); }
  try {
    const base = b.variantId ? await L.basePriceOf(b.variantId) : null;
    const r = await L.checkPromo({ code: b.code, email: b.email, phone: b.phone, basePrice: base });
    if (!r.ok) return L.json(200, { ok: false, error: r.error });
    return L.json(200, { ok: true, code: r.code, amount: r.amount, label: L.promoLabel(r) });
  } catch (e) { console.error(e); return L.bad('Vérification impossible pour le moment', 500); }
};
