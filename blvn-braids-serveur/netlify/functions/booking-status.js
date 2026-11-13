/* Page de confirmation après paiement : on relit la réservation à partir de la session Stripe (jamais depuis le navigateur seul). */
const L = require('./_lib');
exports.handler = async ev => {
  const sid = (ev.queryStringParameters || {}).session || '';
  if (!/^cs_/.test(sid)) return L.bad('Session invalide');
  try {
    let b = (await L.q('SELECT * FROM bookings WHERE checkout_ref=$1', [sid])).rows[0];
    if (!b) return L.bad('Réservation introuvable', 404);
    if (b.status === 'held' || b.status === 'expired') { // le webhook n’est peut-être pas encore passé : on vérifie directement auprès de Stripe
      const sess = await L.stripe('/checkout/sessions/' + sid, null, 'GET');
      if (sess.payment_status === 'paid') b = (await L.confirmBooking(b.id, sess)) || b;
    }
    const sn = b.snapshot || {};
    return L.json(200, { status: b.status, refunded: !!(((b.snapshot || {}).cancel || {}).refunded), label: sn.label, when: L.fmtWhen(new Date(b.starts_at)), deposit: b.deposit_cents, total: b.total_cents, balance: b.balance_cents, email: b.contact_email, duration: b.duration_min });
  } catch (e) { console.error(e); return L.bad('Vérification impossible', 500); }
};
