/* Rappels aux clientes 24 h et 2 h avant, par e-mail ; rappels à la gérante sur son téléphone ; vérification des paiements. Lancé automatiquement toutes les 15 minutes (voir netlify.toml). */
const L = require('./_lib');
exports.handler = async () => {
  try { const ar = await L.adminReminders(await L.settings()); if (ar.before || ar.morning) console.log('rappels gérante', ar); } catch (e) { console.error('rappels gérante', e); }
  try { const rc = await L.reconcile(); if (rc.confirmed || rc.abandoned) console.log('reconcile', rc); } catch (e) { console.error('reconcile', e); }
  try {
    const due = await L.q(`SELECT b.*, r.id AS reminder_id, r.lead_minutes FROM reminders r JOIN bookings b ON b.id = r.booking_id
      WHERE r.status='scheduled' AND r.send_at <= now() AND r.send_at > now() - interval '6 hours' AND b.status='confirmed' ORDER BY r.send_at LIMIT 50`);
    for (const row of due.rows) { await L.mailReminder(row, row.lead_minutes); await L.q("UPDATE reminders SET status='sent', sent_at=now() WHERE id=$1", [row.reminder_id]); }
    await L.q("UPDATE reminders SET status='cancelled' WHERE status='scheduled' AND (send_at <= now() - interval '6 hours' OR booking_id IN (SELECT id FROM bookings WHERE status NOT IN ('confirmed')))");
    await L.q("UPDATE bookings SET status='expired' WHERE status='held' AND hold_expires_at < now()");
    return L.json(200, { sent: due.rows.length });
  } catch (e) { console.error(e); return L.bad('Erreur rappels', 500); }
};
