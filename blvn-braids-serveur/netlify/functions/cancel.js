/* Annulation par la cliente, depuis le lien de son e-mail. Plus de 24 h avant : remboursement automatique. Moins : acompte conservé. */
const L = require('./_lib');
const page = (title, inner) => ({ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${L.esc(title)} – Blvn Braids</title></head>
<body style="margin:0;background:#FF5A5F;font-family:Arial,Helvetica,sans-serif;color:#1A1A1A;padding:20px"><div style="max-width:480px;margin:30px auto;background:#FAFAFA;border-radius:22px;padding:28px">
<p style="margin:0 0 4px;font-size:26px;font-style:italic">Blvn Braids</p><p style="margin:0 0 22px;font-size:11px;letter-spacing:.3em">HAIRSTYLIST</p>
<h1 style="font-size:22px;font-weight:normal;margin:0 0 14px">${L.esc(title)}</h1>${inner}
<p style="margin-top:22px;font-size:14px"><a href="${L.ENV.site}" style="color:#1A1A1A">blvnbraids.com</a> · Instagram <a href="https://ig.me/m/blvn_braids" style="color:#1A1A1A">@blvn_braids</a></p></div></body></html>` });
const row = (k, v) => `<tr><td style="padding:7px 0;color:#555;border-bottom:1px solid #e5e5e5">${k}</td><td style="padding:7px 0;text-align:right;font-weight:bold;border-bottom:1px solid #e5e5e5">${v}</td></tr>`;
const btn = (label, dark) => `<button type="submit" style="width:100%;margin-top:12px;padding:15px;border-radius:999px;border:2px solid #1A1A1A;background:${dark ? '#1A1A1A' : 'transparent'};color:${dark ? '#FAFAFA' : '#1A1A1A'};font-size:16px;font-weight:bold;cursor:pointer">${label}</button>`;
exports.handler = async ev => {
  const qs = ev.queryStringParameters || {}; let id = qs.b, t = qs.t, confirm = false;
  if (ev.httpMethod === 'POST') { const f = new URLSearchParams(ev.isBase64Encoded ? Buffer.from(ev.body || '', 'base64').toString() : (ev.body || '')); id = f.get('b'); t = f.get('t'); confirm = f.get('confirm') === '1'; }
  if (!id || !t || t !== L.cancelToken(id)) return page('Lien invalide', '<p>Ce lien d’annulation n’est pas valide. Répondez à votre e-mail de confirmation ou écrivez-nous sur Instagram.</p>');
  try {
    const b = (await L.q('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
    if (!b) return page('Rendez-vous introuvable', '<p>Ce rendez-vous n’existe pas ou plus.</p>');
    const when = L.fmtWhen(new Date(b.starts_at)), dep = L.eur(b.deposit_cents);
    if (b.status === 'cancelled') { const c = (b.snapshot || {}).cancel || {}; return page('Rendez-vous déjà annulé', `<p>Votre rendez-vous du <b>${L.esc(when)}</b> est déjà annulé.${c.refunded ? ` Votre acompte de ${dep} a été remboursé.` : ''}</p>`); }
    if (b.status !== 'confirmed') return page('Annulation impossible', '<p>Ce rendez-vous ne peut plus être annulé en ligne. Écrivez-nous sur Instagram @blvn_braids.</p>');
    const hours = (new Date(b.starts_at).getTime() - Date.now()) / 3600000;
    if (hours <= 0) return page('Rendez-vous passé', '<p>Ce rendez-vous est déjà passé et ne peut plus être annulé.</p>');
    const early = hours >= 24;
    if (!confirm) {
      const info = early
        ? `<p style="background:#e9f6ee;border:1.5px solid #1A1A1A;border-radius:14px;padding:12px 14px">Vous annulez <b>plus de 24 h avant</b> : votre acompte de <b>${dep}</b> vous sera <b>remboursé automatiquement</b> (visible sous 5 à 10 jours ouvrés).</p>`
        : `<p style="background:#fdf1e1;border:1.5px solid #1A1A1A;border-radius:14px;padding:12px 14px">Votre rendez-vous est dans <b>moins de 24 h</b> : conformément aux règles acceptées lors de la réservation, votre acompte de <b>${dep}</b> <b>ne sera pas remboursé</b>.</p>`;
      return page('Annuler mon rendez-vous', `<table style="width:100%;border-collapse:collapse;font-size:15px">${row('Prestation', L.esc((b.snapshot || {}).label || ''))}${row('Date', L.esc(when))}${row('Acompte payé', dep)}</table>${info}
<form method="post" action="/api/cancel"><input type="hidden" name="b" value="${L.esc(id)}"><input type="hidden" name="t" value="${L.esc(t)}"><input type="hidden" name="confirm" value="1">${btn(early ? 'Confirmer l’annulation et être remboursée' : 'Annuler quand même', true)}</form>
<a href="${L.ENV.site}" style="display:block;text-align:center;margin-top:14px;color:#1A1A1A">Garder mon rendez-vous</a>${early ? '' : '<p style="font-size:14px;margin-top:16px">Un imprévu ? Vous pouvez aussi nous écrire sur Instagram avant d’annuler.</p>'}`);
    }
    let r;
    try { r = await L.cancelBooking(b, { refund: early, by: 'client' }); }
    catch (e) { console.error('cancel', e); return page('Un souci technique', '<p>L’annulation n’a pas pu aboutir. Votre rendez-vous est toujours maintenu. Réessayez dans un instant ou écrivez-nous sur Instagram @blvn_braids.</p>'); }
    return page('Rendez-vous annulé', `<p>Votre rendez-vous du <b>${L.esc(when)}</b> est annulé. Un e-mail de confirmation vient de vous être envoyé.</p><p>${r.refunded ? `Votre acompte de <b>${dep}</b> est remboursé : il apparaîtra sur votre moyen de paiement sous 5 à 10 jours ouvrés.` : `L’acompte de ${dep} est conservé, conformément aux conditions d’annulation.`}</p><p>À bientôt, peut-être pour un autre créneau !</p>`);
  } catch (e) { console.error(e); return page('Un souci technique', '<p>Réessayez dans un instant, ou écrivez-nous sur Instagram @blvn_braids.</p>'); }
};
