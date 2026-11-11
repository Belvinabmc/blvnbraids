const L = require('./_lib');
exports.handler = async ev => {
  try {
    const p = ev.queryStringParameters || {};
    const set = await L.settings();
    const d = p.duration === '' || p.duration == null ? null : Math.max(15, Math.min(720, +p.duration || 0)) || null;
    /* Vue d’ensemble pour la cliente : pour chaque jour, seulement « possible » ou « pas possible » (aucun chiffre, aucun détail) */
    if (p.from) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from)) return L.bad('Date invalide');
      const n = Math.max(1, Math.min(62, +p.days || 21)), start = new Date(p.from + 'T12:00:00Z'), want = [];
      for (let i = 0; i < n; i++) want.push(new Date(start.getTime() + i * 86400000).toISOString().slice(0, 10));
      const months = [...new Set(want.map(x => x.slice(0, 7)))], all = [];
      for (const ym of months) all.push(...(await L.monthCalendar(ym, set, d || 180)).days);
      return L.json(200, { days: want.map(date => ({ date, open: (all.find(x => x.date === date) || {}).status === 'free' })) }, { 'cache-control': 'no-store' });
    }
    return L.json(200, await L.availability(p.date || '', d, set));
  } catch (e) { console.error(e); return L.bad('Créneaux indisponibles', 500); }
};
