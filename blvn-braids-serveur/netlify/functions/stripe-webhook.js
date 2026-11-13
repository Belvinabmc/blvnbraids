/* Stripe nous prévient du paiement : c’est ici (et seulement ici) qu’un rendez-vous devient confirmé. */
const L = require('./_lib');
exports.handler = async ev => {
  if (ev.httpMethod !== 'POST') return L.bad('Méthode non autorisée', 405);
  let event; try { event = L.verifyStripeSignature(ev.isBase64Encoded ? Buffer.from(ev.body, 'base64').toString('utf8') : ev.body, ev.headers['stripe-signature']); } catch (e) { return L.bad(e.message); }
  try {
    const dup = await L.q('INSERT INTO payment_events (provider, event_id, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id', ['card', event.id, JSON.stringify({ type: event.type })]).catch(() => ({ rows: [1] }));
    if (!dup.rows.length) return L.json(200, { ok: true, duplicate: true });
    const o = event.data && event.data.object || {};
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      if (o.payment_status !== 'paid') return L.json(200, { ok: true, pending: true });
      const id = (o.metadata && o.metadata.booking_id) || o.client_reference_id;
      const b = await L.confirmBooking(id, o);
      if (!b) return L.json(200, { ok: true, unknown: true });
    } else if (event.type === 'checkout.session.expired') {
      const id = (o.metadata && o.metadata.booking_id) || o.client_reference_id;
      await L.abandonBooking(id);   // créneau libéré, cliente et gérante prévenues
    }
    return L.json(200, { ok: true });
  } catch (e) { console.error(e); return L.bad('Erreur de traitement', 500); }
};
