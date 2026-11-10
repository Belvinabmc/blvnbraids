# Blvn Braids — site de réservation

- `site/` : le site (page, programme, icônes, installation sur téléphone)
- `netlify/functions/` : le serveur (catalogue, créneaux, réservation, paiement Stripe, confirmation, rappels, administration)
- `db/` : scripts de la base Supabase (`0001` déjà exécuté, `0004` à exécuter une fois)

## Variables d’environnement (Netlify → Site configuration → Environment variables)

| Nom | Valeur |
|---|---|
| `DATABASE_URL` | adresse « Transaction pooler » de Supabase, avec le mot de passe |
| `STRIPE_SECRET_KEY` | `sk_test_…` (puis `sk_live_…` au lancement) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` du webhook `https://blvnbraids.com/api/stripe-webhook` |
| `RESEND_API_KEY` | `re_…` |
| `MAIL_FROM` | `Blvn Braids <rendezvous@blvnbraids.com>` |
| `ADMIN_EMAIL` | l’adresse qui reçoit les nouvelles réservations |
| `ADMIN_TOKEN` | mot de passe de l’administration (long, inventé) |
| `SITE_URL` | `https://blvnbraids.com` |

Ne jamais mettre ces valeurs dans le code ni sur GitHub.

## Administration
Ouvrir `https://blvnbraids.com/?admin=1`, onglet Admin, puis le mot de passe `ADMIN_TOKEN`.

## Règles
Montants en centimes côté serveur, acompte à 45 % (réglage `deposit`), créneau bloqué 33 min pendant le paiement, confirmation uniquement après paiement vérifié par Stripe, rappels e-mail 24 h et 2 h avant.

## Nouveautés (10 novembre 2026)
- `netlify/functions/quote-pay.js` : lien « Payer l’acompte et réserver » envoyé avec le tarif.
- `netlify/functions/identify.js` : reconnaissance de la photo d’inspiration (variable Netlify `ANTHROPIC_API_KEY` requise).
- `netlify/functions/photo-request.js` : envoi de la photo d’inspiration à la coiffeuse.
