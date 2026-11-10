-- BLVN BRAIDS — mise à jour n° 2 de la base (à coller dans l'éditeur SQL de Supabase, une seule fois)
-- Prépare la base pour le serveur du site : choix avancés, références par modèle, horaires, frais, rappels.

-- Choix : nouveaux types de réponse, modèles concernés, conditions, prix (oui/non, nombre)
ALTER TABLE option_groups DROP CONSTRAINT IF EXISTS option_groups_kind_check;
ALTER TABLE option_groups ADD CONSTRAINT option_groups_kind_check CHECK (kind IN ('single','multi','text','number','photo','yesno'));
ALTER TABLE option_groups
  ADD COLUMN IF NOT EXISTS is_visible   boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS scope        jsonb   NOT NULL DEFAULT '{"mode":"all","ids":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS cond         jsonb,
  ADD COLUMN IF NOT EXISTS price_cents  integer CHECK (price_cents >= 0),
  ADD COLUMN IF NOT EXISTS unit_label   text,
  ADD COLUMN IF NOT EXISTS min_value    integer,
  ADD COLUMN IF NOT EXISTS max_value    integer,
  ADD COLUMN IF NOT EXISTS placeholder  text;
ALTER TABLE service_options ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true;

-- Modèles : grosseur et longueur comprises dans le prix (par modèle), en plus de la référence par prestation
ALTER TABLE service_variants
  ADD COLUMN IF NOT EXISTS reference_size   size_id,
  ADD COLUMN IF NOT EXISTS reference_length length_id;

-- Réservations : lien avec la session de paiement et le nom de la cliente
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS client_name     text,
  ADD COLUMN IF NOT EXISTS checkout_ref    text UNIQUE,
  ADD COLUMN IF NOT EXISTS confirmed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at    timestamptz;
ALTER TABLE requests
  ADD COLUMN IF NOT EXISTS client_name     text,
  ADD COLUMN IF NOT EXISTS desired_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS service_id      uuid REFERENCES services(id),
  ADD COLUMN IF NOT EXISTS variant_id      uuid REFERENCES service_variants(id),
  ADD COLUMN IF NOT EXISTS admin_price_cents integer,
  ADD COLUMN IF NOT EXISTS admin_duration_min integer,
  ADD COLUMN IF NOT EXISTS admin_message   text,
  ADD COLUMN IF NOT EXISTS answered_at     timestamptz;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- Horaires par défaut (à ajuster dans l'administration) : lundi → samedi, 9 h – 19 h
INSERT INTO working_hours (weekday, starts_at, ends_at)
SELECT d, '09:00', '19:00' FROM generate_series(1,6) AS d
WHERE NOT EXISTS (SELECT 1 FROM working_hours);

-- Réglages publics par défaut
INSERT INTO public_settings (key, value) VALUES
  ('deposit', '{"type":"percent","rate":45}'),
  ('hold_minutes', '30'),
  ('schedule_margins', '{"slot_step_min":30,"buffer_min":30,"min_notice_hours":24,"max_days_ahead":60}'),
  ('travel_fees', '{"75":1000,"92":1500,"93":1500,"94":1500,"77":2500,"78":2500,"91":2500,"95":2500}'),
  ('contact', '{"instagram":"blvn_braids","snapchat":""}')
ON CONFLICT (key) DO UPDATE SET value = COALESCE(public_settings.value, EXCLUDED.value);

-- Politique d'annulation : publiée avec un texte par défaut (à compléter dans l'administration)
UPDATE policy_versions SET body = '{"sections":[{"key":"cancellation","title":"Politique d’annulation","body":"L’acompte réserve votre créneau. Il est remboursé en cas d’annulation au moins 48 h avant le rendez-vous, et conservé au-delà. Un report est possible une fois, sans frais, avec le même préavis."}]}'::jsonb,
  published_at = COALESCE(published_at, now())
WHERE kind = 'cancellation' AND version = 1;

-- Lecture publique des horaires et réglages déjà prévue par RLS. Les nouvelles colonnes des choix sont couvertes par les règles existantes.
