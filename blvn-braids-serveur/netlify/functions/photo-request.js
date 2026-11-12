/* La cliente envoie sa photo d’inspiration à la coiffeuse (modèle absent ou proposition qui ne lui convient pas). */
const L = require('./_lib');
const email = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s || '');
const phone = s => /^\+?[0-9 .()-]{9,18}$/.test(s || '');
exports.handler = async ev => {
  if (ev.httpMethod !== 'POST') return L.bad('Méthode non autorisée', 405);
  let b; try { b = JSON.parse(ev.body || '{}'); } catch { return L.bad('Requête illisible'); }
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(b.image || '');
  if (!m) return L.bad('Photo manquante');
  if (m[2].length > 3000000) return L.bad('Photo trop lourde');
  if (!email(b.email) || !phone(b.phone)) return L.bad('E-mail ou téléphone invalide');
  if (!/^[a-z0-9]{8,40}$/i.test(b.key || '')) return L.bad('Requête invalide');
  const msg = String(b.msg || '').trim().slice(0, 500), sugg = b.suggestion && typeof b.suggestion === 'object' ? b.suggestion : null;
  try {
    const r = await L.q(`INSERT INTO requests (contact_email, contact_phone, status, category, description, answers, ai_suggestion, idempotency_key)
      VALUES ($1,$2,'to_verify','Photo d’inspiration',$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO UPDATE SET updated_at=now() RETURNING id, (xmax = 0) AS inserted`,
      [b.email.trim(), b.phone.trim(), msg || null, JSON.stringify({ label: 'Photo d’inspiration', photo: b.image, summary: [] }), sugg ? JSON.stringify(sugg) : null, 'ph:' + b.key]);
    if (r.rows[0].inserted) {
      await L.notify('Nouvelle photo d’inspiration', `${b.email.trim()}${sugg && sugg.style ? ' · ' + sugg.style : ''}`, '/gestion?tab=todo');
      const ext = m[1].split('/')[1].replace('jpeg', 'jpg');
      if (L.ENV.adminEmail) await L.sendMail({ to: L.ENV.adminEmail, subject: 'Nouvelle photo d’inspiration à traiter',
        html: L.layout('Photo d’inspiration reçue', L.rowsHtml([['E-mail', b.email.trim()], ['Téléphone', b.phone.trim()], ...(sugg && sugg.style ? [['Style reconnu par l’IA', sugg.style]] : []), ...(sugg && sugg.label ? [['Modèle proposé par l’IA', sugg.label]] : [])]) + (msg ? `<p>Message : ${L.esc(msg)}</p>` : '') + '<p>La photo est en pièce jointe. Répondez depuis l’administration (onglet « À traiter ») avec un tarif et une durée.</p>'),
        text: `Photo d’inspiration de ${b.email} (${b.phone}). ${msg}`, attachments: [{ filename: 'inspiration.' + ext, content: m[2] }] });
      await L.sendMail({ to: b.email.trim(), subject: 'Votre photo est bien arrivée',
        html: L.layout('Photo bien reçue', '<p>Bonjour,</p><p>Votre photo d’inspiration est arrivée chez la coiffeuse. Elle vérifie si elle réalise ce modèle et vous répond avec le tarif et la durée, par e-mail, avant tout paiement.</p><p>Vous pouvez aussi nous écrire sur Instagram @blvn_braids.</p><p>Blvn Braids</p>'),
        text: 'Votre photo est arrivée chez la coiffeuse. Réponse par e-mail avec tarif et durée.' });
    }
    return L.json(200, { ok: true });
  } catch (e) { console.error(e); return L.bad('Envoi impossible pour le moment', 500); }
};
