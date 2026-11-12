/* Page de confirmation après paiement : on relit la réservation à partir de la session Stripe (jamais depuis le navigateur seul). */
const L = require('./_lib');
exports.handler = async ev => {
  const sid = (ev.queryStringParameters || {}).session || '';
  if (!/^cs_/.test(sid)) return L.bad('Session invalide');
  try {
    let b = (await L.q('SELECT * FROM bookings WHERE checkout_ref=$1', [sid])).rows[0];
    if (!b) return L.bad('Réservation introuvable', 404);
    if (b.status === 'held') { // le webhook n’est peut-être pas encore passé : on vérifie directement auprès de Stripe
      const sess = await L.stripe('/checkout/sessions/' + sid, null, 'GET');
      if (sess.payment_status === 'paid') {
        const r = await L.q("UPDATE bookings SET status='confirmed', confirmed_at=now(), hold_expires_at=NULL WHERE id=$1 AND status='held' RETURNING *", [b.id]);
        if (r.rows[0]) { b = r.rows[0]; await L.q("INSERT INTO payments (booking_id, provider, provider_ref, amount_cents, status, verified_at) VALUES ($1,'card',$2,$3,'succeeded',now()) ON CONFLICT (provider, provider_ref) DO NOTHING", [b.id, String(sess.payment_intent || sid), sess.amount_total || b.deposit_cents]);
          for (const lead of [1440, 120]) await L.q("INSERT INTO reminders (booking_id, channel, lead_minutes, send_at) VALUES ($1,'email',$2, $3::timestamptz - make_interval(mins => $2::int)) ON CONFLICT DO NOTHING", [b.id, lead, b.starts_at]);
          await L.mailBookingConfirmed(b);
      await L.promoUsed(b).catch(() => {});
      if (/^q:/.test(b.idempotency_key || '')) await L.q("UPDATE requests SET status='quote_accepted', updated_at=now() WHERE id=$1", [b.idempotency_key.slice(2)]).catch(() => {}); }
      }
    }
    const sn = b.snapshot || {};
    return L.json(200, { status: b.status, label: sn.label, when: L.fmtWhen(new Date(b.starts_at)), deposit: b.deposit_cents, total: b.total_cents, balance: b.balance_cents, email: b.contact_email, duration: b.duration_min });
  } catch (e) { console.error(e); return L.bad('Vérification impossible', 500); }
};
