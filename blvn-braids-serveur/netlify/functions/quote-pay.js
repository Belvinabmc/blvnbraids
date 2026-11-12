/* Lien « Payer l’acompte et réserver » envoyé par e-mail avec le tarif.
   La cliente clique : on bloque le créneau demandé au tarif validé par la coiffeuse, puis on l’envoie sur Stripe. */
const L = require('./_lib');
const page = (title, msg) => ({ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${L.esc(title)} – Blvn Braids</title></head>
<body style="margin:0;background:#FF5A5F;font-family:Arial,Helvetica,sans-serif;color:#1A1A1A;padding:24px"><div style="max-width:480px;margin:40px auto;background:#FAFAFA;border-radius:22px;padding:28px">
<p style="margin:0 0 4px;font-size:26px;font-style:italic">Blvn Braids</p><p style="margin:0 0 22px;font-size:11px;letter-spacing:.3em">HAIRSTYLIST</p>
<h1 style="font-size:22px;font-weight:normal">${L.esc(title)}</h1><p>${msg}</p>
<p><a href="${L.ENV.site}" style="color:#1A1A1A">Retour au site</a> · Instagram <a href="https://instagram.com/blvn_braids" style="color:#1A1A1A">@blvn_braids</a></p></div></body></html>` });
const go = url => ({ statusCode: 303, headers: { location: url, 'cache-control': 'no-store' }, body: '' });

exports.handler = async ev => {
  const { r, t } = ev.queryStringParameters || {};
  if (!r || !t || t !== L.quoteToken(r)) return page('Lien invalide', 'Ce lien de paiement n’est pas valide. Répondez à l’e-mail reçu ou écrivez-nous sur Instagram.');
  try {
    const rq = (await L.q('SELECT * FROM requests WHERE id=$1', [r])).rows[0];
    if (!rq || rq.admin_price_cents == null || !rq.admin_duration_min || !['quote_sent', 'quote_accepted'].includes(rq.status))
      return page('Lien expiré', 'Cette proposition n’est plus active. Répondez à l’e-mail reçu ou écrivez-nous sur Instagram.');
    if (!rq.variant_id || !rq.service_id || !rq.desired_starts_at) return page('Créneau à fixer', 'Pour cette demande, le créneau se fixe avec la coiffeuse : répondez à l’e-mail reçu ou écrivez-nous sur Instagram.');
    const key = 'q:' + rq.id;
    let bk = (await L.q('SELECT * FROM bookings WHERE idempotency_key=$1', [key])).rows[0];
    if (bk && (bk.status === 'confirmed' || bk.status === 'completed')) return page('Déjà réservé', 'Votre rendez-vous est déjà confirmé. Vous avez reçu le récapitulatif par e-mail.');
    if (bk && bk.status === 'held' && bk.checkout_ref) { const s = await L.stripe('/checkout/sessions/' + bk.checkout_ref, null, 'GET'); if (s.url && s.status === 'open') return go(s.url); }
    const start = new Date(rq.desired_starts_at);
    if (start.getTime() < Date.now() + 3600000) return page('Créneau passé', 'Le créneau demandé est passé ou trop proche. Faites une nouvelle réservation sur le site ou écrivez-nous sur Instagram.');
    const set = await L.settings();
    const raw0 = (rq.answers || {}).raw || {}; let promo = null;
    if (raw0.promo) { const pr = await L.checkPromo({ code: raw0.promo, email: rq.contact_email, phone: rq.contact_phone, basePrice: await L.basePriceOf(rq.variant_id) }); if (pr.ok) promo = pr; }
    const total = Math.max(0, rq.admin_price_cents - (promo ? promo.amount : 0)), d = rq.admin_duration_min;
    const dep = set.depositFixed != null ? Math.min(total, set.depositFixed) : Math.round(total * set.depositRate);
    const end = new Date(start.getTime() + (d + set.margins.buffer_min) * 60000);
    const a = rq.answers || {}, label = a.label || 'Prestation Blvn Braids';
    const loc = rq.desired_location;
    try {
      if (bk) bk = (await L.q("UPDATE bookings SET status='held', starts_at=$2, ends_at=$3, duration_min=$4, total_cents=$5, deposit_cents=$6, balance_cents=$7, hold_expires_at=now() + interval '33 minutes', checkout_ref=NULL WHERE id=$1 RETURNING *", [bk.id, start, end, d, total, dep, total - dep])).rows[0];
      else {
        const pol = await L.q('SELECT id, kind FROM policy_versions WHERE published_at IS NOT NULL ORDER BY version DESC');
        const rulesId = (pol.rows.find(x => x.kind === 'rules') || {}).id, cancelId = (pol.rows.find(x => x.kind === 'cancellation') || {}).id;
        bk = (await L.q(`INSERT INTO bookings (service_id, variant_id, status, starts_at, ends_at, duration_min, travel_buffer_min, hold_expires_at, at_home, intervention_address, contact_email, contact_phone, client_name, client_note, total_cents, deposit_cents, balance_cents, snapshot, rules_version_id, cancellation_version_id, rules_accepted_at, cancellation_accepted_at, idempotency_key)
          VALUES ($1,$2,'held',$3,$4,$5,$6, now() + interval '33 minutes', $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, now(), now(), $19) RETURNING *`,
          [rq.service_id, rq.variant_id, start, end, d, set.margins.buffer_min, !!loc, loc ? JSON.stringify(loc) : null, rq.contact_email, rq.contact_phone, rq.client_name, rq.description, total, dep, total - dep,
           JSON.stringify({ label, lines: [[label, rq.admin_price_cents], ...(promo ? [[L.promoLabel(promo), -promo.amount]] : [])], summary: a.summary || [], duration: d, raw: a.raw || {}, fromRequest: rq.id, promo: promo ? { code: promo.code, amount: promo.amount, kind: promo.kind } : null }), rulesId, cancelId, key])).rows[0];
      }
    } catch (e) {
      if (/bookings_no_overlap/.test(e.message)) return page('Créneau déjà pris', 'Désolée, ce créneau vient d’être réservé par quelqu’un d’autre. Répondez à l’e-mail reçu pour en choisir un autre, ou écrivez-nous sur Instagram.');
      throw e;
    }
    const sess = await L.stripe('/checkout/sessions', {
      mode: 'payment', locale: 'fr', payment_method_types: { 0: 'card' }, customer_email: rq.contact_email, client_reference_id: bk.id,
      success_url: L.ENV.site + '/?paid={CHECKOUT_SESSION_ID}', cancel_url: L.ENV.site + '/?cancelled=' + bk.id,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      metadata: { booking_id: bk.id },
      payment_intent_data: { description: `Acompte Blvn Braids · ${label}`, metadata: { booking_id: bk.id } },
      line_items: { 0: { quantity: 1, price_data: { currency: 'eur', unit_amount: dep, product_data: { name: 'Acompte · ' + label, description: `Rendez-vous ${L.fmtWhen(start)} · total ${L.eur(total)}, reste ${L.eur(total - dep)} sur place` } } } },
    });
    await L.q("UPDATE bookings SET checkout_ref=$2, hold_expires_at = now() + interval '33 minutes' WHERE id=$1", [bk.id, sess.id]);
    return go(sess.url);
  } catch (e) { console.error(e); return page('Un souci technique', 'Le paiement n’a pas pu être préparé. Réessayez dans un instant, ou répondez à l’e-mail reçu.'); }
};
