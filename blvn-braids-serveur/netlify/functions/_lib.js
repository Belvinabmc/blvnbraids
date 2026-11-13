/* Blvn Braids — serveur (Netlify Functions). Tout l’argent est en centimes, toutes les durées en minutes.
   Rien de secret ne sort d’ici : le client ne reçoit que ce qu’il peut afficher. */
const { Pool } = require('pg');
const crypto = require('crypto');

const ENV = {
  db: process.env.DATABASE_URL,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhook: process.env.STRIPE_WEBHOOK_SECRET,
  resendKey: process.env.RESEND_API_KEY,
  from: process.env.MAIL_FROM || 'Blvn Braids <rendezvous@blvnbraids.com>',
  adminEmail: process.env.ADMIN_EMAIL,
  adminToken: process.env.ADMIN_TOKEN,
  site: (process.env.SITE_URL || 'https://blvnbraids.com').replace(/\/$/, ''),
  dryRun: process.env.DRY_RUN === '1',
};
const TZ = 'Europe/Paris';

let pool;
const db = () => (pool ||= new Pool({ connectionString: ENV.db, max: 3, ssl: /supabase|pooler/.test(ENV.db || '') ? { rejectUnauthorized: false } : undefined }));
const q = (text, params) => db().query(text, params);

const json = (status, body, extra = {}) => ({ statusCode: status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }, body: JSON.stringify(body) });
const bad = (msg, status = 400) => json(status, { error: msg });
const eur = c => (c / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const dur = m => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ' ' + String(m % 60).padStart(2, '0') : ''}` : `${m} min`);
const SIZES = { micro: 'Micro', extra_small: 'Extra Small', small: 'Small', medium: 'Medium', large: 'Large', extra_large: 'Extra Large' };
const LENGTHS = { bob: 'Bob / carré', shoulder: 'Épaules', upper_back: 'Haut du dos', mid_back: 'Milieu du dos', lower_back: 'Bas du dos', waist: 'Taille', hips: 'Hanches', below_hips: 'Sous les hanches', other: 'Autre' };

/* ---------- Paramètres ---------- */
async function settings() {
  const { rows } = await q('SELECT key, value FROM public_settings');
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const dep = s.deposit || { type: 'percent', rate: 45 };
  return {
    depositRate: dep.type === 'percent' ? (dep.rate ?? 45) / 100 : null,
    depositFixed: dep.type === 'fixed' ? dep.amount_cents : null,
    holdMinutes: +(s.hold_minutes ?? 30),
    margins: { slot_step_min: 30, buffer_min: 30, min_notice_hours: 24, max_days_ahead: 60, ...(s.schedule_margins || {}) },
    adminReminder: { lead_minutes: 60, morning: true, ...(s.admin_reminder || {}) },
    travelFees: s.travel_fees || {},
    contact: s.contact || {},
  };
}

/* ---------- Catalogue (forme attendue par le site) ---------- */
async function catalog() {
  await ensureSite();
  const vph = await q('SELECT variant_id, extract(epoch from updated_at)::bigint AS t FROM site_variant_photos');
  const [cats, svcs, vars, rules, hair, groups, opts, media, pol] = await Promise.all([
    q('SELECT * FROM service_categories ORDER BY sort_order'),
    q('SELECT * FROM services ORDER BY sort_order'),
    q('SELECT * FROM service_variants ORDER BY sort_order'),
    q('SELECT * FROM adjustment_rules'),
    q('SELECT * FROM hair_types ORDER BY sort_order'),
    q('SELECT * FROM option_groups ORDER BY sort_order'),
    q('SELECT * FROM service_options ORDER BY sort_order'),
    q("SELECT service_id, storage_path FROM media WHERE is_published = true AND kind='photo' ORDER BY sort_order"),
    q("SELECT kind, body FROM policy_versions WHERE published_at IS NOT NULL ORDER BY version DESC"),
  ]);
  const photoOf = (kind, id) => kind === 'service' ? ((media.rows.find(m => m.service_id === id) || {}).storage_path || null) : null;
  const services = svcs.rows.map(s => {
    const cat = cats.rows.find(c => c.id === s.category_id) || {};
    const sizeSupp = {}, lengthSupp = {};
    rules.rows.filter(r => r.service_id === s.id).forEach(r => { if (r.kind === 'size') sizeSupp[r.size] = r.supplement_cents; if (r.kind === 'length') lengthSupp[r.length] = r.supplement_cents; });
    return {
      id: s.id, cat: cat.slug, catLabel: cat.label, name: s.name, tpl: s.menu_template || 'coiffure', visible: s.is_visible, photo: photoOf('service', s.id),
      refSize: s.reference_size, refLength: s.reference_length, sizeSupp, lengthSupp, home: s.home_allowed,
      hair: s.hair_enabled ? { perBundle: s.hair_pricing === 'per_bundle', types: hair.rows.filter(h => h.service_id === s.id).map(h => ({ id: h.id, l: h.label, p: h.price_cents, d: h.extra_duration_min || 0 })) } : null,
      variants: vars.rows.filter(v => v.service_id === s.id).map(v => ({ id: v.id, g: v.grp, l: v.label, p: v.base_price_cents, d: v.base_duration_min, askSize: v.asks_size, askLen: v.asks_length, refSize: v.reference_size, refLen: v.reference_length, quote: v.base_price_cents == null, from: v.is_from_price, hidden: !v.is_visible, photo: (r => r ? `/api/media?v=${v.id}&t=${r.t}` : null)(vph.rows.find(x => x.variant_id === v.id)) })),
      groups: groups.rows.filter(g => g.service_id === s.id).map(g => ({ id: g.id, l: g.label, kind: g.kind, required: g.required, hidden: !g.is_visible, scope: g.scope || { mode: 'all', ids: [] }, cond: g.cond, price: g.price_cents, unit: g.unit_label || '', min: g.min_value ?? '', max: g.max_value ?? '', ph: g.placeholder || '',
        items: opts.rows.filter(o => o.group_id === g.id).map(o => ({ id: o.id, l: o.label, p: o.price_cents, d: o.extra_duration_min || 0, unit: o.kind === 'per_unit' ? (o.unit_label || '') : '', only: (o.allowed_variant_groups || []).join('|'), hidden: !o.is_visible, photo: photoOf('option', o.id) })) })),
    };
  });
  const categories = cats.rows.map(c => ({ id: c.slug, label: c.label, active: c.is_visible }));
  const policies = Object.fromEntries(pol.rows.map(p => [p.kind, p.body]).reverse());
  return { services, categories, policies };
}

/* ---------- Tarification (mêmes règles que le site, mais ici la source fait foi) ---------- */
const grpApplies = (g, v) => g.scope.mode === 'all' || (g.scope.ids || []).includes(v.id);
const okItem = (x, v) => !x.only || x.only.split('|').includes(v.g);
function visGroups(s, v, sel) {
  const vis = (g, d = 0) => {
    if (g.hidden || !grpApplies(g, v) || d > 8) return false;
    if (g.cond) { const p = s.groups.find(x => x.id === g.cond.gid); if (!p || !vis(p, d + 1)) return false;
      const a = sel[p.id]; if (p.kind === 'multi') { if (!(a && +a[g.cond.v] > 0)) return false; } else if (a !== g.cond.v) return false; }
    return true;
  };
  return s.groups.filter(g => vis(g));
}
function price(s, v, ans, set) {
  const lines = [[`${s.name} · ${v.l}`, v.p]]; let extra = 0; const summary = [];
  if (v.askSize && ans.size) { const rf = v.refSize || s.refSize || null; if (ans.size !== rf) lines.push(['Grosseur · ' + (SIZES[ans.size] || ans.size), rf ? (s.sizeSupp[ans.size] ?? null) : null]); summary.push('Grosseur : ' + (SIZES[ans.size] || ans.size)); }
  if (v.askLen && ans.length) { const rf = v.refLen || s.refLength || null; const other = ans.length === 'other'; lines.push(...(ans.length !== rf ? [['Longueur · ' + (other ? 'autre (' + (ans.lengthOther || 'à préciser') + ')' : LENGTHS[ans.length]), (other || !rf) ? null : (s.lengthSupp[ans.length] ?? null)]] : [])); summary.push('Longueur : ' + (other ? ans.lengthOther : LENGTHS[ans.length])); }
  let hairTypeId = null, bundles = null;
  if (s.hair) {
    if (ans.own) summary.push('Mèches : apportées par la cliente');
    else if (ans.hairType) { const t = s.hair.types.find(x => x.id === ans.hairType); if (t) { hairTypeId = t.id; if (s.hair.perBundle) { bundles = Math.max(1, Math.round(+ans.bundles || 0)); lines.push([`Mèches ${t.l.toLowerCase()} (${bundles} bundle${bundles > 1 ? 's' : ''})`, t.p == null ? null : t.p * bundles]); } else lines.push([`Mèches ${t.l.toLowerCase()}`, t.p]); extra += t.d || 0; summary.push('Mèches fournies : ' + t.l); } }
  }
  const sel = ans.sel || {}; const missing = [];
  for (const g of visGroups(s, v, sel)) {
    const a = sel[g.id]; const items = g.items.filter(x => !x.hidden && okItem(x, v));
    if (g.kind === 'single') { const x = items.find(i => i.id === a); if (x) { lines.push([`${g.l} · ${x.l}`, x.p]); extra += x.d || 0; summary.push(`${g.l} : ${x.l}`); } else if (g.required && items.length) missing.push(g.l); }
    else if (g.kind === 'multi') { const m = a || {}; const chosen = items.filter(x => +m[x.id] > 0); chosen.forEach(x => { const n = +m[x.id]; lines.push([x.unit ? `${x.l} (${n} ${x.unit})` : x.l, x.p == null ? null : x.p * n]); extra += (x.d || 0) * n; }); if (chosen.length) summary.push(`${g.l} : ${chosen.map(x => x.l).join(', ')}`); else if (g.required && items.length) missing.push(g.l); }
    else if (g.kind === 'yesno') { if (a === 'yes' || a === 'no') { if (a === 'yes' && g.price != null) lines.push([`${g.l} · Oui`, g.price]); summary.push(`${g.l} : ${a === 'yes' ? 'Oui' : 'Non'}`); } else if (g.required) missing.push(g.l); }
    else if (g.kind === 'number') { const n = Math.round(+a); const ok = a !== '' && a != null && Number.isFinite(n) && n >= (+g.min || 0) && (g.max === '' || g.max == null || n <= +g.max); if (ok) { if (g.price != null && n > 0) lines.push([`${g.l} (${n}${g.unit ? ' ' + g.unit : ''})`, g.price * n]); summary.push(`${g.l} : ${n}${g.unit ? ' ' + g.unit : ''}`); } else if (g.required || (a !== '' && a != null)) missing.push(g.l); }
    else if (g.kind === 'text') { if ((a || '').trim()) summary.push(`${g.l} : ${String(a).trim().slice(0, 400)}`); else if (g.required) missing.push(g.l); }
    else if (g.kind === 'photo') { if (a) summary.push(`${g.l} : photo jointe`); else if (g.required) missing.push(g.l); }
  }
  let travel = null;
  if (ans.home) { const d = String(ans.postcode || '').slice(0, 2); travel = set.travelFees[d] ?? null; lines.push(['Frais de déplacement', travel]); }
  const total = lines.filter(l => l[1] != null).reduce((t, l) => t + l[1], 0);
  const pending = lines.some(l => l[1] == null) || v.p == null;
  const duration = v.d == null ? null : v.d + extra;
  const deposit = set.depositFixed != null ? Math.min(total, set.depositFixed) : Math.round(total * set.depositRate);
  return { lines, total, deposit, pending, duration, summary, missing, hairTypeId, bundles, travel };
}

/* ---------- Dates (Europe/Paris) ---------- */
const parisParts = d => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value])); return p; };
const parisOffsetMin = d => { const p = parisParts(d); const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); return Math.round((asUTC - d.getTime()) / 60000); };
/* "2026-11-20" + "14:00" → Date (instant) en heure de Paris */
function parisDate(ymd, hm) {
  const [y, m, d] = ymd.split('-').map(Number), [H, M] = hm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, H, M); let t = wall - 3600000;
  for (let i = 0; i < 2; i++) t = wall - parisOffsetMin(new Date(t)) * 60000;
  return new Date(t);
}
const fmtWhen = d => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(d);

/* Créneaux d’un jour pour une durée donnée */
async function availability(ymd, durationMin, set) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return { slots: [], closed: true };
  await q("UPDATE bookings SET status='expired' WHERE status='held' AND hold_expires_at < now()");
  const m = set.margins, dayStart = parisDate(ymd, '00:00'), dayEnd = new Date(dayStart.getTime() + 86400000);
  const wd = ((dayStart.getUTCDay() + 6) % 7) + 1;   // 1 = lundi … 7 = dimanche (en heure de Paris : le jour commence à minuit Paris)
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' }).format(new Date(dayStart.getTime() + 43200000));
  const WD = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[weekday] || wd;
  const [hours, busy, off] = await Promise.all([
    q('SELECT starts_at, ends_at FROM working_hours WHERE weekday=$1 ORDER BY starts_at', [WD]),
    q("SELECT starts_at, ends_at FROM bookings WHERE status IN ('held','confirmed') AND ends_at > $1 AND starts_at < $2", [dayStart, dayEnd]),
    q('SELECT during FROM time_off WHERE during && tstzrange($1,$2)', [dayStart, dayEnd]),
  ]);
  if (!hours.rows.length) return { slots: [], closed: true };
  const now = Date.now(), minStart = now + m.min_notice_hours * 3600000, maxStart = now + m.max_days_ahead * 86400000;
  const need = (durationMin || 180) + m.buffer_min;
  const slots = [];
  for (const h of hours.rows) {
    const open = parisDate(ymd, h.starts_at.slice(0, 5)), close = parisDate(ymd, h.ends_at.slice(0, 5));
    for (let t = open.getTime(); t + (durationMin || 180) * 60000 <= close.getTime(); t += m.slot_step_min * 60000) {
      const end = t + need * 60000;
      const label = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(t));
      let ok = t >= minStart && t <= maxStart;
      if (ok) ok = !busy.rows.some(b => new Date(b.starts_at).getTime() < end && new Date(b.ends_at).getTime() > t);
      if (ok) ok = !off.rows.length;   // journée bloquée : aucun créneau
      if (t >= minStart) slots.push({ time: label, available: ok });
    }
  }
  return { slots, closed: false, approxDuration: durationMin == null };
}

/* Calendrier du mois pour la gérante : état de chaque jour (libre, complet, bloqué, fermé, passé) */
async function monthCalendar(ym, set, durationMin = null, detail = false) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(ym)) throw new Error('Mois invalide');
  const [Y, M] = ym.split('-').map(Number), n = new Date(Date.UTC(Y, M, 0)).getUTCDate(), pad = x => String(x).padStart(2, '0');
  const first = parisDate(`${ym}-01`, '00:00'), last = new Date(parisDate(`${ym}-${pad(n)}`, '23:59').getTime() + 60000);
  await q("UPDATE bookings SET status='expired' WHERE status='held' AND hold_expires_at < now()");
  if (!durationMin) {   // sans modèle précis, on se base sur la prestation la plus courte : un jour est « libre » s’il reste au moins une place
    const m0 = (await q('SELECT MIN(base_duration_min) AS d FROM service_variants WHERE is_visible AND base_duration_min IS NOT NULL').catch(() => ({ rows: [{}] }))).rows[0];
    durationMin = Math.max(30, Math.min(180, (m0 && m0.d) || 60));
  }
  const [hours, busy, off] = await Promise.all([
    q('SELECT weekday, starts_at, ends_at FROM working_hours ORDER BY starts_at'),
    q("SELECT id, starts_at, ends_at, status, client_name, hold_expires_at, snapshot->>'label' AS label FROM bookings WHERE status IN ('held','confirmed') AND ends_at > $1 AND starts_at < $2 ORDER BY starts_at", [first, last]),
    q('SELECT lower(during) AS a, upper(during) AS b FROM time_off WHERE during && tstzrange($1,$2)', [first, last]),
  ]);
  const m = set.margins, now = Date.now(), minStart = now + m.min_notice_hours * 3600000, need = durationMin + m.buffer_min;
  const WDS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }, T = x => new Date(x).getTime(), days = [];
  const hm = x => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(x));
  for (let d = 1; d <= n; d++) {
    const ymd = `${ym}-${pad(d)}`, ds = parisDate(ymd, '00:00').getTime(), de = parisDate(ymd, '23:59').getTime() + 60000;
    const WD = WDS[new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' }).format(new Date(ds + 43200000))];
    const hs = hours.rows.filter(h => h.weekday === WD);
    const todays = busy.rows.filter(b => T(b.starts_at) < de && T(b.ends_at) > ds);
    const booked = todays.filter(b => b.status === 'confirmed').length, held = todays.filter(b => b.status === 'held').length;
    let status, free = 0, freeLate = 0;
    if (de <= now) status = 'past';
    else if (!hs.length) status = 'closed';
    else if (off.rows.some(o => T(o.a) < de && T(o.b) > ds)) status = 'blocked';
    else {
      for (const h of hs) { const open = parisDate(ymd, h.starts_at.slice(0, 5)).getTime(), close = parisDate(ymd, h.ends_at.slice(0, 5)).getTime();
        for (let t = open; t + durationMin * 60000 <= close; t += m.slot_step_min * 60000) { if (busy.rows.some(b => T(b.starts_at) < t + need * 60000 && T(b.ends_at) > t) || t < now) continue; if (t >= minStart) free++; else freeLate++; } }
      status = free ? 'free' : freeLate ? 'late' : 'full';   // late = il reste de la place, mais le délai minimum de réservation est dépassé
    }
    const day = { date: ymd, weekday: WD, status, free, booked, held };
    if (detail) day.items = todays.map(b => ({ id: b.id, status: b.status, time: hm(b.starts_at), end: hm(b.ends_at), name: b.client_name || '', label: b.label || '', until: b.status === 'held' && b.hold_expires_at ? hm(b.hold_expires_at) : null }));
    days.push(day);
  }
  return { month: ym, days, notice: m.min_notice_hours, base: durationMin };
}

/* ---------- Codes promo à usage unique : fidélité et parrainage ---------- */
const PROMO_MIN = 3500;          // le prix du modèle (hors suppléments) doit dépasser 35 €
const PROMO_AMOUNT = 500;        // 5 €
const LOYALTY_EVERY = 4;         // 4 rendez-vous terminés = un code pour le 5e
const PROMO_RULE = 'Valable une seule fois, sur une prestation de plus de 35 € (prix du modèle, hors suppléments), non cumulable.';
const genCode = prefix => prefix + '-' + Array.from(crypto.randomBytes(7)).map(x => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 32]).join('');
const normCode = c => String(c || '').trim().toUpperCase().replace(/\s+/g, '');
const digits = s => String(s || '').replace(/\D/g, '').slice(-9);
async function basePriceOf(variantId) { const r = await q('SELECT base_price_cents FROM service_variants WHERE id=$1', [variantId]); return r.rows[0] ? r.rows[0].base_price_cents : null; }
/* Vérifie un code pour une cliente et un modèle : { ok, amount, kind, ownerName } ou { ok:false, error } */
async function checkPromo({ code, email, phone, basePrice }) {
  await ensureSite();
  const c = normCode(code); if (!c) return { ok: false, error: 'Indiquez un code.' };
  const r = (await q('SELECT * FROM promo_codes WHERE code=$1', [c])).rows[0];
  if (!r) return { ok: false, error: 'Ce code n’existe pas.' };
  if (r.used_at) return { ok: false, error: 'Ce code a déjà été utilisé.' };
  if (new Date(r.expires_at).getTime() < Date.now()) return { ok: false, error: 'Ce code a expiré.' };
  if (!(basePrice > PROMO_MIN)) return { ok: false, error: 'Ce code est valable uniquement sur une prestation de plus de 35 € (prix du modèle, hors suppléments).' };
  const em = String(email || '').trim().toLowerCase();
  if (r.kind === 'referral_gift') {
    if (em && em === r.owner_email.toLowerCase()) return { ok: false, error: 'Ce code est à offrir à une amie : vous ne pouvez pas l’utiliser vous-même.' };
    const ph = digits(phone);
    const prev = await q("SELECT 1 FROM bookings WHERE status IN ('confirmed','completed') AND (lower(contact_email)=$1 OR ($2 <> '' AND right(regexp_replace(contact_phone,'\D','','g'),9)=$2)) LIMIT 1", [em, ph]);
    if (prev.rows[0]) return { ok: false, error: 'Ce code est réservé à une première visite.' };
  } else if (!em || em !== r.owner_email.toLowerCase()) return { ok: false, error: 'Ce code est personnel : utilisez l’adresse e-mail à laquelle vous l’avez reçu.' };
  return { ok: true, code: c, amount: r.amount_cents, kind: r.kind, ownerName: r.owner_name || '' };
}
const promoLabel = (pr) => pr.kind === 'referral_gift' ? `Code parrainage ${pr.code}` : pr.kind === 'loyalty' ? `Code fidélité ${pr.code}` : `Code merci ${pr.code}`;
/* Un rendez-vous payé « consomme » son code */
async function promoUsed(b) { const pr = (b.snapshot || {}).promo; if (!pr || !pr.code) return; await ensureSite(); await q('UPDATE promo_codes SET used_at=now(), used_booking_id=$2 WHERE code=$1 AND used_at IS NULL', [pr.code, b.id]).catch(() => {}); }
async function sendCode(to, name, code, title, intro, kind) {
  await sendMail({ to, subject: title,
    html: layout(title, `<p>Bonjour ${esc(name || '')},</p><p>${intro}</p><p style="margin:20px 0;text-align:center"><span style="display:inline-block;border:2px dashed #1A1A1A;border-radius:14px;padding:14px 26px;font-size:26px;letter-spacing:.12em;font-weight:bold">${esc(code)}</span></p><p>${kind === 'referral_gift' ? 'Votre amie le saisit dans « Code promo », à l’étape « Vos coordonnées », lors de sa première réservation sur <a href="' + ENV.site + '" style="color:#1A1A1A">blvnbraids.com</a>.' : 'Saisissez-le dans « Code promo », à l’étape « Vos coordonnées », lors de votre prochaine réservation sur <a href="' + ENV.site + '" style="color:#1A1A1A">blvnbraids.com</a>, avec cette adresse e-mail.'}</p><p style="font-size:13px;color:#555">${PROMO_RULE} Valable 6 mois.</p><p>Blvn Braids</p>`),
    text: `${intro} Code : ${code}. ${PROMO_RULE} Valable 6 mois.` });
}
/* Quand un rendez-vous est marqué terminé : codes fidélité, parrainage et merci */
async function issueCodesOnComplete(b) {
  await ensureSite(); const out = [];
  const base = await basePriceOf(b.variant_id); const em = String(b.contact_email || '').trim().toLowerCase();
  if (!em) return out;
  if (base > PROMO_MIN) {
    // fidélité : tous les 4 rendez-vous terminés éligibles
    const n = (await q(`SELECT count(*)::int AS n FROM bookings bk JOIN service_variants v ON v.id = bk.variant_id WHERE bk.status='completed' AND lower(bk.contact_email)=$1 AND v.base_price_cents > $2`, [em, PROMO_MIN])).rows[0].n;
    const given = (await q("SELECT count(*)::int AS n FROM promo_codes WHERE kind='loyalty' AND lower(owner_email)=$1", [em])).rows[0].n;
    if (Math.floor(n / LOYALTY_EVERY) > given) {
      const code = genCode('FIDELE'); await q("INSERT INTO promo_codes (code, kind, owner_email, owner_name, amount_cents, source_booking_id) VALUES ($1,'loyalty',$2,$3,$4,$5)", [code, em, b.client_name, PROMO_AMOUNT, b.id]);
      await sendCode(b.contact_email, b.client_name, code, 'Merci pour votre fidélité : 5 € offerts', `Vous en êtes à ${n} rendez-vous chez Blvn Braids, merci ! Voici <b>5 € de réduction</b> sur votre prochain rendez-vous :`, 'loyalty').catch(e => console.error(e));
      out.push({ kind: 'loyalty', code });
    }
    // code à offrir : un seul actif à la fois
    const active = (await q("SELECT 1 FROM promo_codes WHERE kind='referral_gift' AND lower(owner_email)=$1 AND used_at IS NULL AND expires_at > now()", [em])).rows[0];
    if (!active) {
      const code = genCode('AMIE'); await q("INSERT INTO promo_codes (code, kind, owner_email, owner_name, amount_cents, source_booking_id) VALUES ($1,'referral_gift',$2,$3,$4,$5)", [code, em, b.client_name, PROMO_AMOUNT, b.id]);
      await sendCode(b.contact_email, b.client_name, code, 'Un code à offrir à une amie', `Merci pour votre visite ! Faites découvrir Blvn Braids : ce code offre <b>5 € de réduction</b> à une amie pour sa première visite. Quand elle sera venue, vous recevrez vous aussi <b>5 €</b> sur votre prochain rendez-vous.`, 'referral_gift').catch(e => console.error(e));
      out.push({ kind: 'referral_gift', code });
    }
  }
  // merci à la marraine
  const pr = (b.snapshot || {}).promo;
  if (pr && pr.kind === 'referral_gift') {
    const g = (await q('SELECT owner_email, owner_name FROM promo_codes WHERE code=$1', [pr.code])).rows[0];
    const done = (await q("SELECT 1 FROM promo_codes WHERE kind='referral_thanks' AND source_booking_id=$1", [b.id])).rows[0];
    if (g && !done) {
      const code = genCode('MERCI'); await q("INSERT INTO promo_codes (code, kind, owner_email, owner_name, amount_cents, source_booking_id) VALUES ($1,'referral_thanks',$2,$3,$4,$5)", [code, g.owner_email, g.owner_name, PROMO_AMOUNT, b.id]);
      await sendCode(g.owner_email, g.owner_name, code, 'Merci pour votre recommandation : 5 € offerts', `${esc(b.client_name || 'Votre amie')} est venue grâce à vous, merci ! Voici <b>5 € de réduction</b> sur votre prochain rendez-vous :`, 'referral_thanks').catch(e => console.error(e));
      out.push({ kind: 'referral_thanks', code });
    }
  }
  return out;
}


/* ---------- Notifications de l’appli Blvn Gestion (Web Push) ---------- */
let pushKeys;
async function vapid() {
  if (pushKeys) return pushKeys; await ensureSite();
  let r = (await q('SELECT public_key, private_key FROM push_keys WHERE id=1')).rows[0];
  if (!r) { const k = require('web-push').generateVAPIDKeys(); await q('INSERT INTO push_keys (id, public_key, private_key) VALUES (1,$1,$2) ON CONFLICT (id) DO NOTHING', [k.publicKey, k.privateKey]); r = (await q('SELECT public_key, private_key FROM push_keys WHERE id=1')).rows[0]; }
  return (pushKeys = { pub: r.public_key, priv: r.private_key });
}
/* Envoie une notification à tous les téléphones de la gérante ; ne fait jamais échouer l’action en cours */
async function notify(title, body, url = '/gestion') {
  try {
    const wp = require('web-push'), k = await vapid();
    wp.setVapidDetails('mailto:' + (ENV.adminEmail || 'rendezvous@blvnbraids.com'), k.pub, k.priv);
    const subs = (await q('SELECT endpoint, sub FROM push_subs')).rows;
    await Promise.all(subs.map(s => wp.sendNotification(s.sub, JSON.stringify({ title, body, url }), { TTL: 86400, urgency: 'high' })
      .catch(e => { if (e.statusCode === 404 || e.statusCode === 410) return q('DELETE FROM push_subs WHERE endpoint=$1', [s.endpoint]); console.error('push', e.statusCode, e.body); })));
  } catch (e) { console.error('notify', e); }
}


/* ---------- Paiements : un seul chemin de confirmation, et un filet de sécurité ---------- */
/* Confirme une réservation payée. Appelé par le webhook Stripe, par la page de retour et par la vérification automatique. */
async function confirmBooking(id, sess) {
  let r;
  try { r = await q("UPDATE bookings SET status='confirmed', confirmed_at=now(), hold_expires_at=NULL WHERE id=$1 AND status IN ('held','expired') RETURNING *", [id]); }
  catch (e) { if (/bookings_no_overlap/.test(e.message)) return paidButTaken(id, sess); throw e; }
  const b = r.rows[0] || (await q('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
  if (!b) return null;
  await q("INSERT INTO payments (booking_id, provider, provider_ref, amount_cents, status, verified_at) VALUES ($1,'card',$2,$3,'succeeded',now()) ON CONFLICT (provider, provider_ref) DO NOTHING", [b.id, String((sess && (sess.payment_intent || sess.id)) || b.checkout_ref), (sess && sess.amount_total) || b.deposit_cents]).catch(e => console.error('payments', e));
  for (const lead of [1440, 120]) await q("INSERT INTO reminders (booking_id, channel, lead_minutes, send_at) VALUES ($1,'email',$2, $3::timestamptz - make_interval(mins => $2::int)) ON CONFLICT DO NOTHING", [b.id, lead, b.starts_at]).catch(e => console.error('reminders', e));
  if (r.rows[0]) {   // première confirmation : on prévient tout le monde, sans jamais bloquer la confirmation elle-même
    await mailBookingConfirmed(b).catch(e => console.error('mail confirm', e));
    await promoUsed(b).catch(() => {});
    await notify('Acompte payé · rendez-vous confirmé', `${b.client_name || 'Une cliente'} · ${(b.snapshot || {}).label || ''} · ${fmtWhen(new Date(b.starts_at))} · acompte ${eur(b.deposit_cents)}`, '/gestion?tab=plan');
    if (/^q:/.test(b.idempotency_key || '')) await q("UPDATE requests SET status='quote_accepted', updated_at=now() WHERE id=$1", [b.idempotency_key.slice(2)]).catch(() => {});
  }
  return b;
}
/* Cas rare : le paiement arrive alors que le créneau a été repris entre-temps → remboursement automatique et explications */
async function paidButTaken(id, sess) {
  const b = (await q('SELECT * FROM bookings WHERE id=$1', [id])).rows[0]; if (!b) return null;
  if ((b.snapshot || {}).cancel) return b;
  let refunded = false;
  try { const pi = (sess && sess.payment_intent) || (await stripe('/checkout/sessions/' + b.checkout_ref, null, 'GET')).payment_intent; if (pi) { await stripe('/refunds', { payment_intent: pi, reason: 'requested_by_customer', metadata: { booking_id: b.id } }); refunded = true; } } catch (e) { console.error('refund taken', e); }
  await q("UPDATE bookings SET status='cancelled', cancelled_at=now(), snapshot = COALESCE(snapshot,'{}'::jsonb) || jsonb_build_object('reconciled', true, 'cancel', jsonb_build_object('refunded', $2::boolean, 'amount', $3::int, 'at', now(), 'by', 'system', 'reason', 'slot_taken')) WHERE id=$1", [b.id, refunded, b.deposit_cents]);
  const when = fmtWhen(new Date(b.starts_at)), dep = eur(b.deposit_cents);
  await sendMail({ to: b.contact_email, subject: 'Votre réservation n’a pas pu être enregistrée',
    html: layout('Créneau déjà repris', `<p>Bonjour ${esc(b.client_name || '')},</p><p>Votre paiement est arrivé trop tard : le créneau du <b>${esc(when)}</b> venait d’être réservé par quelqu’un d’autre.</p><p>${refunded ? `<b>Votre acompte de ${dep} vous est remboursé intégralement</b> (visible sous 5 à 10 jours ouvrés).` : `Nous vous remboursons votre acompte de ${dep} très rapidement.`}</p><p>Vous pouvez choisir un autre créneau sur <a href="${ENV.site}" style="color:#1A1A1A">blvnbraids.com</a>, ou nous écrire sur Instagram @blvn_braids.</p><p>Toutes nos excuses pour ce contretemps.<br>Blvn Braids</p>`),
    text: `Le créneau du ${when} venait d’être pris. ${refunded ? 'Votre acompte de ' + dep + ' est remboursé.' : ''}` }).catch(e => console.error(e));
  await notify(refunded ? 'Paiement remboursé : créneau déjà pris' : 'À REMBOURSER : créneau déjà pris', `${b.client_name || ''} · ${when} · ${dep} · ${b.contact_phone || ''}`, '/gestion?tab=plan');
  if (ENV.adminEmail) await sendMail({ to: ENV.adminEmail, subject: refunded ? 'Paiement remboursé automatiquement (créneau déjà pris)' : 'À rembourser : paiement reçu sur un créneau déjà pris',
    html: layout('Paiement sur un créneau déjà pris', rowsHtml([['Cliente', b.client_name || ''], ['Créneau', when], ['Acompte', dep + (refunded ? ' · remboursé automatiquement' : ' · À REMBOURSER dans Stripe')], ['E-mail', b.contact_email], ['Téléphone', b.contact_phone || '']])), text: `${b.client_name} · ${when} · ${dep}` }).catch(e => console.error(e));
  return (await q('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
}
/* Paiement commencé mais jamais terminé : on libère le créneau et on prévient la cliente ET la gérante (une seule fois) */
async function abandonBooking(id) {
  const r = await q(`UPDATE bookings SET status = 'expired', snapshot = COALESCE(snapshot,'{}'::jsonb) || '{"reconciled":true,"abandoned":true}'::jsonb
    WHERE id=$1 AND status IN ('held','expired') AND COALESCE(snapshot->>'abandoned','') = '' RETURNING *`, [id]);
  const b = r.rows[0]; if (!b) return null;
  const when = fmtWhen(new Date(b.starts_at)), label = (b.snapshot || {}).label || 'votre prestation';
  await sendMail({ to: b.contact_email, subject: 'Votre réservation n’a pas été finalisée',
    html: layout('Paiement non abouti', `<p>Bonjour ${esc(b.client_name || '')},</p><p>Votre réservation pour <b>${esc(label)}</b>, le <b>${esc(when)}</b>, n’a pas été finalisée : le paiement de l’acompte n’est pas allé jusqu’au bout.</p><p><b>Aucun montant n’a été débité</b> et le créneau a été libéré.</p><p>Pour réserver, recommencez sur <a href="${ENV.site}" style="color:#1A1A1A">blvnbraids.com</a>. Si un message d’erreur s’est affiché ou si vous avez un doute, répondez à cet e-mail ou écrivez-nous sur Instagram @blvn_braids : on vous aide.</p><p>Blvn Braids</p>`),
    text: `Votre réservation du ${when} n’a pas été finalisée : aucun montant débité, créneau libéré. Recommencez sur ${ENV.site}.` }).catch(e => console.error(e));
  await notify('Paiement non abouti', `${b.client_name || 'Une cliente'} · ${label} · ${when} · ${b.contact_phone || ''}`, '/gestion?tab=plan');
  if (ENV.adminEmail) await sendMail({ to: ENV.adminEmail, subject: `Paiement non abouti · ${b.client_name || ''} · ${when}`,
    html: layout('Une réservation n’a pas abouti', rowsHtml([['Cliente', b.client_name || ''], ['Prestation', label], ['Créneau souhaité', when], ['Acompte prévu', eur(b.deposit_cents)], ['E-mail', b.contact_email], ['Téléphone', b.contact_phone || '']]) + '<p>La cliente a commencé à payer puis n’a pas terminé. Aucun montant n’a été débité, le créneau est de nouveau libre. Elle a reçu un e-mail d’explication : vous pouvez la recontacter.</p>'),
    text: `${b.client_name} · ${label} · ${when} : paiement non abouti.` }).catch(e => console.error(e));
  return b;
}
/* Filet de sécurité : on interroge Stripe pour chaque paiement en attente. Un paiement réussi est toujours confirmé, même si Stripe n’a pas pu nous prévenir. */
async function reconcile() {
  const out = { confirmed: 0, abandoned: 0 };
  let rows; try { rows = (await q("SELECT * FROM bookings WHERE checkout_ref IS NOT NULL AND status IN ('held','expired') AND created_at > now() - interval '48 hours' AND COALESCE(snapshot->>'reconciled','') = '' ORDER BY created_at DESC LIMIT 12")).rows; } catch (e) { console.error('reconcile', e); return out; }
  for (const b of rows) {
    try {
      const sess = await stripe('/checkout/sessions/' + b.checkout_ref, null, 'GET');
      if (sess.payment_status === 'paid') { const r = await confirmBooking(b.id, sess); if (r && r.status === 'confirmed') out.confirmed++; }
      else if (sess.status === 'expired' || b.status === 'expired' || (b.hold_expires_at && new Date(b.hold_expires_at).getTime() < Date.now() - 120000)) { if (await abandonBooking(b.id)) out.abandoned++; }
    } catch (e) { console.error('reconcile one', b.id, e.message); }
  }
  return out;
}
/* La même cliente a-t-elle déjà quelque chose sur ce créneau ? */
async function sameClientAt(start, end, email, phone) {
  const r = await q("SELECT * FROM bookings WHERE status IN ('held','confirmed') AND starts_at < $2 AND ends_at > $1 AND (lower(contact_email) = lower($3) OR ($4 <> '' AND right(regexp_replace(contact_phone,'\\D','','g'),9) = $4)) ORDER BY (status='confirmed') DESC, created_at DESC LIMIT 1", [start, end, String(email || '').trim(), digits(phone)]);
  return r.rows[0] || null;
}


/* ---------- Agenda et rappels de la gérante ---------- */
const icalToken = () => crypto.createHmac('sha256', process.env.QUOTE_SECRET || ENV.adminToken || 'blvn').update('ical-feed').digest('hex').slice(0, 40);
const icalUrl = () => `${ENV.site}/api/calendar?k=${icalToken()}`;
/* Rappels sur le téléphone de la gérante : avant chaque rendez-vous, et récap du matin */
async function adminReminders(set) {
  const out = { before: 0, morning: false }, cfg = set.adminReminder || {}, lead = Math.round(+cfg.lead_minutes || 0);
  if (lead > 0) {
    const due = await q(`UPDATE bookings SET snapshot = COALESCE(snapshot,'{}'::jsonb) || '{"adminReminded":true}'::jsonb
      WHERE status='confirmed' AND starts_at > now() AND starts_at <= now() + make_interval(mins => $1::int) AND COALESCE(snapshot->>'adminReminded','') = '' RETURNING *`, [lead]);
    for (const b of due.rows) {
      const mins = Math.max(1, Math.round((new Date(b.starts_at).getTime() - Date.now()) / 60000)), hm = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(b.starts_at));
      await notify(`⏰ Rendez-vous dans ${mins >= 60 ? dur(Math.round(mins / 5) * 5) : mins + ' min'}`, `${b.client_name || 'Cliente'} · ${(b.snapshot || {}).label || ''} · ${hm} · ${b.at_home ? 'à domicile' : 'chez vous'} · reste ${eur(b.balance_cents)}`, '/gestion?tab=plan');
      out.before++;
    }
  }
  if (cfg.morning !== false) {   // un seul récap par jour, entre 8 h et 9 h (heure de Paris)
    const now = new Date(), hour = +new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now), ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
    if (hour === 8) {
      const first = await q(`INSERT INTO public_settings (key, value) VALUES ('admin_morning_last', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE public_settings.value IS DISTINCT FROM EXCLUDED.value RETURNING key`, [JSON.stringify(ymd)]);
      if (first.rows[0]) {
        const day = await q("SELECT starts_at, client_name, snapshot->>'label' AS label FROM bookings WHERE status='confirmed' AND starts_at >= $1 AND starts_at < $2 ORDER BY starts_at", [parisDate(ymd, '00:00'), new Date(parisDate(ymd, '23:59').getTime() + 60000)]);
        const hm = x => new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }).format(new Date(x));
        if (day.rows.length) { await notify(`Aujourd’hui : ${day.rows.length} rendez-vous`, day.rows.map(r => `${hm(r.starts_at)} ${r.client_name || ''}`).join(' · ').slice(0, 180), '/gestion?tab=plan'); out.morning = true; }
      }
    }
  }
  return out;
}
/* Agenda au format iCalendar : s’abonne une fois dans l’appli Calendrier, se met à jour tout seul */
async function icalFeed(set) {
  const lead = Math.round(+(set.adminReminder || {}).lead_minutes || 0);
  const rows = (await q("SELECT * FROM bookings WHERE status IN ('confirmed','completed') AND starts_at > now() - interval '30 days' ORDER BY starts_at LIMIT 500")).rows;
  const z = d => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const tx = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
  const fold = line => { const out = []; let s = line; while (Buffer.byteLength(s) > 73) { let n = 73; while (Buffer.byteLength(s.slice(0, n)) > 73) n--; out.push(s.slice(0, n)); s = ' ' + s.slice(n); } out.push(s); return out.join('\r\n'); };
  const L_ = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Blvn Braids//Gestion//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Blvn Braids · Rendez-vous', 'X-WR-TIMEZONE:Europe/Paris', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M', 'X-PUBLISHED-TTL:PT15M'];
  for (const b of rows) {
    const sn = b.snapshot || {}, start = new Date(b.starts_at), end = new Date(start.getTime() + (b.duration_min || 60) * 60000);
    const where = b.at_home ? ((a => a ? [a.line1 || a.address, a.postcode, a.city].filter(Boolean).join(' ') : 'À domicile')(b.intervention_address) || 'À domicile') : 'Chez moi';
    const desc = [`Cliente : ${b.client_name || ''}`, `Téléphone : ${b.contact_phone || ''}`, `E-mail : ${b.contact_email || ''}`, `Prestation : ${sn.label || ''}`, ...(sn.summary || []), `Total : ${eur(b.total_cents)} · acompte payé : ${eur(b.deposit_cents)} · reste : ${eur(b.balance_cents)}`, b.client_note ? `Mot de la cliente : ${b.client_note}` : ''].filter(Boolean).join('\n');
    L_.push('BEGIN:VEVENT', `UID:${b.id}@blvnbraids.com`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(start)}`, `DTEND:${z(end)}`, `SUMMARY:${tx(`${b.client_name || 'Cliente'} · ${sn.label || 'Rendez-vous'}`)}`, `LOCATION:${tx(where)}`, `DESCRIPTION:${tx(desc)}`, 'STATUS:CONFIRMED');
    if (lead > 0 && b.status === 'confirmed') L_.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${tx(`Rendez-vous : ${b.client_name || ''}`)}`, `TRIGGER:-PT${lead}M`, 'END:VALARM');
    L_.push('END:VEVENT');
  }
  L_.push('END:VCALENDAR');
  return L_.map(fold).join('\r\n') + '\r\n';
}

/* ---------- Annulation (par la gérante ou par la cliente) ---------- */
const cancelToken = id => crypto.createHmac('sha256', process.env.QUOTE_SECRET || ENV.adminToken || 'blvn').update('cancel:' + id).digest('hex').slice(0, 32);
const cancelLink = id => `${ENV.site}/api/cancel?b=${encodeURIComponent(id)}&t=${cancelToken(id)}`;
async function cancelBooking(cur, { refund = false, noShow = false, by = 'admin', message = '' } = {}) {
  let refunded = false;
  if (refund && cur.status === 'confirmed' && cur.checkout_ref && cur.deposit_cents > 0) {
    const sess = await stripe('/checkout/sessions/' + cur.checkout_ref, null, 'GET');
    if (!sess.payment_intent) throw new Error('paiement introuvable');
    await stripe('/refunds', { payment_intent: sess.payment_intent, reason: 'requested_by_customer', metadata: { booking_id: cur.id } });
    refunded = true;
  }
  await q("UPDATE bookings SET status='cancelled', cancelled_at=now(), snapshot = COALESCE(snapshot, '{}'::jsonb) || jsonb_build_object('cancel', jsonb_build_object('refunded', $2::boolean, 'amount', $3::int, 'at', now(), 'noShow', $4::boolean, 'by', $5::text)) WHERE id=$1", [cur.id, refunded, cur.deposit_cents, !!noShow, by]);
  await q("UPDATE reminders SET status='cancelled' WHERE booking_id=$1", [cur.id]);
  // le code promo éventuel redevient utilisable
  const pr = (cur.snapshot || {}).promo; if (pr && pr.code) await q('UPDATE promo_codes SET used_at=NULL, used_booking_id=NULL WHERE code=$1 AND used_booking_id=$2', [pr.code, cur.id]).catch(() => {});
  const when = fmtWhen(new Date(cur.starts_at)), dep = eur(cur.deposit_cents), paid = cur.status === 'confirmed' && cur.deposit_cents > 0;
  const money = !paid ? '' : noShow ? `<p>Vous ne vous êtes pas présentée au rendez-vous : conformément aux conditions acceptées lors de la réservation, l’acompte de ${dep} est conservé.</p>` : refunded
    ? `<p><b>Votre acompte de ${dep} vous est remboursé intégralement.</b> Le remboursement est lancé aujourd’hui et apparaît sur votre moyen de paiement sous 5 à 10 jours ouvrés, selon votre banque.</p>`
    : `<p>Conformément aux conditions d’annulation acceptées lors de la réservation (moins de 24 h avant le rendez-vous), l’acompte de ${dep} n’est pas remboursé.</p>`;
  const who = by === 'client' ? 'Vous avez annulé votre rendez-vous' : 'Votre rendez-vous a été annulé';
  await sendMail({ to: cur.contact_email, subject: 'Votre rendez-vous a été annulé',
    html: layout('Rendez-vous annulé', `<p>Bonjour ${esc(cur.client_name || '')},</p><p>${who} du <b>${esc(when)}</b>.</p>${message ? `<p>${esc(message)}</p>` : ''}${money}<p>Vous pouvez reprendre rendez-vous à tout moment sur <a href="${ENV.site}" style="color:#1A1A1A">blvnbraids.com</a>. Pour toute question, répondez à cet e-mail ou écrivez-nous sur Instagram @blvn_braids.</p><p>Blvn Braids</p>`),
    text: `${who} du ${when}. ${message || ''} ${!paid ? '' : noShow ? `Acompte de ${dep} conservé.` : refunded ? `Votre acompte de ${dep} est remboursé (visible sous 5 à 10 jours ouvrés).` : `L’acompte de ${dep} n’est pas remboursé.`}` });
  if (by === 'client') await notify('Annulation par une cliente', `${cur.client_name || 'Une cliente'} · ${when} · acompte ${paid ? (refunded ? 'remboursé' : 'conservé') : '—'}`, '/gestion?tab=plan');
  if (by === 'client' && ENV.adminEmail) await sendMail({ to: ENV.adminEmail, subject: `Annulation par la cliente · ${when}`,
    html: layout('Une cliente a annulé', rowsHtml([['Cliente', cur.client_name || ''], ['Rendez-vous', when], ['Prestation', (cur.snapshot || {}).label || ''], ['Acompte', paid ? (refunded ? `${dep} remboursé automatiquement` : `${dep} conservé (moins de 24 h)`) : '—'], ['E-mail', cur.contact_email], ['Téléphone', cur.contact_phone || '']]) + '<p>Le créneau est de nouveau disponible sur le site.</p>'),
    text: `${cur.client_name} a annulé son rendez-vous du ${when}.` }).catch(e => console.error(e));
  return { refunded };
}

/* ---------- Stripe (API REST, sans dépendance) ---------- */
async function stripe(path, params, method = 'POST') {
  if (ENV.dryRun) return { id: 'cs_test_dryrun_' + crypto.randomBytes(6).toString('hex'), url: ENV.site + '/?paid=cs_test_dryrun', payment_status: 'paid', payment_intent: 'pi_dryrun', metadata: params ? Object.fromEntries(Object.entries(params).filter(([k]) => k.startsWith('metadata[')).map(([k, v]) => [k.slice(9, -1), v])) : {} };
  const body = params ? new URLSearchParams(flatten(params)).toString() : undefined;
  const r = await fetch('https://api.stripe.com/v1' + path, { method, headers: { authorization: 'Bearer ' + ENV.stripeKey, 'content-type': 'application/x-www-form-urlencoded' }, body });
  const j = await r.json(); if (!r.ok) throw new Error('Stripe: ' + (j.error && j.error.message || r.status)); return j;
}
function flatten(o, prefix = '', out = {}) { for (const [k, v] of Object.entries(o)) { const key = prefix ? `${prefix}[${k}]` : k; if (v && typeof v === 'object') flatten(v, key, out); else if (v != null) out[key] = String(v); } return out; }
function verifyStripeSignature(rawBody, header) {
  if (ENV.dryRun) return JSON.parse(rawBody);
  const parts = Object.fromEntries((header || '').split(',').map(p => p.split('=')));
  const expected = crypto.createHmac('sha256', ENV.stripeWebhook).update(`${parts.t}.${rawBody}`).digest('hex');
  const given = Buffer.from(parts.v1 || '', 'hex'), exp = Buffer.from(expected, 'hex');
  if (given.length !== exp.length || !crypto.timingSafeEqual(given, exp)) throw new Error('Signature Stripe invalide');
  if (Math.abs(Date.now() / 1000 - +parts.t) > 300) throw new Error('Signature Stripe expirée');
  return JSON.parse(rawBody);
}

/* ---------- E-mails (Resend) ---------- */
async function sendMail({ to, subject, html, text, attachments }) {
  if (!ENV.resendKey || ENV.dryRun) { (global.__mails ||= []).push({ to, subject, text }); return { id: 'dry' }; }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + ENV.resendKey, 'content-type': 'application/json' }, body: JSON.stringify({ from: ENV.from, to: [].concat(to), subject, html, text, reply_to: ENV.adminEmail, ...(attachments ? { attachments } : {}) }) });
  if (!r.ok) console.error('Resend', r.status, await r.text());
  return r.ok;
}
const layout = (title, inner) => `<!doctype html><html lang="fr"><body style="margin:0;background:#FF5A5F;padding:24px;font-family:Arial,Helvetica,sans-serif;color:#1A1A1A">
<div style="max-width:560px;margin:0 auto;background:#FAFAFA;border-radius:22px;padding:28px">
<p style="margin:0 0 4px;font-size:26px;font-style:italic">Blvn Braids</p><p style="margin:0 0 22px;font-size:11px;letter-spacing:.3em">HAIRSTYLIST</p>
<h1 style="font-size:22px;font-weight:normal;margin:0 0 16px">${esc(title)}</h1>${inner}
<p style="margin:26px 0 0;font-size:12px;color:#666">Paris · Instagram @blvn_braids</p></div></body></html>`;
const rowsHtml = rows => `<table style="width:100%;border-collapse:collapse;font-size:15px">${rows.map(([k, v]) => `<tr><td style="padding:7px 0;color:#555;border-bottom:1px solid #eee">${esc(k)}</td><td style="padding:7px 0;text-align:right;border-bottom:1px solid #eee"><b>${esc(v)}</b></td></tr>`).join('')}</table>`;

function bookingRows(b) {
  const sn = b.snapshot || {};
  return [['Prestation', sn.label], ['Date', fmtWhen(new Date(b.starts_at))], ['Durée prévue', dur(b.duration_min)], ...(b.at_home ? [['Lieu', 'À domicile — ' + (b.intervention_address && b.intervention_address.text || '')]] : [['Lieu', 'Chez la coiffeuse (adresse communiquée par message)']]), ['Total', eur(b.total_cents)], ['Acompte payé', eur(b.deposit_cents)], ['Reste à régler le jour J', eur(b.balance_cents)]];
}
async function mailBookingConfirmed(b) {
  const rows = bookingRows(b), sn = b.snapshot || {};
  const details = (sn.summary || []).length ? `<p style="margin:16px 0 6px;color:#555">Vos choix</p><ul style="margin:0;padding-left:18px">${sn.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const priced = (sn.lines || []).filter(x => x && x[1] != null);
  const breakdown = priced.length > 1 ? `<p style="margin:16px 0 6px;color:#555">Détail du tarif</p>${rowsHtml(priced.map((x, i) => [(i && /^(Grosseur|Longueur) · /.test(x[0]) ? 'Supplément ' + x[0].charAt(0).toLowerCase() + x[0].slice(1) : x[0]), eur(x[1])]))}` : '';
  await sendMail({ to: b.contact_email, subject: `Rendez-vous confirmé · ${fmtWhen(new Date(b.starts_at))}`,
    html: layout('Votre rendez-vous est confirmé', `<p>Bonjour ${esc(b.client_name || '')},</p><p>Merci pour votre réservation. Voici le récapitulatif :</p>${rowsHtml(rows)}${breakdown}${details}<p style="margin-top:18px">Merci de venir avec les cheveux <b>impérativement propres</b>. Le démêlage préalable n’est pas obligatoire.</p><p>Vous recevrez un rappel la veille et 2 h avant.</p><p style="font-size:14px">Un empêchement ? <a href="${cancelLink(b.id)}" style="color:#1A1A1A"><b>Annuler mon rendez-vous</b></a>. Jusqu’à 24 h avant, votre acompte est remboursé automatiquement ; moins de 24 h avant, il est conservé.</p><div style="margin:22px 0;padding:18px 20px;border:1.5px solid #1A1A1A;border-radius:18px"><p style="margin:0 0 8px"><b>Une dernière petite étape</b></p><p style="margin:0 0 14px">Laissez-nous un message sur Instagram avec votre <b>prénom</b>, la <b>date</b> de votre rendez-vous et une <b>photo du modèle souhaité</b>. La coiffeuse vous recontacte pour confirmer et vous envoyer l’adresse et les infos pratiques. Petit rappel aussi la veille.</p><a href="https://ig.me/m/blvn_braids" style="display:inline-block;background:#1A1A1A;color:#FAFAFA;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:bold">Écrire sur Instagram</a><p style="margin:10px 0 0;font-size:13px;color:#555">Conseillé, pas obligatoire : votre rendez-vous est déjà confirmé.</p></div><p>Pour toute question, répondez simplement à cet e-mail.</p><p>À très vite,<br>Blvn Braids</p>`),
    text: `Rendez-vous confirmé\n${rows.map(r => r.join(' : ')).join('\n')}\n${(sn.summary || []).join('\n')}\n\nUne dernière petite étape : laissez-nous un message sur Instagram (@blvn_braids, https://ig.me/m/blvn_braids) avec votre prénom, la date de votre rendez-vous et une photo du modèle souhaité. La coiffeuse vous recontacte pour confirmer et vous envoyer l’adresse.` });
  if (ENV.adminEmail) await sendMail({ to: ENV.adminEmail, subject: `Nouvelle réservation · ${b.client_name} · ${fmtWhen(new Date(b.starts_at))}`,
    html: layout('Nouvelle réservation payée', rowsHtml([...rows, ['Cliente', b.client_name], ['E-mail', b.contact_email], ['Téléphone', b.contact_phone], ...(b.client_note ? [['Mot de la cliente', b.client_note]] : [])]) + ((sn.summary || []).length ? `<ul>${sn.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '')),
    text: `Nouvelle réservation\n${rows.map(r => r.join(' : ')).join('\n')}\nCliente : ${b.client_name} ${b.contact_email} ${b.contact_phone}` });
}
async function mailRequest(r, p) {
  await notify('Nouvelle demande de tarif', `${r.client_name || 'Une cliente'} · ${p.label || ''}${r.desired_starts_at ? ' · ' + fmtWhen(new Date(r.desired_starts_at)) : ''}`, '/gestion?tab=todo');
  const when = r.desired_starts_at ? fmtWhen(new Date(r.desired_starts_at)) : 'à définir';
  await sendMail({ to: r.contact_email, subject: 'Votre demande de rendez-vous est bien reçue',
    html: layout('Demande bien reçue', `<p>Bonjour ${esc(r.client_name || '')},</p><p>Votre demande pour <b>${esc(p.label)}</b> (créneau souhaité : ${esc(when)}) est arrivée chez la coiffeuse. Certains montants doivent encore être confirmés : vous recevrez le tarif et la durée par e-mail avant tout paiement. <b>Aucun acompte n’est demandé pour l’instant</b> et le créneau n’est pas encore réservé.</p>${p.summary.length ? `<ul>${p.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}<p>Blvn Braids</p>`),
    text: `Demande reçue pour ${p.label}, créneau souhaité : ${when}. Tarif et durée à confirmer avant tout paiement.` });
  if (ENV.adminEmail) await sendMail({ to: ENV.adminEmail, subject: `Demande à traiter · ${r.client_name} · ${p.label}`,
    html: layout('Demande de tarif à traiter', rowsHtml([['Prestation', p.label], ['Créneau souhaité', when], ['Cliente', r.client_name], ['E-mail', r.contact_email], ['Téléphone', r.contact_phone]]) + `<p>Lignes :</p><ul>${p.lines.map(l => `<li>${esc(l[0])} : ${l[1] == null ? 'à confirmer' : eur(l[1])}</li>`).join('')}</ul><ul>${p.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul>${r.description ? `<p>Mot de la cliente : ${esc(r.description)}</p>` : ''}<p><a href="${ENV.site}/?admin=1">Ouvrir l’administration</a></p>`),
    text: `Demande à traiter : ${p.label}, ${r.client_name}, ${r.contact_email}, ${r.contact_phone}` });
}
async function mailReminder(b, lead) {
  const when = fmtWhen(new Date(b.starts_at));
  await sendMail({ to: b.contact_email, subject: lead === 1440 ? `Rappel : votre rendez-vous demain · ${when}` : `C’est dans 2 h : ${when}`,
    html: layout(lead === 1440 ? 'À demain !' : 'À tout à l’heure !', `<p>Bonjour ${esc(b.client_name || '')},</p><p>Petit rappel : votre rendez-vous <b>${esc((b.snapshot || {}).label || '')}</b> est prévu ${esc(when)}.</p><p>Cheveux impérativement propres, démêlage non obligatoire. Reste à régler sur place : <b>${eur(b.balance_cents)}</b>.</p><p>Un empêchement ? <a href="${cancelLink(b.id)}" style="color:#1A1A1A"><b>Annuler mon rendez-vous</b></a>${lead === 1440 ? ' (moins de 24 h avant : l’acompte est conservé)' : ''}, ou répondez à cet e-mail.</p><p>Blvn Braids</p>`),
    text: `Rappel : rendez-vous ${when}. Reste à régler : ${eur(b.balance_cents)}.` });
}

/* Lien de paiement personnel envoyé avec un tarif : signé, impossible à deviner */
const quoteToken = id => crypto.createHmac('sha256', process.env.QUOTE_SECRET || ENV.adminToken || 'blvn').update('quote:' + id).digest('hex').slice(0, 32);
const quoteLink = id => `${ENV.site}/api/quote-pay?r=${encodeURIComponent(id)}&t=${quoteToken(id)}`;

/* Galerie et avis du site : les deux tables sont créées toutes seules à la première utilisation (aucun script à lancer). */
let siteReady;
const ensureSite = () => (siteReady ||= q(`
  CREATE TABLE IF NOT EXISTS site_gallery (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, category text, description text,
    mime text NOT NULL, data text NOT NULL, sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS site_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author text NOT NULL, rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5), comment text NOT NULL,
    admin_reply text, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','published','hidden')), source text NOT NULL DEFAULT 'client', created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS site_variant_photos (
    variant_id uuid PRIMARY KEY, mime text NOT NULL, data text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS promo_codes (
    code text PRIMARY KEY, kind text NOT NULL CHECK (kind IN ('loyalty','referral_gift','referral_thanks')),
    owner_email text NOT NULL, owner_name text, amount_cents integer NOT NULL DEFAULT 500,
    created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now() + interval '6 months',
    used_at timestamptz, used_booking_id uuid, source_booking_id uuid);
  CREATE INDEX IF NOT EXISTS promo_codes_owner ON promo_codes (lower(owner_email));
  CREATE TABLE IF NOT EXISTS rate_hits (bucket text NOT NULL, at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX IF NOT EXISTS rate_hits_idx ON rate_hits (bucket, at);
  CREATE TABLE IF NOT EXISTS site_feedback (
    key text PRIMARY KEY, rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 4), issues jsonb NOT NULL DEFAULT '[]'::jsonb, comment text,
    stage text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS push_keys (id integer PRIMARY KEY, public_key text NOT NULL, private_key text NOT NULL);
  CREATE TABLE IF NOT EXISTS push_subs (endpoint text PRIMARY KEY, sub jsonb NOT NULL, label text, created_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE site_gallery ENABLE ROW LEVEL SECURITY; ALTER TABLE site_reviews ENABLE ROW LEVEL SECURITY; ALTER TABLE site_variant_photos ENABLE ROW LEVEL SECURITY;
  ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY; ALTER TABLE push_keys ENABLE ROW LEVEL SECURITY; ALTER TABLE push_subs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE site_feedback ENABLE ROW LEVEL SECURITY; ALTER TABLE rate_hits ENABLE ROW LEVEL SECURITY;
`).catch(e => { siteReady = null; throw e; }));
const parseImage = dataUrl => { const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || ''); return m && m[2].length <= 3000000 ? { mime: m[1], data: m[2] } : null; };

/* Comparaison à temps constant : on ne peut pas deviner le mot de passe caractère par caractère */
const sameSecret = (a, b) => { const x = crypto.createHash('sha256').update(String(a || '')).digest(), y = crypto.createHash('sha256').update(String(b || '')).digest(); return crypto.timingSafeEqual(x, y); };
const isAdmin = ev => !!ENV.adminToken && sameSecret(ev.headers['x-admin-token'] || ev.headers['X-Admin-Token'] || '', ENV.adminToken);
const clientIp = ev => String((ev.headers || {})['x-nf-client-connection-ip'] || ((ev.headers || {})['x-forwarded-for'] || '').split(',')[0] || 'inconnue').trim().slice(0, 60);
/* Limiteur simple : true si ce « seau » a dépassé max essais sur la période */
async function tooMany(bucket, max, minutes, record = true) {
  try { await ensureSite();
    const n = (await q('SELECT count(*)::int AS n FROM rate_hits WHERE bucket=$1 AND at > now() - make_interval(mins => $2::int)', [bucket, minutes])).rows[0].n;
    if (n >= max) return true;
    if (record) await q('INSERT INTO rate_hits (bucket) VALUES ($1)', [bucket]);
    if (Math.random() < 0.02) await q("DELETE FROM rate_hits WHERE at < now() - interval '2 days'").catch(() => {});
    return false;
  } catch (e) { console.error('rate', e); return false; }   // en cas de souci technique, on ne bloque pas le site
}

module.exports = { ENV, q, json, bad, eur, dur, esc, settings, catalog, price, availability, parisDate, fmtWhen, stripe, verifyStripeSignature, sendMail, mailBookingConfirmed, mailRequest, mailReminder, isAdmin, clientIp, tooMany, crypto, layout, rowsHtml, quoteToken, quoteLink, ensureSite, parseImage, monthCalendar, notify, vapid, confirmBooking, abandonBooking, reconcile, sameClientAt, icalToken, icalUrl, icalFeed, adminReminders, sameSecret, checkPromo, promoUsed, promoLabel, issueCodesOnComplete, basePriceOf, cancelBooking, cancelToken, cancelLink, PROMO_MIN, PROMO_RULE };
