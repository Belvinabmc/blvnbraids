/* Sert une photo de la galerie : /api/media?id=… */
const L = require('./_lib');
exports.handler = async ev => {
  const id = (ev.queryStringParameters || {}).id;
  if (!/^[0-9a-f-]{36}$/i.test(id || '')) return L.bad('Photo introuvable', 404);
  try {
    await L.ensureSite();
    const r = await L.q('SELECT mime, data FROM site_gallery WHERE id=$1', [id]);
    if (!r.rows[0]) return L.bad('Photo introuvable', 404);
    return { statusCode: 200, isBase64Encoded: true, headers: { 'content-type': r.rows[0].mime, 'cache-control': 'public, max-age=31536000, immutable' }, body: r.rows[0].data };
  } catch (e) { console.error(e); return L.bad('Photo indisponible', 500); }
};
