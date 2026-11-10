/* Contenu public du site : galerie et avis publiés. En POST : une cliente dépose un avis (publié après validation par la gérante). */
const L = require('./_lib');
exports.handler = async ev => {
  try {
    await L.ensureSite();
    if (ev.httpMethod === 'POST') {
      let b; try { b = JSON.parse(ev.body || '{}'); } catch { return L.bad('Requête illisible'); }
      if (b.website) return L.json(200, { ok: true });   // piège à robots
      const author = String(b.author || '').trim().slice(0, 60), comment = String(b.comment || '').trim().slice(0, 600), n = Math.round(+b.rating);
      if (author.length < 2 || comment.length < 5 || !(n >= 1 && n <= 5)) return L.bad('Indiquez votre prénom, une note et un commentaire');
      const recent = await L.q("SELECT count(*)::int AS n FROM site_reviews WHERE source='client' AND created_at > now() - interval '1 hour'");
      if (recent.rows[0].n >= 20) return L.bad('Trop d’avis reçus pour le moment, réessayez plus tard', 429);
      await L.q("INSERT INTO site_reviews (author, rating, comment, status, source) VALUES ($1,$2,$3,'pending','client')", [author, n, comment]);
      if (L.ENV.adminEmail) await L.sendMail({ to: L.ENV.adminEmail, subject: 'Nouvel avis à valider',
        html: L.layout('Nouvel avis à valider', L.rowsHtml([['De', author], ['Note', n + ' / 5']]) + `<p>« ${L.esc(comment)} »</p><p>Publiez-le ou supprimez-le depuis l’administration, onglet « Galerie et avis ».</p>`), text: `Avis de ${author} (${n}/5) : ${comment}` }).catch(() => {});
      return L.json(200, { ok: true });
    }
    const [g, r] = await Promise.all([
      L.q('SELECT id, title, category, description FROM site_gallery ORDER BY sort_order, created_at DESC LIMIT 60'),
      L.q("SELECT id, author, rating, comment, admin_reply FROM site_reviews WHERE status='published' ORDER BY created_at DESC LIMIT 60"),
    ]);
    return L.json(200, { gallery: g.rows, reviews: r.rows }, { 'cache-control': 'public, max-age=30' });
  } catch (e) { console.error(e); return L.bad('Contenu indisponible', 500); }
};
