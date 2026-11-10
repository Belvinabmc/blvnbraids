const L = require('./_lib');
exports.handler = async ev => {
  try {
    const p = ev.queryStringParameters || {};
    const set = await L.settings();
    const d = p.duration === '' || p.duration == null ? null : Math.max(15, Math.min(720, +p.duration || 0)) || null;
    return L.json(200, await L.availability(p.date || '', d, set));
  } catch (e) { console.error(e); return L.bad('Créneaux indisponibles', 500); }
};
