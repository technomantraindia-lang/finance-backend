-- KuberFinance Admin Seed
-- Only the Admin login is seeded. No demo customers/vehicles/data.
-- Admin creates customer accounts from inside the app.
-- Password is stored as a scrypt hash (salt:hash), never plaintext.
USE transportsoft;

INSERT INTO users (id, name, role, email, password_hash) VALUES
  ('u-admin', 'Admin', 'Admin', 'admin@kuber.local', 'd4782587ae5cbfb051d834f01a6da7a4:5ea0d6925509d5c89fd55ce3eac3906bc7930c4f97feeaefa97efc5bbb571de164c626da09081fb0b78ad1f206bda3e4443210317b9e33006b065e286da9a97b');
