const L = require('./_lib');
exports.handler = async () => {
  try {
    const [c, set] = await Promise.all([L.catalog(), L.settings()]);
    return L.json(200, { ...c, depositRate: set.depositRate, contact: set.contact, travelFees: set.travelFees }, { 'cache-control': 'public, max-age=60' });
  } catch (e) { console.error(e); return L.bad('Catalogue indisponible', 500); }
};
