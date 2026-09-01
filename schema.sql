-- TransportSoft Fleet Finance Database Schema
-- Compatible with MySQL 8.x / MariaDB 10.4+

CREATE DATABASE IF NOT EXISTS transportsoft CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE transportsoft;

-- ─── Users ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  role ENUM('Admin','Owner','Caller','Customer') NOT NULL DEFAULT 'Owner',
  email VARCHAR(160),
  password_hash VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ─── Clients ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id VARCHAR(32) PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  email VARCHAR(160),
  city VARCHAR(80),
  phone VARCHAR(24),
  caller_id VARCHAR(32),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (caller_id) REFERENCES users(id) ON DELETE SET NULL
);

-- ─── Vehicles ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id VARCHAR(48) PRIMARY KEY,
  client_id VARCHAR(32) NOT NULL,
  type VARCHAR(24) DEFAULT 'Truck',
  reg_no VARCHAR(24),
  make VARCHAR(48),
  model VARCHAR(64),
  year INT,
  km INT DEFAULT 0,
  principal DECIMAL(14,2) DEFAULT 0,
  overdue DECIMAL(12,2) DEFAULT 0,
  penalty DECIMAL(12,2) DEFAULT 0,
  foreclosure DECIMAL(12,2) DEFAULT 0,
  insurance_expiry DATE,
  permit_expiry DATE,
  status VARCHAR(32) DEFAULT 'Active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

-- ─── Due Tasks ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS due_tasks (
  id VARCHAR(48) PRIMARY KEY,
  client_id VARCHAR(32) NOT NULL,
  vehicle_id VARCHAR(48),
  type VARCHAR(32) DEFAULT 'EMI',
  amount DECIMAL(12,2) DEFAULT 0,
  due_date DATE,
  status VARCHAR(32) DEFAULT 'Due',
  caller_id VARCHAR(32),
  priority VARCHAR(16) DEFAULT 'Medium',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE SET NULL
);

-- ─── Marketplace Listings ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS listings (
  id VARCHAR(48) PRIMARY KEY,
  vehicle_id VARCHAR(48) NOT NULL,
  title VARCHAR(200),
  price DECIMAL(14,2) DEFAULT 0,
  location VARCHAR(80),
  status VARCHAR(32) DEFAULT 'Submitted',
  condition_note VARCHAR(64) DEFAULT 'Good',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
);

-- ─── Verification Items ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS verification_items (
  id VARCHAR(48) PRIMARY KEY,
  task_id VARCHAR(48) NOT NULL,
  submitted_by VARCHAR(120),
  submitted_at VARCHAR(64),
  proof_type VARCHAR(80),
  details JSON,
  audit JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (task_id) REFERENCES due_tasks(id) ON DELETE CASCADE
);

-- ─── Caller Activities ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS caller_activities (
  id VARCHAR(48) PRIMARY KEY,
  task_id VARCHAR(48) NOT NULL,
  caller_id VARCHAR(32),
  outcome VARCHAR(80),
  notes TEXT,
  expected_amount VARCHAR(80),
  next_follow_up VARCHAR(64),
  channel VARCHAR(32) DEFAULT 'Call',
  occurred_at VARCHAR(64),
  FOREIGN KEY (task_id) REFERENCES due_tasks(id) ON DELETE CASCADE
);

-- ─── Audit Logs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(48) PRIMARY KEY,
  module VARCHAR(48),
  action VARCHAR(64),
  record VARCHAR(120),
  old_value VARCHAR(255),
  new_value VARCHAR(255),
  remark TEXT,
  event_at VARCHAR(64)
);

-- ─── Import Rows (Batch) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_rows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  row_no INT,
  reg_no VARCHAR(24),
  asset_type VARCHAR(24),
  client_name VARCHAR(160),
  loan_account VARCHAR(64),
  lender VARCHAR(80),
  status VARCHAR(32),
  issue VARCHAR(255)
);

-- Detailed customer Excel uploads used by web, admin app and customer app
CREATE TABLE IF NOT EXISTS client_imports (
  id VARCHAR(64) PRIMARY KEY,
  client_id VARCHAR(32) NOT NULL,
  file_name VARCHAR(255),
  imported_at VARCHAR(64),
  rows_json JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);
