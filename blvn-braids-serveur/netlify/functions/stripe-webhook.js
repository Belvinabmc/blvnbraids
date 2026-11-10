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
      const r = await L.q("UPDATE bookings SET status='confirmed', confirmed_at=now(), hold_expires_at=NULL WHERE id=$1 AND status IN ('held','expired') RETURNING *", [id]);
      const b = r.rows[0] || (await L.q('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
      if (!b) return L.json(200, { ok: true, unknown: true });
      await L.q("INSERT INTO payments (booking_id, provider, provider_ref, amount_cents, status, verified_at) VALUES ($1,'card',$2,$3,'succeeded',now()) ON CONFLICT (provider, provider_ref) DO NOTHING", [b.id, String(o.payment_intent || o.id), o.amount_total || b.deposit_cents]);
      for (const lead of [1440, 120]) await L.q("INSERT INTO reminders (booking_id, channel, lead_minutes, send_at) VALUES ($1,'email',$2, $3::timestamptz - make_interval(mins => $2::int)) ON CONFLICT DO NOTHING", [b.id, lead, b.starts_at]);
      if (r.rows[0]) await L.mailBookingConfirmed(b);
      if (/^q:/.test(b.idempotency_key || '')) await L.q("UPDATE requests SET status='quote_accepted', updated_at=now() WHERE id=$1", [b.idempotency_key.slice(2)]).catch(() => {});
    } else if (event.type === 'checkout.session.expired') {
      const id = (o.metadata && o.metadata.booking_id) || o.client_reference_id;
      await L.q("UPDATE bookings SET status='expired' WHERE id=$1 AND status='held'", [id]);
    }
    return L.json(200, { ok: true });
  } catch (e) { console.error(e); return L.bad('Erreur de traitement', 500); }
};
