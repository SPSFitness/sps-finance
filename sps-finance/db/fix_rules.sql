-- Common personal-spend merchants misfiring through Owner Drawings — lock these in as rules
-- so they stop getting mis-guessed as business categories like "Retreat Costs"
INSERT INTO category_rules (category_id, match_type, match_value, priority) VALUES
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'tesco', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'costa coffee', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'uber', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'mcdonalds', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'nisa local', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'waitrose', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'co-operative food', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'co op group food', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'pizzahut', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'subway', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'marks&spencer', 8),
  ((SELECT id FROM categories WHERE name = 'Owner Drawings'), 'description_contains', 'starbucks', 8);

-- Widen the Stripe catch-all to also catch plain "PAYOUT" descriptions, same ambiguity issue
INSERT INTO category_rules (category_id, match_type, match_value, priority)
VALUES (
  (SELECT id FROM categories WHERE name = 'Stripe Payouts (unallocated - check Stripe dashboard)'),
  'description_contains',
  'payout',
  6
);

-- "Sessions" = self-employed staff payments (always an expense, never income)
INSERT INTO category_rules (category_id, match_type, match_value, priority)
VALUES (
  (SELECT id FROM categories WHERE name = 'Wages & PAYE'),
  'description_contains',
  'sessions',
  7
);
