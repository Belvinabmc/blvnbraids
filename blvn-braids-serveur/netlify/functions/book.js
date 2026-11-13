/* Réservation : le serveur recalcule tout. Tarif complet → créneau bloqué 30 min + paiement Stripe. Tarif incomplet → demande à la coiffeuse. */
const L = require('./_lib');
const email = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const phone = s => /^\+?[0-9 .-]{9,16}$/.test(s);
exports.handler = async ev => {
  if (ev.httpMethod !== 'POST') return L.bad('Méthode non autorisée', 405);
  let b; try { b = JSON.parse(ev.body || '{}'); } catch { return L.bad('Requête illisible'); }
  const contact = b.contact || {}, ans = b.answers || {};
  if (!b.serviceId || !b.variantId || !b.date || !b.time || !b.key) return L.bad('Informations manquantes');
  if (!contact.name || !email(contact.email || '') || !phone(contact.phone || '')) return L.bad('Coordonnées invalides');
  if (!b.rulesAccepted || !b.cancellationAccepted) return L.bad('Les règles doivent être acceptées');
  try {
    const [cat, set] = await Promise.all([L.catalog(), L.settings()]);
    const s = cat.services.find(x => x.id === b.serviceId && x.visible), v = s && s.variants.find(x => x.id === b.variantId && !x.hidden);
    if (!s || !v) return L.bad('Prestation introuvable');
    if (ans.home && !s.home) return L.bad('Déplacement non proposé pour cette prestation');
    if (ans.home && !(ans.address || '').trim()) return L.bad('Adresse manquante');
    const p = L.price(s, v, ans, set);
    if (p.missing.length) return L.bad('Réponses manquantes : ' + p.missing.join(', '));
    /* Code promo : vérifié ici, jamais côté navigateur */
    let promo = null;
    if (b.promo) {
      const pr = await L.checkPromo({ code: b.promo, email: contact.email, phone: contact.phone, basePrice: v.p });
      if (!pr.ok) return L.bad(pr.error);
      promo = { code: pr.code, amount: pr.amount, kind: pr.kind };
      ans.promo = pr.code;
      if (!p.pending && p.duration != null) {
        p.lines.push([L.promoLabel(pr), -pr.amount]);
        p.total = Math.max(0, p.total - pr.amount);
        p.deposit = set.depositFixed != null ? Math.min(p.total, set.depositFixed) : Math.round(p.total * set.depositRate);
      }
    }
    const label = `${s.name} · ${v.l}` + (p.summary.filter(x => /^(Grosseur|Longueur)/.test(x)).map(x => x.split(' : ')[1]).join(', ') ? ' · ' + p.summary.filter(x => /^(Grosseur|Longueur)/.test(x)).map(x => x.split(' : ')[1]).join(', ') : '');
    const startsAt = L.parisDate(b.date, b.time);
    if (isNaN(startsAt) || startsAt.getTime() < Date.now()) return L.bad('Créneau invalide');
    const pol = await L.q("SELECT id, kind FROM policy_versions WHERE published_at IS NOT NULL ORDER BY version DESC");
    const rulesId = (pol.rows.find(r => r.kind === 'rules') || {}).id, cancelId = (pol.rows.find(r => r.kind === 'cancellation') || {}).id;

    /* Tarif ou durée inconnus : demande, jamais de paiement ni de créneau bloqué */
    if (p.pending || p.duration == null) {
      const r = await L.q(`INSERT INTO requests (contact_email, contact_phone, client_name, status, category, description, answers, desired_location, desired_starts_at, service_id, variant_id, idempotency_key)
        VALUES ($1,$2,$3,'price_or_duration_missing',$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = now() RETURNING *, (xmax = 0) AS inserted`,
        [contact.email.trim(), contact.phone.trim(), contact.name.trim(), s.name, (contact.note || '').trim() || null, JSON.stringify({ label, lines: p.lines, summary: p.summary, raw: ans }), ans.home ? JSON.stringify({ text: ans.address, postcode: ans.postcode }) : null, startsAt, s.id, v.id, 'req:' + b.key]);
      if (r.rows[0].inserted) await L.mailRequest(r.rows[0], { label, lines: p.lines, summary: p.summary });
      return L.json(200, { kind: 'request', label, when: L.fmtWhen(startsAt), email: contact.email.trim() });
    }

    /* Tarif complet : on bloque le créneau le temps du paiement */
    const existing = await L.q('SELECT id, status, checkout_ref FROM bookings WHERE idempotency_key=$1', ['bk:' + b.key]);
    if (existing.rows[0] && existing.rows[0].status === 'confirmed') return L.json(200, { kind: 'paid', bookingId: existing.rows[0].id });
    const slotCheck = await L.availability(b.date, p.duration, set);
    const endsAt = new Date(startsAt.getTime() + (p.duration + set.margins.buffer_min) * 60000);
    if (!slotCheck.slots.some(x => x.time === b.time && x.available) && !existing.rows[0]) {
      /* Le créneau est pris… peut-être par cette même cliente, lors d’une tentative précédente : on le lui dit clairement */
      const mine = await L.sameClientAt(startsAt, endsAt, contact.email, contact.phone);
      if (mine && mine.status === 'held' && mine.checkout_ref) {
        const sess = await L.stripe('/checkout/sessions/' + mine.checkout_ref, null, 'GET').catch(() => ({}));
        if (sess.payment_status === 'paid') { await L.confirmBooking(mine.id, sess); return L.json(200, { kind: 'paid', when: L.fmtWhen(new Date(mine.starts_at)), email: mine.contact_email }); }
        if (sess.status === 'open' && sess.url) return L.json(200, { kind: 'pay', url: sess.url, resumed: true });
      }
      if (mine && mine.status === 'confirmed') return L.json(409, { code: 'already_confirmed', error: `Vous avez déjà un rendez-vous confirmé le ${L.fmtWhen(new Date(mine.starts_at))} : votre acompte a bien été reçu. La confirmation a été envoyée à ${mine.contact_email} (pensez à vérifier vos spams). Pour réserver pour une deuxième personne, choisissez un autre créneau.` });
      return L.json(409, { code: 'slot_taken', error: 'Ce créneau vient d’être réservé par quelqu’un d’autre. Choisissez-en un autre.' });
    }
    const snapshot = { label, lines: p.lines, summary: p.summary, duration: p.duration, raw: ans, depositRate: set.depositRate, promo };
    let booking;
    if (existing.rows[0]) booking = (await L.q('SELECT * FROM bookings WHERE id=$1', [existing.rows[0].id])).rows[0];
    else {
      try {
        booking = (await L.q(`INSERT INTO bookings (service_id, variant_id, status, starts_at, ends_at, duration_min, travel_buffer_min, hold_expires_at, at_home, intervention_address, contact_email, contact_phone, client_name, client_note, hair_supply, hair_type_id, hair_bundles, total_cents, deposit_cents, balance_cents, snapshot, rules_version_id, cancellation_version_id, rules_accepted_at, cancellation_accepted_at, idempotency_key)
          VALUES ($1,$2,'held',$3,$4,$5,$6, now() + ($7 || ' minutes')::interval, $8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now(), now(), $23) RETURNING *`,
          [s.id, v.id, startsAt, endsAt, p.duration, set.margins.buffer_min, String(set.holdMinutes), !!ans.home, ans.home ? JSON.stringify({ text: ans.address, postcode: ans.postcode }) : null, contact.email.trim(), contact.phone.trim(), contact.name.trim(), (contact.note || '').trim() || null, s.hair ? (ans.own ? 'client' : 'salon') : null, p.hairTypeId, p.bundles, p.total, p.deposit, p.total - p.deposit, JSON.stringify(snapshot), rulesId, cancelId, 'bk:' + b.key])).rows[0];
      } catch (e) { if (/bookings_no_overlap/.test(e.message)) return L.bad('Ce créneau vient d’être pris. Choisissez-en un autre.', 409); throw e; }
    }
    if (booking.checkout_ref && booking.status === 'held') { const sess = await L.stripe('/checkout/sessions/' + booking.checkout_ref, null, 'GET'); if (sess.url) return L.json(200, { kind: 'pay', url: sess.url }); }
    let sess;
    try { sess = await L.stripe('/checkout/sessions', {
      mode: 'payment', locale: 'fr', customer_email: contact.email.trim(), client_reference_id: booking.id,
      success_url: L.ENV.site + '/?paid={CHECKOUT_SESSION_ID}', cancel_url: L.ENV.site + '/?cancelled=' + booking.id,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,   // Stripe impose au moins 30 min
      metadata: { booking_id: booking.id },
      payment_intent_data: { description: `Acompte Blvn Braids · ${label}`, metadata: { booking_id: booking.id } },
      line_items: { 0: { quantity: 1, price_data: { currency: 'eur', unit_amount: p.deposit, product_data: { name: 'Acompte · ' + label, description: `Rendez-vous ${L.fmtWhen(startsAt)} · total ${L.eur(p.total)}, reste ${L.eur(p.total - p.deposit)} sur place` } } } },
    }); }
    catch (e) {   // le paiement n’a pas pu être préparé : on ne garde surtout pas le créneau bloqué
      console.error('stripe session', e);
      const detail = String((e && e.message) || e).slice(0, 300);
      await L.q(`UPDATE bookings SET status='expired', snapshot = COALESCE(snapshot,'{}'::jsonb) || '{"reconciled":true,"abandoned":true,"paymentError":true}'::jsonb WHERE id=$1 AND status='held'`, [booking.id]).catch(() => {});
      await L.notify('Paiement impossible à préparer', `${contact.name.trim()} · ${label} · ${L.fmtWhen(startsAt)} · ${contact.phone.trim()}`, '/gestion?tab=plan');
      if (L.ENV.adminEmail) await L.sendMail({ to: L.ENV.adminEmail, subject: 'Une cliente n’a pas pu accéder au paiement',
        html: L.layout('Paiement impossible à préparer', L.rowsHtml([['Cliente', contact.name.trim()], ['Prestation', label], ['Créneau', L.fmtWhen(startsAt)], ['E-mail', contact.email.trim()], ['Téléphone', contact.phone.trim()], ['Cause technique', detail]]) + '<p>La page de paiement n’a pas pu s’ouvrir. Rien n’a été débité et le créneau a été libéré. Recontactez la cliente, et transmettez la cause technique à votre développeur.</p>'), text: `${contact.name} · ${label} · ${detail}` }).catch(() => {});
      return L.json(502, { code: 'payment_unavailable', error: 'La page de paiement n’a pas pu s’ouvrir : votre réservation n’est pas enregistrée et rien n’a été débité. La coiffeuse vient d’être prévenue. Réessayez dans quelques minutes ou écrivez-nous sur Instagram.' });
    }
    await L.q("UPDATE bookings SET checkout_ref=$2, hold_expires_at = now() + interval '33 minutes' WHERE id=$1", [booking.id, sess.id]);
    return L.json(200, { kind: 'pay', url: sess.url, deposit: p.deposit, total: p.total });
  } catch (e) { console.error(e); return L.bad('Réservation impossible pour le moment', 500); }
};
