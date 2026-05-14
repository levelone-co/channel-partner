-- 0004: Capture GHL sub-account (location) ID per tenant.
-- The column already exists in 0001's schema; this migration just records the
-- expected UPDATE for the existing Level 24 row. Re-run safely.

update tenants
   set ghl_location_id = '<paste_level_24_location_id_here>'
 where slug = 'level_24_wines';

-- To find the location_id: from inside the Level 24 sub-account in GHL, the
-- URL is `https://app.gohighlevel.com/v2/location/<location_id>/...`.
