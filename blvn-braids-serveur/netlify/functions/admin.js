/* Administration : protégée par un mot de passe (ADMIN_TOKEN). Lecture des rendez-vous et des demandes, réponses, annulations, horaires, durées. */
const L = require('./_lib');
exports.handler = async ev => {
  if (!L.isAdmin(ev)) return L.bad('Accès refusé', 401);
  try {
    await L.ensureSite();
    if (ev.httpMethod === 'GET') {
      const [bk, rq, wh, cat, gal, rev] = await Promise.all([
        L.q("SELECT id, status, starts_at, ends_at, duration_min, at_home, intervention_address, contact_email, contact_phone, client_name, client_note, total_cents, deposit_cents, balance_cents, snapshot, created_at FROM bookings WHERE starts_at > now() - interval '7 days' AND status IN ('held','confirmed','completed','cancelled') ORDER BY starts_at"),
        L.q("SELECT id, status, client_name, contact_email, contact_phone, description, answers, ai_suggestion, desired_location, desired_starts_at, admin_price_cents, admin_duration_min, admin_message, answered_at, created_at FROM requests WHERE created_at > now() - interval '60 days' ORDER BY created_at DESC"),
        L.q('SELECT weekday, starts_at, ends_at FROM working_hours ORDER BY weekday, starts_at'),
        L.catalog(),
        L.q('SELECT id, title, category, description, created_at FROM site_gallery ORDER BY sort_order, created_at DESC'),
        L.q('SELECT id, author, rating, comment, admin_reply, status, source, created_at FROM site_reviews ORDER BY created_at DESC'),
      ]);
      return L.json(200, { bookings: bk.rows.map(b => ({ ...b, when: L.fmtWhen(new Date(b.starts_at)) })), requests: rq.rows.map(r => ({ ...r, when: r.desired_starts_at ? L.fmtWhen(new Date(r.desired_starts_at)) : null })), hours: wh.rows, gallery: gal.rows, reviews: rev.rows, services: cat.services.map(s => ({ id: s.id, name: s.name, cat: s.cat, visible: s.visible })), categories: cat.categories, variants: cat.services.flatMap(s => s.variants.map(v => ({ id: v.id, serviceId: s.id, service: s.name, group: v.g, label: v.l, price: v.p, duration: v.d, refSize: v.refSize, refLen: v.refLen, askSize: v.askSize, askLen: v.askLen, hidden: v.hidden }))) });
    }
    const b = JSON.parse(ev.body || '{}');
    if (b.action === 'cancel') {
      const r = await L.q("UPDATE bookings SET status='cancelled', cancelled_at=now() WHERE id=$1 AND status IN ('held','confirmed') RETURNING *", [b.id]);
      if (r.rows[0]) { await L.q("UPDATE reminders SET status='cancelled' WHERE booking_id=$1", [b.id]);
        await L.sendMail({ to: r.rows[0].contact_email, subject: 'Votre rendez-vous a été annulé', html: `<p>Bonjour ${L.esc(r.rows[0].client_name || '')},</p><p>Votre rendez-vous du ${L.esc(L.fmtWhen(new Date(r.rows[0].starts_at)))} a été annulé.${b.message ? '<br>' + L.esc(b.message) : ''}</p><p>Pour le remboursement ou un report, répondez simplement à cet e-mail.</p><p>Blvn Braids</p>`, text: `Rendez-vous du ${L.fmtWhen(new Date(r.rows[0].starts_at))} annulé. ${b.message || ''}` }); }
      return L.json(200, { ok: !!r.rows[0] });
    }
    if (b.action === 'complete') { await L.q("UPDATE bookings SET status='completed' WHERE id=$1 AND status='confirmed'", [b.id]); return L.json(200, { ok: true }); }
    if (b.action === 'answer') {
      const price = Math.round(+b.price * 100), d = Math.round(+b.duration); if (!(price >= 0) || !(d > 0)) return L.bad('Tarif et durée requis');
      const r = await L.q("UPDATE requests SET status='quote_sent', admin_price_cents=$2, admin_duration_min=$3, admin_message=$4, answered_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [b.id, price, d, (b.message || '').trim() || null]);
      const rq = r.rows[0]; if (!rq) return L.bad('Demande introuvable', 404);
      const set = await L.settings(); const dep = set.depositFixed != null ? Math.min(price, set.depositFixed) : Math.round(price * set.depositRate);
      const canPay = !!(rq.variant_id && rq.desired_starts_at && new Date(rq.desired_starts_at).getTime() > Date.now() + 3600000);
      const label = (rq.answers || {}).label || 'votre prestation';
      const when = rq.desired_starts_at ? L.fmtWhen(new Date(rq.desired_starts_at)) : null;
      const btn = canPay ? `<p style="margin:22px 0"><a href="${L.quoteLink(rq.id)}" style="display:inline-block;background:#1A1A1A;color:#FAFAFA;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:bold">Payer l’acompte et réserver</a></p><p style="font-size:13px;color:#555">Le créneau est réservé dès que l’acompte est payé. Paiement sécurisé par Stripe.</p>`
        : `<p>Pour fixer votre rendez-vous, répondez simplement à cet e-mail ou écrivez-nous sur Instagram @blvn_braids.</p>`;
      await L.sendMail({ to: rq.contact_email, subject: 'Votre tarif Blvn Braids',
        html: L.layout('Votre tarif', `<p>Bonjour ${L.esc(rq.client_name || '')},</p><p>Pour <b>${L.esc(label)}</b>${when ? ' (créneau souhaité : ' + L.esc(when) + ')' : ''} :</p>${L.rowsHtml([['Tarif', L.eur(price)], ['Durée', L.dur(d)], ['Acompte pour réserver', L.eur(dep)], ['Reste à régler le jour J', L.eur(price - dep)]])}${rq.admin_message ? `<p>${L.esc(rq.admin_message)}</p>` : ''}${btn}<p>Blvn Braids</p>`),
        text: `Tarif : ${L.eur(price)}, durée : ${L.dur(d)}, acompte : ${L.eur(dep)}. ${rq.admin_message || ''} ${canPay ? 'Payer l’acompte : ' + L.quoteLink(rq.id) : 'Répondez à cet e-mail pour réserver.'}` });
      return L.json(200, { ok: true });
    }
    if (b.action === 'close') { await L.q("UPDATE requests SET status='closed', updated_at=now() WHERE id=$1", [b.id]); return L.json(200, { ok: true }); }
    if (b.action === 'variant') {   // durée, prix, référence d’un modèle
      const d = b.duration === '' || b.duration == null ? null : Math.round(+b.duration); const p = b.price === '' || b.price == null ? null : Math.round(+b.price * 100);
      if ((d != null && !(d > 0)) || (p != null && !(p >= 0))) return L.bad('Valeurs invalides');
      await L.q('UPDATE service_variants SET base_duration_min=COALESCE($2, base_duration_min), base_price_cents=COALESCE($3, base_price_cents), reference_size=COALESCE($4, reference_size), reference_length=COALESCE($5, reference_length) WHERE id=$1', [b.id, d, p, b.refSize || null, b.refLen || null]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'hours') {   // [{weekday, starts, ends}]
      await L.q('DELETE FROM working_hours');
      for (const h of b.hours || []) if (h.weekday >= 1 && h.weekday <= 7 && /^\d\d:\d\d$/.test(h.starts) && /^\d\d:\d\d$/.test(h.ends) && h.ends > h.starts) await L.q('INSERT INTO working_hours (weekday, starts_at, ends_at) VALUES ($1,$2,$3)', [h.weekday, h.starts, h.ends]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'timeoff') { await L.q('INSERT INTO time_off (during, reason) VALUES (tstzrange($1,$2), $3)', [L.parisDate(b.date, '00:00'), L.parisDate(b.date, '23:59'), b.reason || null]); return L.json(200, { ok: true }); }
    /* --- Galerie --- */
    if (b.action === 'gallery_add') {
      const img = L.parseImage(b.image), title = String(b.title || '').trim().slice(0, 80);
      if (!img) return L.bad('Photo invalide ou trop lourde'); if (!title) return L.bad('Donnez un titre à la photo');
      await L.q('INSERT INTO site_gallery (title, category, description, mime, data) VALUES ($1,$2,$3,$4,$5)', [title, String(b.category || '').trim().slice(0, 40) || null, String(b.description || '').trim().slice(0, 300) || null, img.mime, img.data]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'gallery_delete') { await L.q('DELETE FROM site_gallery WHERE id=$1', [b.id]); return L.json(200, { ok: true }); }
    /* --- Avis --- */
    if (b.action === 'review_add') {
      const author = String(b.author || '').trim().slice(0, 60), comment = String(b.comment || '').trim().slice(0, 600), n = Math.round(+b.rating);
      if (!author || !comment || !(n >= 1 && n <= 5)) return L.bad('Prénom, note et commentaire requis');
      await L.q("INSERT INTO site_reviews (author, rating, comment, status, source) VALUES ($1,$2,$3,'published','admin')", [author, n, comment]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'review_status') { if (!['published', 'hidden'].includes(b.status)) return L.bad('Statut invalide'); await L.q('UPDATE site_reviews SET status=$2 WHERE id=$1', [b.id, b.status]); return L.json(200, { ok: true }); }
    if (b.action === 'review_reply') { await L.q('UPDATE site_reviews SET admin_reply=$2 WHERE id=$1', [b.id, String(b.reply || '').trim().slice(0, 400) || null]); return L.json(200, { ok: true }); }
    if (b.action === 'review_delete') { await L.q('DELETE FROM site_reviews WHERE id=$1', [b.id]); return L.json(200, { ok: true }); }
    /* --- Prestations et modèles : ajout, renommage, masquage, suppression --- */
    const slugify = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'modele';
    const SIZE_OK = ['micro', 'extra_small', 'small', 'medium', 'large', 'extra_large'], LEN_OK = ['bob', 'shoulder', 'upper_back', 'mid_back', 'lower_back', 'waist', 'hips', 'below_hips'];
    if (b.action === 'variant_add') {
      const label = String(b.label || '').trim().slice(0, 80); if (!label) return L.bad('Donnez un nom au modèle');
      const svc = (await L.q('SELECT id FROM services WHERE id=$1', [b.serviceId])).rows[0]; if (!svc) return L.bad('Prestation introuvable', 404);
      const p = b.price === '' || b.price == null ? null : Math.round(+b.price * 100), d = b.duration === '' || b.duration == null ? null : Math.round(+b.duration);
      if ((p != null && !(p >= 0)) || (d != null && !(d > 0))) return L.bad('Prix ou durée invalide');
      const ord = (await L.q('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM service_variants WHERE service_id=$1', [svc.id])).rows[0].n;
      await L.q(`INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, base_duration_min, asks_size, asks_length, reference_size, reference_length, is_visible, sort_order)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11)`,
        [svc.id, slugify(label) + '-' + L.crypto.randomBytes(3).toString('hex'), String(b.group || '').trim().slice(0, 60), label, p, d, !!b.askSize, !!b.askLen,
         b.askSize && SIZE_OK.includes(b.refSize) ? b.refSize : null, b.askLen && LEN_OK.includes(b.refLen) ? b.refLen : null, ord]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'variant_rename') { const label = String(b.label || '').trim().slice(0, 80); if (!label) return L.bad('Nom requis'); await L.q('UPDATE service_variants SET label=$2 WHERE id=$1', [b.id, label]); return L.json(200, { ok: true }); }
    if (b.action === 'variant_visible') { await L.q('UPDATE service_variants SET is_visible=$2 WHERE id=$1', [b.id, !!b.visible]); return L.json(200, { ok: true }); }
    if (b.action === 'variant_delete') {
      try { await L.q('DELETE FROM service_variants WHERE id=$1', [b.id]); return L.json(200, { ok: true, deleted: true }); }
      catch (e) { if (e.code === '23503') { await L.q('UPDATE service_variants SET is_visible=false WHERE id=$1', [b.id]); return L.json(200, { ok: true, deleted: false }); } throw e; }
    }
    if (b.action === 'service_add') {
      const name = String(b.name || '').trim().slice(0, 60); if (!name) return L.bad('Donnez un nom à la prestation');
      const cat = (await L.q('SELECT id FROM service_categories WHERE slug=$1', [b.category])).rows[0]; if (!cat) return L.bad('Catégorie introuvable');
      const ord = (await L.q('SELECT COALESCE(MAX(sort_order),0)+1 AS n FROM services')).rows[0].n;
      await L.q("INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, menu_template, sort_order) VALUES ($1,$2,$3,true,true,true,'coiffure',$4)",
        [cat.id, slugify(name) + '-' + L.crypto.randomBytes(3).toString('hex'), name, ord]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'service_visible') { await L.q('UPDATE services SET is_visible=$2 WHERE id=$1', [b.id, !!b.visible]); return L.json(200, { ok: true }); }
    return L.bad('Action inconnue');
  } catch (e) { console.error(e); return L.bad('Erreur administration', 500); }
};
