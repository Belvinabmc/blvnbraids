-- BLVN BRAIDS — installation complète de la base (à coller dans l'éditeur SQL de Supabase, une seule fois)
-- Contenu : schéma, protections, liste d'attente, données de départ (grille tarifaire), sécurité RLS.

-- Blvn Braids — schéma initial (PostgreSQL 15+)
-- Montants en centimes (integer), durées en minutes (integer), dates en timestamptz (affichage Europe/Paris).
-- Aucun secret ici. Les données de démonstration sont dans db/seed/ et portent is_demo = true.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE size_id AS ENUM ('micro', 'extra_small', 'small', 'medium', 'large', 'extra_large');
CREATE TYPE length_id AS ENUM ('bob', 'shoulder', 'upper_back', 'mid_back', 'lower_back', 'waist', 'hips', 'below_hips', 'other');

-- ───────────── Utilisateurs ─────────────
CREATE TABLE profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text UNIQUE,
  phone       text,
  full_name   text,
  role        text NOT NULL DEFAULT 'client' CHECK (role IN ('client', 'admin')),
  push_token  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Catalogue (entièrement administrable) ─────────────
CREATE TABLE service_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  label       text NOT NULL,
  is_visible  boolean NOT NULL DEFAULT false,   -- une catégorie masquée n'apparaît pas dans la navigation publique
  sort_order  integer NOT NULL DEFAULT 0
);

CREATE TABLE services (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id      uuid NOT NULL REFERENCES service_categories(id),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text,
  technique        text,
  prep_notes       text,
  is_visible       boolean NOT NULL DEFAULT false,  -- visible pour information
  is_bookable      boolean NOT NULL DEFAULT false,  -- visibilité et réservabilité sont distinctes
  home_allowed     boolean NOT NULL DEFAULT false,
  reference_size   size_id,                         -- configuration de référence du prix de base (NULL = non validée)
  reference_length length_id,
  -- Mèches : seulement pour les prestations qui en comportent (pas de mèches pour cils, ongles, barber…)
  hair_enabled     boolean NOT NULL DEFAULT false,
  hair_pricing     text CHECK (hair_pricing IN ('flat', 'per_bundle')),   -- supplément fixe ou prix par bundle
  CHECK (NOT hair_enabled OR hair_pricing IS NOT NULL),
  menu_template    text,                                                   -- domaine d'origine du menu (coiffure, tissage, ongles…)
  sort_order       integer NOT NULL DEFAULT 0,
  is_demo          boolean NOT NULL DEFAULT false
);

CREATE TABLE service_variants (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id         uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  slug               text NOT NULL,
  grp                text NOT NULL DEFAULT '',
  label              text NOT NULL,
  base_price_cents   integer CHECK (base_price_cents >= 0),   -- NULL = « Sur devis » (jamais 0 par défaut)
  is_from_price      boolean NOT NULL DEFAULT false,
  base_duration_min  integer CHECK (base_duration_min > 0),   -- NULL = durée à confirmer
  includes_size_supplement boolean NOT NULL DEFAULT false,
  asks_size          boolean NOT NULL DEFAULT false,   -- la cliente choisit la grosseur pour ce modèle
  asks_length        boolean NOT NULL DEFAULT false,   -- la cliente choisit la longueur pour ce modèle
  is_visible         boolean NOT NULL DEFAULT true,
  sort_order         integer NOT NULL DEFAULT 0,
  is_demo            boolean NOT NULL DEFAULT false,
  UNIQUE (service_id, slug)
);

-- Suppléments de grosseur, de longueur ou de combinaison (NULL = règle non validée => devis)
CREATE TABLE adjustment_rules (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id          uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  kind                text NOT NULL CHECK (kind IN ('size', 'length', 'combo')),
  size                size_id,
  length              length_id,
  supplement_cents    integer CHECK (supplement_cents >= 0),
  extra_duration_min  integer CHECK (extra_duration_min >= 0),
  CHECK ((kind = 'size'   AND size IS NOT NULL AND length IS NULL)
      OR (kind = 'length' AND length IS NOT NULL AND size IS NULL)
      OR (kind = 'combo'  AND size IS NOT NULL AND length IS NOT NULL))
);
CREATE UNIQUE INDEX adjustment_rules_unique
  ON adjustment_rules (service_id, kind, size, length) NULLS NOT DISTINCT;

-- Types de mèches fournies par la coiffeuse (naturelles, semi-naturelles…), prix fixe ou par bundle
CREATE TABLE hair_types (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id          uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  slug                text NOT NULL,
  label               text NOT NULL,
  price_cents         integer CHECK (price_cents >= 0),        -- NULL = non fixé => devis
  extra_duration_min  integer CHECK (extra_duration_min >= 0), -- NULL = durée à confirmer
  sort_order          integer NOT NULL DEFAULT 0,
  UNIQUE (service_id, slug)
);

-- Menu propre à chaque prestation : rubriques (ex. « Type de coupe », « Nail art ») que l'administratrice ajoute ou retire
CREATE TABLE option_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id  uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  label       text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('single', 'multi')),
  required    boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  UNIQUE (service_id, slug)
);

CREATE TABLE service_options (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id            uuid NOT NULL REFERENCES option_groups(id) ON DELETE CASCADE,
  slug                text NOT NULL,
  label               text NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('flat', 'per_unit')),
  unit_label          text,
  price_cents         integer CHECK (price_cents >= 0),        -- NULL = non fixé => devis
  extra_duration_min  integer CHECK (extra_duration_min >= 0), -- NULL = durée à confirmer
  allowed_variant_groups text[],                               -- compatible seulement avec ces groupes de modèles
  sort_order          integer NOT NULL DEFAULT 0,
  is_demo             boolean NOT NULL DEFAULT false,
  UNIQUE (group_id, slug)
);

-- ───────────── Médias ─────────────
CREATE TABLE media (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('photo', 'video')),
  storage_path  text NOT NULL,
  thumb_path    text,
  mime_type     text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  title         text,
  description   text,
  category_id   uuid REFERENCES service_categories(id),
  service_id    uuid REFERENCES services(id),
  is_published  boolean NOT NULL DEFAULT false,
  client_publication_consent boolean NOT NULL DEFAULT false,   -- autorisation de publication distincte
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_published OR client_publication_consent)
);

-- Photos de la prestation, de chaque modèle, de chaque option et de chaque type de mèches
ALTER TABLE services         ADD COLUMN photo_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE service_variants ADD COLUMN photo_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE service_options  ADD COLUMN photo_media_id uuid REFERENCES media(id) ON DELETE SET NULL;

-- ───────────── Paramètres ─────────────
CREATE TABLE public_settings (
  key        text PRIMARY KEY,
  value      jsonb,                       -- NULL = non configuré
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- PRIVÉ : adresse de départ, clés de service… Jamais exposé au navigateur (RLS admin/serveur uniquement).
CREATE TABLE private_settings (
  key        text PRIMARY KEY,
  value      jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE private_settings IS 'Données privées (ex. adresse de départ des déplacements). Lecture réservée au serveur et à l''administration.';

CREATE TABLE policy_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('rules', 'cancellation')),
  version      integer NOT NULL,
  body         jsonb NOT NULL,            -- rubriques administrables
  published_at timestamptz,
  UNIQUE (kind, version)
);

-- ───────────── Planning ─────────────
CREATE TABLE working_hours (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  weekday   smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  starts_at time NOT NULL,
  ends_at   time NOT NULL CHECK (ends_at > starts_at)
);

CREATE TABLE time_off (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  during    tstzrange NOT NULL,
  reason    text
);

-- ───────────── Demandes et devis (parcours B) ─────────────
CREATE TABLE requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES profiles(id),
  contact_email    text,
  contact_phone    text,
  contact_verified_at timestamptz,
  tracking_token_hash text UNIQUE,         -- seul le hash du lien personnel est stocké
  status           text NOT NULL DEFAULT 'to_verify' CHECK (status IN (
                     'simulation', 'to_verify', 'out_of_catalog', 'price_or_duration_missing',
                     'info_requested', 'quote_sent', 'quote_accepted', 'quote_declined',
                     'quote_expired', 'closed')),
  category         text,
  description      text,
  answers          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- longueur, grosseur, motifs, volume, mèches…
  desired_location jsonb,                                -- adresse d'intervention du client uniquement
  ai_suggestion    jsonb,                                -- INTERNE : jamais visible du client avant validation
  missing_info     text[] NOT NULL DEFAULT '{}',
  review_reason    text,
  idempotency_key  text NOT NULL UNIQUE,   -- évite les doublons (double clic, nouvelle tentative réseau)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE request_photos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id   uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  storage_path text NOT NULL,              -- bucket PRIVÉ ; jamais publié automatiquement dans la galerie
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE request_events (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor      text NOT NULL CHECK (actor IN ('client', 'admin', 'system')),
  kind       text NOT NULL,
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id          uuid NOT NULL REFERENCES requests(id),
  reference           text NOT NULL UNIQUE,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
  accepted_version_id uuid,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quote_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id             uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  version              integer NOT NULL,
  lines                jsonb NOT NULL,
  total_cents          integer NOT NULL CHECK (total_cents >= 0),
  deposit_cents        integer NOT NULL CHECK (deposit_cents >= 0),
  balance_cents        integer NOT NULL CHECK (balance_cents >= 0),
  duration_min         integer NOT NULL CHECK (duration_min > 0),
  valid_until          timestamptz NOT NULL,
  rules_version_id     uuid REFERENCES policy_versions(id),
  sent_at              timestamptz,
  accepted_at          timestamptz,
  UNIQUE (quote_id, version),
  CHECK (deposit_cents <= total_cents AND balance_cents = total_cents - deposit_cents)
);
ALTER TABLE quotes
  ADD CONSTRAINT quotes_accepted_version_fk FOREIGN KEY (accepted_version_id) REFERENCES quote_versions(id);

-- ───────────── Réservations ─────────────
CREATE TABLE bookings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid REFERENCES profiles(id),
  service_id          uuid NOT NULL REFERENCES services(id),
  variant_id          uuid NOT NULL REFERENCES service_variants(id),
  quote_version_id    uuid REFERENCES quote_versions(id),
  status              text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'confirmed', 'completed', 'cancelled', 'expired')),
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,         -- fin prévue, trajet compris
  duration_min        integer NOT NULL CHECK (duration_min > 0),   -- pas de réservation sans durée validée
  travel_buffer_min   integer NOT NULL DEFAULT 0 CHECK (travel_buffer_min >= 0),
  hold_expires_at     timestamptz,                  -- blocage temporaire pendant le paiement
  at_home             boolean NOT NULL DEFAULT false,
  intervention_address jsonb,                       -- adresse du CLIENT uniquement
  contact_email       text NOT NULL,                -- obligatoires : confirmation et rappels
  contact_phone       text NOT NULL,
  client_note         text,                         -- « un mot pour la coiffeuse » (facultatif)
  hair_supply         text CHECK (hair_supply IN ('client', 'salon')),
  hair_type_id        uuid REFERENCES hair_types(id),
  hair_bundles        integer CHECK (hair_bundles >= 1),
  total_cents         integer NOT NULL CHECK (total_cents >= 0),
  deposit_cents       integer NOT NULL CHECK (deposit_cents >= 0),
  balance_cents       integer NOT NULL CHECK (balance_cents >= 0),
  snapshot            jsonb NOT NULL,               -- copie figée : options, tarifs, durées acceptés
  rules_version_id    uuid NOT NULL REFERENCES policy_versions(id),
  cancellation_version_id uuid NOT NULL REFERENCES policy_versions(id),
  rules_accepted_at   timestamptz NOT NULL,
  cancellation_accepted_at timestamptz NOT NULL,
  idempotency_key     text NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  CHECK (deposit_cents <= total_cents AND balance_cents = total_cents - deposit_cents),
  CHECK (NOT at_home OR intervention_address IS NOT NULL),
  CHECK (hair_supply IS DISTINCT FROM 'salon' OR hair_type_id IS NOT NULL),
  -- Deux personnes ne peuvent pas obtenir le même créneau, même en requêtes simultanées.
  CONSTRAINT bookings_no_overlap
    EXCLUDE USING gist (tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('held', 'confirmed'))
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES bookings(id),
  provider      text NOT NULL CHECK (provider IN ('card', 'paypal', 'wero', 'revolut_pay')),
  provider_ref  text NOT NULL,
  amount_cents  integer NOT NULL CHECK (amount_cents > 0),
  status        text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'late')),
  verified_at   timestamptz,                -- vérification côté serveur auprès du prestataire
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_ref)           -- empêche le double traitement d'un même paiement
);

CREATE TABLE payment_events (               -- déduplication des webhooks
  provider   text NOT NULL,
  event_id   text NOT NULL,
  payload    jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

CREATE TABLE refunds (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id   uuid NOT NULL REFERENCES payments(id),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  provider_ref text NOT NULL,
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_id, provider_ref)
);

-- ───────────── Notifications, avis, fidélité ─────────────
CREATE TABLE notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id uuid REFERENCES profiles(id),
  audience          text NOT NULL CHECK (audience IN ('admin', 'client')),
  channel           text NOT NULL CHECK (channel IN ('in_app', 'email', 'push', 'sms')),
  kind              text NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key        text NOT NULL UNIQUE,   -- une notification par événement finalisé, pas par champ modifié
  read_at           timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reminders (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email', 'sms', 'push')),
  lead_minutes integer NOT NULL CHECK (lead_minutes IN (1440, 120)),   -- rappels 24 h et 2 h avant
  send_at     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'cancelled')),
  UNIQUE (booking_id, channel, lead_minutes)   -- reprogrammer = mettre à jour ; annuler = status cancelled
);

CREATE TABLE reviews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id  uuid NOT NULL UNIQUE REFERENCES bookings(id),
  rating      smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     text,
  is_hidden   boolean NOT NULL DEFAULT false,
  admin_reply text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reviews_require_completed_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM bookings WHERE id = NEW.booking_id AND status = 'completed') THEN
    RAISE EXCEPTION 'Un avis n''est possible qu''après une prestation terminée';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER reviews_completed_only BEFORE INSERT ON reviews
  FOR EACH ROW EXECUTE FUNCTION reviews_require_completed_booking();

CREATE TABLE loyalty_programs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config     jsonb,                          -- mode de cumul, seuils, récompenses, validité : définis par l'administratrice
  is_active  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE loyalty_ledger (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES profiles(id),
  booking_id uuid REFERENCES bookings(id),
  reason     text NOT NULL CHECK (reason IN ('earned', 'redeemed', 'reversed')),
  points     integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, reason)               -- jamais de double comptage pour une même réservation
);

-- ───────────── Accès (à activer avec la couche d'authentification choisie) ─────────────
-- Les tables private_settings, requests, request_photos, quotes, payments doivent être protégées par
-- des politiques RLS (ou par la couche API) : lecture/écriture réservées au propriétaire de la ressource
-- ou à role = 'admin'. Voir docs/ARCHITECTURE.md.

-- Une prestation ne peut être affichée ou réservable que si un tarif exact est fixé par l'administratrice.
-- Pas de devis pour les prestations « à venir » (tissage, Quick Weave, perruque, Flip Over, beauté…) : elles restent masquées.

CREATE FUNCTION services_require_price_to_publish() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.is_visible OR NEW.is_bookable) AND NOT EXISTS (
    SELECT 1 FROM service_variants v
    WHERE v.service_id = NEW.id AND v.base_price_cents IS NOT NULL AND NOT v.is_from_price
  ) THEN
    RAISE EXCEPTION 'La prestation "%" ne peut pas être affichée sans tarif exact', NEW.name;
  END IF;
  RETURN NULL;
END;
$$;

-- Différé : permet de créer une prestation et ses variantes dans la même transaction.
CREATE CONSTRAINT TRIGGER services_price_before_publish
  AFTER INSERT OR UPDATE OF is_visible, is_bookable ON services
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION services_require_price_to_publish();

-- Si le dernier tarif exact est retiré, la prestation est masquée automatiquement (les rendez-vous existants gardent leur copie figée).
CREATE FUNCTION variants_hide_service_without_price() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  sid uuid := COALESCE(NEW.service_id, OLD.service_id);
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM service_variants
    WHERE service_id = sid AND base_price_cents IS NOT NULL AND NOT is_from_price
  ) THEN
    UPDATE services SET is_visible = false, is_bookable = false WHERE id = sid AND (is_visible OR is_bookable);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER variants_price_removed
  AFTER UPDATE OF base_price_cents, is_from_price OR DELETE ON service_variants
  FOR EACH ROW EXECUTE FUNCTION variants_hide_service_without_price();

-- Liste d'attente : une cliente peut s'inscrire sur un créneau complet. L'inscription ne bloque PAS le créneau.
-- Quand il se libère, la première personne inscrite (ordre d'inscription) dont la prestation tient dans la plage est prévenue
-- par e-mail et SMS ; elle doit ensuite réserver et payer l'acompte comme d'habitude.

CREATE TABLE waitlist_entries (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid REFERENCES profiles(id),
  service_id           uuid NOT NULL REFERENCES services(id),
  variant_id           uuid NOT NULL REFERENCES service_variants(id),
  desired_starts_at    timestamptz NOT NULL,
  duration_min         integer NOT NULL CHECK (duration_min > 0),   -- durée validée : pas d'inscription sans durée connue
  contact_email        text NOT NULL,                               -- obligatoires : prévenir par e-mail et SMS
  contact_phone        text NOT NULL,
  status               text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'notified', 'converted', 'expired', 'cancelled')),
  notified_at          timestamptz,
  expires_at           timestamptz,                                 -- délai de réponse, configurable par l'administratrice
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Pas de doublon : une personne ne s'inscrit qu'une fois par créneau et par prestation.
CREATE UNIQUE INDEX waitlist_no_duplicate
  ON waitlist_entries (service_id, variant_id, desired_starts_at, lower(contact_email))
  WHERE status = 'waiting';

CREATE INDEX waitlist_by_slot ON waitlist_entries (desired_starts_at, created_at) WHERE status = 'waiting';

-- DONNÉES DE DÉMONSTRATION (is_demo = true). Généré par packages/core/scripts/gen-seed.ts — ne pas modifier à la main.
-- Prix : grilles validées. Durées, suppléments, supplément mèches, configuration de référence : NULL (à saisir dans l'administration).
BEGIN;
INSERT INTO service_categories (slug, label, is_visible, sort_order) VALUES ('coiffure', 'Coiffure', true, 1);
INSERT INTO service_categories (slug, label, is_visible, sort_order) VALUES ('beaute', 'Beauté', false, 2);
INSERT INTO service_categories (slug, label, is_visible, sort_order) VALUES ('barber', 'Barber', false, 3);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'braids', 'Braids', true, true, true, NULL, NULL, true, 'flat', 1, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'braids-knotless-braids-medium', 'Braids', 'Knotless braids medium', 6000, false, NULL, false, true, true, 1, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'braids-jayda-wayda-braids', 'Braids', 'Jayda Wayda braids', 6000, false, NULL, false, true, true, 2, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'braids-island-twists', 'Braids', 'Island twists', 7000, false, NULL, false, true, true, 3, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'braids-bald-braids-avec-motifs', 'Braids', 'Bald braids avec motifs', 6500, false, NULL, false, false, false, 4, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'fulani-fulani-classiques', 'Fulani', 'Fulani classiques', 6000, false, NULL, false, true, true, 5, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'fulani-fulani-sans-boucles', 'Fulani', 'Fulani sans boucles', 6500, false, NULL, false, true, true, 6, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'fulani-fulani-avec-boucles', 'Fulani', 'Fulani avec boucles', 7500, false, NULL, false, true, true, 7, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'fulani-front-feed-fulani', 'Fulani', 'Front feed Fulani', 7000, false, NULL, false, true, true, 8, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'cornrows-cornrows-avec-motifs-terminees-en-chignon', 'Cornrows', 'Cornrows avec motifs, terminées en chignon', 6000, false, NULL, false, false, false, 9, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'cornrows-cornrows-en-queue-de-cheval', 'Cornrows', 'Cornrows en queue de cheval', 8000, false, NULL, false, false, false, 10, true);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'synthetiques', 'Synthétiques', NULL, 0, 1);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'braids'), 'naturelles', 'Naturelles', NULL, 0, 2);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'faux-locs', 'Faux locs', true, true, true, NULL, NULL, true, 'flat', 2, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'faux-locs'), 'faux-locs-faux-locs', 'Faux locs', 'Faux locs', 8500, false, NULL, false, true, true, 1, true);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'faux-locs'), 'synthetiques', 'Synthétiques', NULL, 0, 1);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'faux-locs'), 'naturelles', 'Naturelles', NULL, 0, 2);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'bohemian-locs', 'Bohemian locs', true, true, true, NULL, NULL, true, 'flat', 3, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'bohemian-locs'), 'bohemian-locs-bohemian-locs', 'Bohemian locs', 'Bohemian locs', 9500, false, NULL, false, true, true, 1, true);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'bohemian-locs'), 'synthetiques', 'Synthétiques', NULL, 0, 1);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'bohemian-locs'), 'naturelles', 'Naturelles', NULL, 0, 2);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'locks', 'Locks et entretien', true, true, true, NULL, NULL, false, NULL, 4, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-twist-coils-jusqu-a-40-locks', 'Départ twist / coils', 'Jusqu’à 40 locks', 8000, false, NULL, false, false, false, 1, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-twist-coils-41-a-60-locks', 'Départ twist / coils', '41 à 60 locks', 9000, false, NULL, false, false, false, 2, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-twist-coils-61-a-80-locks', 'Départ twist / coils', '61 à 80 locks', 11000, false, NULL, false, false, false, 3, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-twist-coils-81-a-100-locks', 'Départ twist / coils', '81 à 100 locks', 13000, false, NULL, false, false, false, 4, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-twist-coils-plus-de-100-locks', 'Départ twist / coils', 'Plus de 100 locks', NULL, false, NULL, false, false, false, 5, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-instantane-au-crochet-jusqu-a-40-locks', 'Départ instantané au crochet', 'Jusqu’à 40 locks', 11000, false, NULL, false, false, false, 6, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-instantane-au-crochet-41-a-60-locks', 'Départ instantané au crochet', '41 à 60 locks', 13000, false, NULL, false, false, false, 7, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-instantane-au-crochet-61-a-80-locks', 'Départ instantané au crochet', '61 à 80 locks', 16000, false, NULL, false, false, false, 8, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-instantane-au-crochet-81-a-100-locks', 'Départ instantané au crochet', '81 à 100 locks', 19000, false, NULL, false, false, false, 9, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'depart-instantane-au-crochet-plus-de-100-locks', 'Départ instantané au crochet', 'Plus de 100 locks', NULL, false, NULL, false, false, false, 10, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'retwist-jusqu-a-40-locks', 'Retwist', 'Jusqu’à 40 locks', 4500, false, NULL, false, false, false, 11, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'retwist-41-a-60-locks', 'Retwist', '41 à 60 locks', 5500, false, NULL, false, false, false, 12, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'retwist-61-a-80-locks', 'Retwist', '61 à 80 locks', 6500, false, NULL, false, false, false, 13, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'retwist-81-a-100-locks', 'Retwist', '81 à 100 locks', 7500, false, NULL, false, false, false, 14, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'retwist-plus-de-100-locks', 'Retwist', 'Plus de 100 locks', 8500, true, NULL, false, false, false, 15, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'locks'), 'supplements-reparations', 'Suppléments et réparations', 'multi', false, 1);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'locks' AND og.slug = 'supplements-reparations'), 'barrel-twists-apres-retwist', 'Barrel twists après retwist', 'flat', NULL, 1000, NULL, ARRAY['Retwist'], 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'locks' AND og.slug = 'supplements-reparations'), 'coiffure-complexe-apres-retwist', 'Coiffure complexe après retwist', 'flat', NULL, 2000, NULL, ARRAY['Retwist'], 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'locks' AND og.slug = 'supplements-reparations'), 'reinstallation-anciennes-locks', 'Réinstallation d’anciennes locks', 'per_unit', 'locks', 300, NULL, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'locks' AND og.slug = 'supplements-reparations'), 'reparation-lock', 'Réparation de locks', 'per_unit', 'locks', 500, NULL, NULL, 4, true);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'ponytails', 'Ponytails', true, true, true, NULL, NULL, true, 'flat', 5, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'ponytails'), 'ponytails-ponytail-simple', 'Ponytails', 'Ponytail simple', 4500, false, NULL, false, false, true, 1, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'ponytails'), 'ponytails-ponytail-avec-frange', 'Ponytails', 'Ponytail avec frange', 5500, false, NULL, false, false, true, 2, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'ponytails'), 'ponytails-ponytail-tressee', 'Ponytails', 'Ponytail tressée', 5000, false, NULL, false, false, true, 3, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'ponytails'), 'ponytails-demi-tete-quick-weave-ponytail', 'Ponytails', 'Demi-tête Quick Weave + ponytail', 8000, false, NULL, false, false, true, 4, true);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'ponytails'), 'naturelles', 'Naturelles', NULL, 0, 1);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'ponytails'), 'semi-naturelles', 'Semi-naturelles', NULL, 0, 2);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'hommes', 'Coiffures hommes', true, true, true, NULL, NULL, false, NULL, 6, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'hommes'), 'flat-twists-flat-twists-simples', 'Flat twists', 'Flat twists simples', 3000, false, NULL, false, false, false, 1, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'hommes'), 'flat-twists-flat-twists-avec-motifs', 'Flat twists', 'Flat twists avec motifs', 4000, false, NULL, false, false, false, 2, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'hommes'), 'barrel-twists-barrel-twists-simples', 'Barrel twists', 'Barrel twists simples', 3500, false, NULL, false, false, false, 3, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'hommes'), 'barrel-twists-barrel-twists-vanilles', 'Barrel twists', 'Barrel twists + vanilles', 4500, false, NULL, false, false, false, 4, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'hommes'), 'barrel-twists-barrel-twists-avec-motifs', 'Barrel twists', 'Barrel twists avec motifs', 4500, false, NULL, false, false, false, 5, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'hommes'), 'barrel-twists-barrel-twists-motifs-vanilles', 'Barrel twists', 'Barrel twists + motifs + vanilles', 5000, false, NULL, false, false, false, 6, true);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'tissage', 'Tissage', false, false, true, NULL, NULL, true, 'per_bundle', 7, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'tissage'), 'tissage-tissage', 'Tissage', 'Tissage', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'tissage'), 'naturels', 'Naturels', NULL, 0, 1);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'tissage'), 'semi-naturels', 'Semi-naturels', NULL, 0, 2);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'quick-weave', 'Quick Weave', false, false, true, NULL, NULL, true, 'per_bundle', 8, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'quick-weave'), 'quick-weave-quick-weave', 'Quick Weave', 'Quick Weave', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'quick-weave'), 'naturels', 'Naturels', NULL, 0, 1);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'quick-weave'), 'semi-naturels', 'Semi-naturels', NULL, 0, 2);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'pose-perruque', 'Pose de perruque', false, false, true, NULL, NULL, false, NULL, 9, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'pose-perruque'), 'pose-de-perruque-pose-de-perruque', 'Pose de perruque', 'Pose de perruque', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pose-perruque'), 'perruque', 'Perruque', 'single', true, 1);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'perruque'), 'perruque-fournie-par-la-cliente', 'Fournie par la cliente', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'perruque'), 'perruque-fournie-par-la-coiffeuse', 'Fournie par la coiffeuse', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pose-perruque'), 'type-de-lace', 'Type de lace', 'single', false, 2);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'type-de-lace'), 'type-de-lace-lace-frontale', 'Lace frontale', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'type-de-lace'), 'type-de-lace-closure', 'Closure', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'type-de-lace'), 'type-de-lace-full-lace', 'Full lace', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pose-perruque'), 'customisation', 'Customisation', 'multi', false, 3);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'customisation'), 'customisation-pose-et-decoupe-de-la-lace', 'Pose et découpe de la lace', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'customisation'), 'customisation-epilation-de-la-lace', 'Épilation de la lace', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pose-perruque'), 'finition', 'Finition', 'single', false, 4);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'finition'), 'finition-finition-simple', 'Finition simple', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pose-perruque' AND og.slug = 'finition'), 'finition-finition-coiffee', 'Finition coiffée', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'coiffure'), 'flip-over', 'Flip Over', false, false, true, NULL, NULL, true, 'flat', 10, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'flip-over'), 'flip-over-flip-over', 'Flip Over', 'Flip Over', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'flip-over'), 'synthetiques', 'Synthétiques', NULL, 0, 1);
INSERT INTO hair_types (service_id, slug, label, price_cents, extra_duration_min, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'flip-over'), 'naturelles', 'Naturelles', NULL, 0, 2);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'beaute'), 'extensions-cils', 'Extensions de cils', false, false, false, NULL, NULL, false, NULL, 11, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'extensions-cils'), 'cils-extensions-de-cils', 'Cils', 'Extensions de cils', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'extensions-cils'), 'prestation', 'Prestation', 'single', true, 1);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'extensions-cils' AND og.slug = 'prestation'), 'prestation-pose-complete', 'Pose complète', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'extensions-cils' AND og.slug = 'prestation'), 'prestation-remplissage', 'Remplissage', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'extensions-cils'), 'technique', 'Technique', 'single', true, 2);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'extensions-cils' AND og.slug = 'technique'), 'technique-cil-a-cil', 'Cil à cil', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'extensions-cils' AND og.slug = 'technique'), 'technique-volume', 'Volume', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'extensions-cils' AND og.slug = 'technique'), 'technique-hybride', 'Hybride', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'extensions-cils'), 'depose', 'Dépose', 'single', false, 3);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'extensions-cils' AND og.slug = 'depose'), 'depose-sans-depose', 'Sans dépose', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'extensions-cils' AND og.slug = 'depose'), 'depose-avec-depose', 'Avec dépose', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'beaute'), 'manucure', 'Manucure', false, false, false, NULL, NULL, false, NULL, 12, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'manucure'), 'ongles-manucure', 'Ongles', 'Manucure', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'manucure'), 'type-de-pose', 'Type de pose', 'single', true, 1);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'type-de-pose'), 'type-de-pose-vernis-classique', 'Vernis classique', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'type-de-pose'), 'type-de-pose-semi-permanent', 'Semi-permanent', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'type-de-pose'), 'type-de-pose-gel', 'Gel', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'type-de-pose'), 'type-de-pose-capsules', 'Capsules', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'manucure'), 'forme', 'Forme', 'single', false, 2);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'forme'), 'forme-carree', 'Carrée', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'forme'), 'forme-ronde', 'Ronde', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'forme'), 'forme-amande', 'Amande', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'forme'), 'forme-ovale', 'Ovale', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'manucure'), 'longueur', 'Longueur', 'single', false, 3);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'longueur'), 'longueur-courte', 'Courte', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'longueur'), 'longueur-moyenne', 'Moyenne', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'longueur'), 'longueur-longue', 'Longue', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'longueur'), 'longueur-extra-longue', 'Extra longue', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'manucure'), 'nail-art-et-modeles', 'Nail art et modèles', 'multi', false, 4);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-french', 'French', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-chrome', 'Chrome', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-strass', 'Strass', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-motifs-dessines', 'Motifs dessinés', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'manucure'), 'depose', 'Dépose', 'single', false, 5);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'depose'), 'depose-sans-depose', 'Sans dépose', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'manucure' AND og.slug = 'depose'), 'depose-avec-depose', 'Avec dépose', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'beaute'), 'pedicure', 'Pédicure', false, false, false, NULL, NULL, false, NULL, 13, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'pedicure'), 'ongles-pedicure', 'Ongles', 'Pédicure', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pedicure'), 'type-de-pose', 'Type de pose', 'single', true, 1);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'type-de-pose'), 'type-de-pose-vernis-classique', 'Vernis classique', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'type-de-pose'), 'type-de-pose-semi-permanent', 'Semi-permanent', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'type-de-pose'), 'type-de-pose-gel', 'Gel', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'type-de-pose'), 'type-de-pose-capsules', 'Capsules', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pedicure'), 'forme', 'Forme', 'single', false, 2);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'forme'), 'forme-carree', 'Carrée', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'forme'), 'forme-ronde', 'Ronde', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'forme'), 'forme-amande', 'Amande', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'forme'), 'forme-ovale', 'Ovale', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pedicure'), 'longueur', 'Longueur', 'single', false, 3);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'longueur'), 'longueur-courte', 'Courte', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'longueur'), 'longueur-moyenne', 'Moyenne', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'longueur'), 'longueur-longue', 'Longue', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'longueur'), 'longueur-extra-longue', 'Extra longue', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pedicure'), 'nail-art-et-modeles', 'Nail art et modèles', 'multi', false, 4);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-french', 'French', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-chrome', 'Chrome', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-strass', 'Strass', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'nail-art-et-modeles'), 'nail-art-et-modeles-motifs-dessines', 'Motifs dessinés', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'pedicure'), 'depose', 'Dépose', 'single', false, 5);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'depose'), 'depose-sans-depose', 'Sans dépose', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'pedicure' AND og.slug = 'depose'), 'depose-avec-depose', 'Avec dépose', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO services (category_id, slug, name, is_visible, is_bookable, home_allowed, reference_size, reference_length, hair_enabled, hair_pricing, sort_order, is_demo) VALUES ((SELECT id FROM service_categories WHERE slug = 'barber'), 'barber', 'Barber', false, false, false, NULL, NULL, false, NULL, 14, true);
INSERT INTO service_variants (service_id, slug, grp, label, base_price_cents, is_from_price, base_duration_min, includes_size_supplement, asks_size, asks_length, sort_order, is_demo) VALUES ((SELECT id FROM services WHERE slug = 'barber'), 'barber-barber', 'Barber', 'Barber', NULL, false, NULL, false, false, false, 1, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'barber'), 'type-de-coupe', 'Type de coupe', 'single', true, 1);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'type-de-coupe'), 'type-de-coupe-coupe-classique', 'Coupe classique', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'type-de-coupe'), 'type-de-coupe-degrade', 'Dégradé', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'type-de-coupe'), 'type-de-coupe-coupe-aux-ciseaux', 'Coupe aux ciseaux', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'type-de-coupe'), 'type-de-coupe-coupe-a-blanc', 'Coupe à blanc', 'flat', NULL, NULL, 0, NULL, 4, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'barber'), 'barbe', 'Barbe', 'single', false, 2);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'barbe'), 'barbe-sans-barbe', 'Sans barbe', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'barbe'), 'barbe-taille-de-barbe', 'Taille de barbe', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'barbe'), 'barbe-barbe-serviette-chaude', 'Barbe + serviette chaude', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO option_groups (service_id, slug, label, kind, required, sort_order) VALUES ((SELECT id FROM services WHERE slug = 'barber'), 'options', 'Options', 'multi', false, 3);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'options'), 'options-contours', 'Contours', 'flat', NULL, NULL, 0, NULL, 1, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'options'), 'options-shampoing', 'Shampoing', 'flat', NULL, NULL, 0, NULL, 2, true);
INSERT INTO service_options (group_id, slug, label, kind, unit_label, price_cents, extra_duration_min, allowed_variant_groups, sort_order, is_demo) VALUES ((SELECT og.id FROM option_groups og JOIN services sv ON sv.id = og.service_id WHERE sv.slug = 'barber' AND og.slug = 'options'), 'options-soin-du-visage', 'Soin du visage', 'flat', NULL, NULL, 0, NULL, 3, true);
INSERT INTO policy_versions (kind, version, body, published_at) VALUES ('rules', 1, '{"sections":[{"key":"hair_preparation","title":"Préparation des cheveux","body":"Merci de vous présenter avec les cheveux impérativement propres. Le démêlage préalable n’est pas obligatoire."},{"key":"ponctualite","title":"Ponctualité","body":null},{"key":"retards","title":"Retards","body":null},{"key":"acomptes","title":"Acomptes","body":null},{"key":"annulations","title":"Annulations","body":null},{"key":"reports","title":"Reports","body":null},{"key":"absences","title":"Absences","body":null},{"key":"accompagnants","title":"Accompagnants","body":null},{"key":"fourniture_des_meches","title":"Fourniture des mèches","body":null},{"key":"deplacements","title":"Déplacements","body":null}]}'::jsonb, now());
INSERT INTO policy_versions (kind, version, body, published_at) VALUES ('cancellation', 1, '{"sections":[{"key":"cancellation","title":"Politique d’annulation","body":null}]}'::jsonb, NULL);
INSERT INTO public_settings (key, value) VALUES ('deposit', '{"type":"percent","rate":45}');
INSERT INTO public_settings (key, value) VALUES ('quote_validity_days', NULL);
INSERT INTO public_settings (key, value) VALUES ('hold_minutes', NULL);
INSERT INTO public_settings (key, value) VALUES ('schedule_margins', NULL);
INSERT INTO private_settings (key, value) VALUES ('departure_address', NULL);
INSERT INTO private_settings (key, value) VALUES ('travel_pricing_formula', NULL);
COMMIT;


-- ───────────── Sécurité (RLS) ─────────────
-- Toutes les tables sont verrouillées. La clé publique ne peut LIRE que le catalogue et les réglages publics.
-- Toute écriture (réservations, paiements, demandes) passe par le serveur avec la clé secrète.
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE adjustment_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE hair_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE option_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_categories_public_read" ON service_categories FOR SELECT TO anon, authenticated USING (is_visible = true);
CREATE POLICY "services_public_read" ON services FOR SELECT TO anon, authenticated USING (is_visible = true);
CREATE POLICY "service_variants_public_read" ON service_variants FOR SELECT TO anon, authenticated USING (is_visible = true);
CREATE POLICY "adjustment_rules_public_read" ON adjustment_rules FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "hair_types_public_read" ON hair_types FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "option_groups_public_read" ON option_groups FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "service_options_public_read" ON service_options FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "media_public_read" ON media FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "public_settings_public_read" ON public_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "working_hours_public_read" ON working_hours FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "time_off_public_read" ON time_off FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "policy_versions_public_read" ON policy_versions FOR SELECT TO anon, authenticated USING (published_at IS NOT NULL);
CREATE POLICY "loyalty_programs_public_read" ON loyalty_programs FOR SELECT TO anon, authenticated USING (true);
-- reviews : lecture publique des avis publiés seulement
CREATE POLICY "reviews_public_read" ON reviews FOR SELECT TO anon, authenticated USING (is_hidden = false);
