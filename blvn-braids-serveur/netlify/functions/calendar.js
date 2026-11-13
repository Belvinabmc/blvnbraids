/* Agenda de la gérante : lien secret à ajouter une fois dans l’appli Calendrier (iPhone, Google, Outlook). */
const L = require('./_lib');
exports.handler = async ev => {
  const k = (ev.queryStringParameters || {}).k || '';
  if (!L.sameSecret(k, L.icalToken())) return { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Agenda introuvable' };
  try {
    const body = await L.icalFeed(await L.settings());
    return { statusCode: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="blvn-braids.ics"', 'cache-control': 'no-store' }, body };
  } catch (e) { console.error(e); return { statusCode: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Agenda indisponible' }; }
};
