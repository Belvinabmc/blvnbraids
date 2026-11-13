/* Administration : protégée par un mot de passe (ADMIN_TOKEN). Lecture des rendez-vous et des demandes, réponses, annulations, horaires, durées. */
const L = require('./_lib');
exports.handler = async ev => {
  /* Protection contre les essais de mot de passe en série : 10 erreurs en 15 min depuis la même connexion = blocage temporaire */
  const ip = L.clientIp(ev);
  if (!L.isAdmin(ev)) {
    if (await L.tooMany('admin-fail:' + ip, 10, 15)) return L.bad('Trop d’essais. Réessayez dans 15 minutes.', 429);
    return L.bad('Accès refusé', 401);
  }
  try {
    await L.ensureSite();
    if (ev.httpMethod === 'GET') {
      if ((ev.queryStringParameters || {}).push === 'key') return L.json(200, { key: (await L.vapid()).pub });
      const qm = (ev.queryStringParameters || {}).month;
      if (qm) { try { return L.json(200, await L.monthCalendar(qm, await L.settings(), null, true)); } catch (e) { if (/Mois/.test(e.message)) return L.bad('Mois invalide'); throw e; } }
      await L.reconcile().catch(e => console.error(e));   // un paiement réussi est toujours confirmé, même si Stripe n’a pas pu nous prévenir
      const set0 = await L.settings();
      const [bk, rq, wh, cat, gal, rev, promos, fbk] = await Promise.all([
        L.q("SELECT id, variant_id, status, hold_expires_at, starts_at, ends_at, duration_min, at_home, intervention_address, contact_email, contact_phone, client_name, client_note, total_cents, deposit_cents, balance_cents, snapshot, created_at FROM bookings WHERE starts_at > now() - interval '7 days' AND (status IN ('held','confirmed','completed','cancelled') OR (status='expired' AND snapshot->>'abandoned' = 'true' AND created_at > now() - interval '4 days')) ORDER BY starts_at"),
        L.q("SELECT id, status, client_name, contact_email, contact_phone, description, answers, ai_suggestion, desired_location, desired_starts_at, admin_price_cents, admin_duration_min, admin_message, answered_at, created_at FROM requests WHERE created_at > now() - interval '60 days' ORDER BY created_at DESC"),
        L.q('SELECT weekday, starts_at, ends_at FROM working_hours ORDER BY weekday, starts_at'),
        L.catalog(),
        L.q('SELECT id, title, category, description, created_at FROM site_gallery ORDER BY sort_order, created_at DESC'),
        L.q('SELECT id, author, rating, comment, admin_reply, status, source, created_at FROM site_reviews ORDER BY created_at DESC'),
        L.q('SELECT code, kind, owner_email, owner_name, amount_cents, created_at, expires_at, used_at FROM promo_codes ORDER BY created_at DESC LIMIT 150'),
        L.q('SELECT key, rating, issues, comment, stage, created_at FROM site_feedback ORDER BY created_at DESC LIMIT 300'),
      ]);
      return L.json(200, { bookings: bk.rows.map(b => ({ ...b, when: L.fmtWhen(new Date(b.starts_at)) })), requests: rq.rows.map(r => ({ ...r, when: r.desired_starts_at ? L.fmtWhen(new Date(r.desired_starts_at)) : null })), hours: wh.rows, gallery: gal.rows, reviews: rev.rows, promos: promos.rows, feedback: fbk.rows, ical: L.icalUrl(), reminder: set0.adminReminder, notice: set0.margins.min_notice_hours, services: cat.services.map(s => ({ id: s.id, name: s.name, cat: s.cat, visible: s.visible, sizeSupp: s.sizeSupp, lengthSupp: s.lengthSupp, groups: (s.groups || []).map(g => ({ id: g.id, l: g.l, kind: g.kind, price: g.price, unit: g.unit, hidden: g.hidden, items: (g.items || []).map(o => ({ id: o.id, l: o.l, p: o.p, d: o.d, unit: o.unit, hidden: o.hidden })) })) })), categories: cat.categories, variants: cat.services.flatMap(s => s.variants.map(v => ({ id: v.id, serviceId: s.id, service: s.name, group: v.g, label: v.l, price: v.p, duration: v.d, refSize: v.refSize, refLen: v.refLen, askSize: v.askSize, askLen: v.askLen, hidden: v.hidden, photo: v.photo }))) });
    }
    const b = JSON.parse(ev.body || '{}');
    if (b.action === 'cancel') {
      const cur = (await L.q("SELECT * FROM bookings WHERE id=$1 AND status IN ('held','confirmed')", [b.id])).rows[0];
      if (!cur) return L.json(200, { ok: false });
      try { const r = await L.cancelBooking(cur, { refund: !!b.refund, noShow: !!b.noShow, by: 'admin', message: String(b.message || '').slice(0, 500) }); return L.json(200, { ok: true, refunded: r.refunded }); }
      catch (e) { console.error('refund', e); return L.bad('Le remboursement n’a pas pu être lancé (' + String(e.message || e).slice(0, 120) + '). Le rendez-vous n’a pas été annulé.', 502); }
    }
    if (b.action === 'complete') {
      const r = await L.q("UPDATE bookings SET status='completed' WHERE id=$1 AND status='confirmed' RETURNING *", [b.id]);
      let codes = []; if (r.rows[0]) codes = await L.issueCodesOnComplete(r.rows[0]).catch(e => { console.error(e); return []; });
      return L.json(200, { ok: true, codes });
    }
    if (b.action === 'variant_photo') {
      const img = L.parseImage(b.image); if (!img) return L.bad('Photo invalide ou trop lourde');
      await L.q('INSERT INTO site_variant_photos (variant_id, mime, data, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (variant_id) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()', [b.id, img.mime, img.data]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'variant_photo_delete') { await L.q('DELETE FROM site_variant_photos WHERE variant_id=$1', [b.id]); return L.json(200, { ok: true }); }
    if (b.action === 'answer') {
      const price = Math.round(+b.price * 100), d = Math.round(+b.duration); if (!(price >= 0) || !(d > 0)) return L.bad('Tarif et durée requis');
      const r = await L.q("UPDATE requests SET status='quote_sent', admin_price_cents=$2, admin_duration_min=$3, admin_message=$4, answered_at=now(), updated_at=now() WHERE id=$1 RETURNING *", [b.id, price, d, (b.message || '').trim() || null]);
      const rq = r.rows[0]; if (!rq) return L.bad('Demande introuvable', 404);
      const set = await L.settings();
      const raw = (rq.answers || {}).raw || {}; let promo = null;
      if (raw.promo && rq.variant_id) { const pr = await L.checkPromo({ code: raw.promo, email: rq.contact_email, phone: rq.contact_phone, basePrice: await L.basePriceOf(rq.variant_id) }); if (pr.ok) promo = pr; }
      const net = Math.max(0, price - (promo ? promo.amount : 0));
      const dep = set.depositFixed != null ? Math.min(net, set.depositFixed) : Math.round(net * set.depositRate);
      const canPay = !!(rq.variant_id && rq.desired_starts_at && new Date(rq.desired_starts_at).getTime() > Date.now() + 3600000);
      const label = (rq.answers || {}).label || 'votre prestation';
      const when = rq.desired_starts_at ? L.fmtWhen(new Date(rq.desired_starts_at)) : null;
      const btn = canPay ? `<p style="margin:22px 0"><a href="${L.quoteLink(rq.id)}" style="display:inline-block;background:#1A1A1A;color:#FAFAFA;text-decoration:none;padding:14px 26px;border-radius:999px;font-weight:bold">Payer l’acompte et réserver</a></p><p style="font-size:13px;color:#555">Le créneau est réservé dès que l’acompte est payé. Paiement sécurisé par Stripe.</p>`
        : `<p>Pour fixer votre rendez-vous, répondez simplement à cet e-mail ou écrivez-nous sur Instagram @blvn_braids.</p>`;
      await L.sendMail({ to: rq.contact_email, subject: 'Votre tarif Blvn Braids',
        html: L.layout('Votre tarif', `<p>Bonjour ${L.esc(rq.client_name || '')},</p><p>Pour <b>${L.esc(label)}</b>${when ? ' (créneau souhaité : ' + L.esc(when) + ')' : ''} :</p>${L.rowsHtml([['Tarif', L.eur(price)], ...(promo ? [[L.promoLabel(promo), '− ' + L.eur(promo.amount)], ['Total', L.eur(net)]] : []), ['Durée', L.dur(d)], ['Acompte pour réserver', L.eur(dep)], ['Reste à régler le jour J', L.eur(net - dep)]])}${rq.admin_message ? `<p>${L.esc(rq.admin_message)}</p>` : ''}${btn}<p>Blvn Braids</p>`),
        text: `Tarif : ${L.eur(price)}${promo ? ` (${L.promoLabel(promo)} : − ${L.eur(promo.amount)}, total ${L.eur(net)})` : ''}, durée : ${L.dur(d)}, acompte : ${L.eur(dep)}. ${rq.admin_message || ''} ${canPay ? 'Payer l’acompte : ' + L.quoteLink(rq.id) : 'Répondez à cet e-mail pour réserver.'}` });
      return L.json(200, { ok: true });
    }
    if (b.action === 'close') {
      const r = await L.q("UPDATE requests SET status='closed', updated_at=now() WHERE id=$1 AND status <> 'closed' RETURNING *", [b.id]);
      const rq = r.rows[0];
      let sent = false, mailErr = null;
      if (rq && rq.contact_email && b.notify !== false) {
        const label = (rq.answers || {}).label || 'votre demande', msg = String(b.message || '').trim().slice(0, 500);
        sent = await L.sendMail({ to: rq.contact_email, subject: 'Votre demande Blvn Braids',
          html: L.layout('Votre demande n’a pas pu être retenue', `<p>Bonjour ${L.esc(rq.client_name || '')},</p><p>Nous ne pouvons malheureusement pas donner suite à votre demande pour <b>${L.esc(label)}</b>${rq.desired_starts_at ? ' (' + L.esc(L.fmtWhen(new Date(rq.desired_starts_at))) + ')' : ''}.</p>${msg ? `<p>${L.esc(msg)}</p>` : ''}<p><b>Aucun paiement n’a été effectué</b> et aucun créneau n’a été réservé.</p><p>Vous pouvez faire une nouvelle demande sur <a href="${L.ENV.site}" style="color:#1A1A1A">blvnbraids.com</a> ou nous écrire sur Instagram @blvn_braids.</p><p>Blvn Braids</p>`),
          text: `Nous ne pouvons pas donner suite à votre demande pour ${label}. ${msg} Aucun paiement n’a été effectué.` }).then(ok => { if (!ok) mailErr = 'refusé par le service d’e-mails'; return !!ok; }, e => { console.error('refus mail', e); mailErr = String(e.message || e).slice(0, 160); return false; });
      }
      return L.json(200, { ok: true, notified: !!sent, already: !rq, email: rq ? rq.contact_email : null, mailError: mailErr });
    }
    if (b.action === 'variant') {   // durée, prix, référence d’un modèle
      const d = b.duration === '' || b.duration == null ? null : Math.round(+b.duration); const p = b.price === '' || b.price == null ? null : Math.round(+b.price * 100);
      if ((d != null && !(d > 0)) || (p != null && !(p >= 0))) return L.bad('Valeurs invalides');
      await L.q('UPDATE service_variants SET base_duration_min=COALESCE($2, base_duration_min), base_price_cents=COALESCE($3, base_price_cents) WHERE id=$1', [b.id, d, p]);
      const S_OK = ['micro', 'extra_small', 'small', 'medium', 'large', 'extra_large'], L_OK = ['bob', 'shoulder', 'upper_back', 'mid_back', 'lower_back', 'waist', 'hips', 'below_hips'];
      if ('askSize' in b || 'askLen' in b) {   // nouvelle fiche : ce que la cliente choisit, et ce qui est compris dans le prix
        const as = !!b.askSize, al = !!b.askLen;
        await L.q('UPDATE service_variants SET asks_size=$2, asks_length=$3, reference_size=$4, reference_length=$5 WHERE id=$1', [b.id, as, al, as && S_OK.includes(b.refSize) ? b.refSize : null, al && L_OK.includes(b.refLen) ? b.refLen : null]);
      } else await L.q('UPDATE service_variants SET reference_size=COALESCE($2, reference_size), reference_length=COALESCE($3, reference_length) WHERE id=$1', [b.id, b.refSize || null, b.refLen || null]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'hours') {   // [{weekday, starts, ends}]
      await L.q('DELETE FROM working_hours');
      for (const h of b.hours || []) if (h.weekday >= 1 && h.weekday <= 7 && /^\d\d:\d\d$/.test(h.starts) && /^\d\d:\d\d$/.test(h.ends) && h.ends > h.starts) await L.q('INSERT INTO working_hours (weekday, starts_at, ends_at) VALUES ($1,$2,$3)', [h.weekday, h.starts, h.ends]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'feedback_delete') { await L.q('DELETE FROM site_feedback WHERE key=$1', [String(b.key || '')]); return L.json(200, { ok: true }); }
    if (b.action === 'admin_reminder') {   // rappels de la gérante : délai avant chaque rendez-vous et récap du matin
      const lead = Math.round(+b.lead); if (!(lead >= 0 && lead <= 1440)) return L.bad('Délai invalide');
      await L.q(`INSERT INTO public_settings (key, value) VALUES ('admin_reminder', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`, [JSON.stringify({ lead_minutes: lead, morning: !!b.morning })]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'notice') {   // délai minimum entre la réservation et le rendez-vous
      const h = Math.round(+b.hours); if (!(h >= 0 && h <= 168)) return L.bad('Délai invalide');
      await L.q(`INSERT INTO public_settings (key, value) VALUES ('schedule_margins', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = COALESCE(public_settings.value, '{}'::jsonb) || $1::jsonb`, [JSON.stringify({ min_notice_hours: h })]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'release') {   // libérer un créneau gardé par un paiement en cours
      const cur = (await L.q("SELECT * FROM bookings WHERE id=$1 AND status='held'", [b.id])).rows[0]; if (!cur) return L.json(200, { ok: false });
      if (cur.checkout_ref) { const sess = await L.stripe('/checkout/sessions/' + cur.checkout_ref, null, 'GET').catch(() => ({})); if (sess.payment_status === 'paid') { await L.confirmBooking(cur.id, sess); return L.json(200, { ok: true, paid: true }); }
        await L.stripe('/checkout/sessions/' + cur.checkout_ref + '/expire', {}).catch(() => {}); }
      await L.abandonBooking(cur.id); return L.json(200, { ok: true });
    }
    if (b.action === 'timeoff_remove') { if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return L.bad('Date invalide'); await L.q('DELETE FROM time_off WHERE during && tstzrange($1,$2)', [L.parisDate(b.date, '00:00'), L.parisDate(b.date, '23:59')]); return L.json(200, { ok: true }); }
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
    if (b.action === 'variant_meta') {   // nom, famille et prestation d’un modèle
      const label = String(b.label || '').trim().slice(0, 80); if (!label) return L.bad('Nom requis');
      const cur = (await L.q('SELECT service_id FROM service_variants WHERE id=$1', [b.id])).rows[0]; if (!cur) return L.bad('Modèle introuvable', 404);
      const sid = b.serviceId || cur.service_id;
      if (sid !== cur.service_id && !(await L.q('SELECT 1 FROM services WHERE id=$1', [sid])).rows[0]) return L.bad('Prestation introuvable');
      const moved = sid !== cur.service_id;
      await L.q(`UPDATE service_variants SET label=$2, grp=$3, service_id=$4${moved ? ', sort_order=(SELECT COALESCE(MAX(sort_order),0)+1 FROM service_variants WHERE service_id=$4)' : ''} WHERE id=$1`, [b.id, label, String(b.group || '').trim().slice(0, 60), sid]);
      return L.json(200, { ok: true, moved });
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
    if (b.action === 'supplements') {   // suppléments de prix selon la grosseur et la longueur, pour une prestation
      const svc = (await L.q('SELECT id FROM services WHERE id=$1', [b.serviceId])).rows[0]; if (!svc) return L.bad('Prestation introuvable', 404);
      const rows = [];
      for (const [kind, ok, src] of [['size', SIZE_OK, b.size || {}], ['length', LEN_OK, b.length || {}]])
        for (const k of ok) { const v = src[k]; if (v === '' || v == null) continue; const c = Math.round(+v * 100); if (!(c >= 0)) return L.bad('Montant invalide'); rows.push([kind, k, c]); }
      await L.q("DELETE FROM adjustment_rules WHERE service_id=$1 AND kind IN ('size','length')", [svc.id]);
      for (const [kind, k, c] of rows) await L.q(`INSERT INTO adjustment_rules (service_id, kind, ${kind}, supplement_cents) VALUES ($1,$2,$3,$4)`, [svc.id, kind, k, c]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'push_subscribe') {
      const sub = b.sub || {}; if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys) return L.bad('Abonnement invalide');
      await L.q('INSERT INTO push_subs (endpoint, sub, label) VALUES ($1,$2,$3) ON CONFLICT (endpoint) DO UPDATE SET sub=EXCLUDED.sub, label=EXCLUDED.label', [sub.endpoint, JSON.stringify(sub), String(b.label || '').slice(0, 80)]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'push_unsubscribe') { await L.q('DELETE FROM push_subs WHERE endpoint=$1', [String(b.endpoint || '')]); return L.json(200, { ok: true }); }
    if (b.action === 'push_test') { await L.notify('Notifications activées 🔔', 'Vous serez prévenue à chaque demande, réservation ou annulation.', '/gestion'); return L.json(200, { ok: true }); }
    if (b.action === 'option_add') {   // nouvelle option : case à cocher (flat) ou quantité (per_unit)
      const label = String(b.label || '').trim().slice(0, 120); if (!label) return L.bad('Donnez un nom à l’option');
      const kind = b.kind === 'per_unit' ? 'per_unit' : 'flat', unit = kind === 'per_unit' ? (String(b.unit || '').trim().slice(0, 30) || 'unité') : null;
      const pc = b.price === '' || b.price == null ? null : Math.round(+b.price * 100), dm = b.duration === '' || b.duration == null ? 0 : Math.round(+b.duration);
      if ((pc != null && !(pc >= 0)) || !(dm >= 0)) return L.bad('Prix ou durée invalide');
      const svc = (await L.q('SELECT id FROM services WHERE id=$1', [b.serviceId])).rows[0]; if (!svc) return L.bad('Prestation introuvable', 404);
      let gid = b.groupId;
      if (!gid || gid === '__new') {
        const gl = String(b.groupLabel || '').trim().slice(0, 80) || 'Suppléments';
        gid = (await L.q(`INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order, is_visible) VALUES ($1,$2,$3,'multi',false,(SELECT COALESCE(MAX(sort_order),0)+1 FROM option_groups WHERE service_id=$1),true) RETURNING id`, [svc.id, slugify(gl) + '-' + L.crypto.randomBytes(3).toString('hex'), gl])).rows[0].id;
      } else if (!(await L.q("SELECT 1 FROM option_groups WHERE id=$1 AND service_id=$2 AND kind IN ('multi','single')", [gid, svc.id])).rows[0]) return L.bad('Bloc introuvable');
      await L.q(`INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, sort_order, is_visible) VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(sort_order),0)+1 FROM service_options WHERE group_id=$1),true)`,
        [gid, slugify(label) + '-' + L.crypto.randomBytes(3).toString('hex'), label, kind, unit, pc, dm]);
      return L.json(200, { ok: true });
    }
    if (b.action === 'option_delete') { await L.q('DELETE FROM service_options WHERE id=$1', [b.id]); await L.q('DELETE FROM option_groups g WHERE g.id=$1 AND NOT EXISTS (SELECT 1 FROM service_options o WHERE o.group_id=g.id)', [b.groupId || null]).catch(() => {}); return L.json(200, { ok: true }); }
    if (b.action === 'options_save') {   // tarifs des options et suppléments (cases à cocher, quantités)
      const cents = v => v === '' || v == null ? null : Math.round(+v * 100), mins = v => v === '' || v == null ? null : Math.round(+v);
      for (const o of (b.options || []).slice(0, 200)) {
        const pc = cents(o.price), dm = mins(o.duration), lb = String(o.label || '').trim().slice(0, 120);
        if ((pc != null && !(pc >= 0)) || (dm != null && !(dm >= 0))) return L.bad('Prix ou durée invalide');
        await L.q('UPDATE service_options SET price_cents=$2, extra_duration_min=$3, label=COALESCE(NULLIF($4,\'\'), label), is_visible=$5 WHERE id=$1', [o.id, pc, dm, lb, o.visible !== false]);
      }
      for (const g of (b.groups || []).slice(0, 100)) {
        const pc = cents(g.price); if (pc != null && !(pc >= 0)) return L.bad('Prix invalide');
        await L.q('UPDATE option_groups SET price_cents=$2 WHERE id=$1', [g.id, pc]);
      }
      return L.json(200, { ok: true });
    }
    if (b.action === 'service_visible') { await L.q('UPDATE services SET is_visible=$2 WHERE id=$1', [b.id, !!b.visible]); return L.json(200, { ok: true }); }
    return L.bad('Action inconnue');
  } catch (e) { console.error(e); return L.bad('Erreur administration', 500); }
};
