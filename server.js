const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;
const REQUIRE_DATABASE = process.env.REQUIRE_DATABASE !== "false";
const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || "";
const databaseConfig = databaseUrl ? new URL(databaseUrl) : null;
const dbSettings = {
  host: databaseConfig?.hostname || process.env.DB_HOST || "localhost",
  port: Number(databaseConfig?.port || process.env.DB_PORT || 3306),
  user: databaseConfig ? decodeURIComponent(databaseConfig.username) : (process.env.DB_USER || "transportsoft"),
  database: databaseConfig ? databaseConfig.pathname.replace(/^\//, "") : (process.env.DB_NAME || "transportsoft"),
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined
};
let lastDbError = "";
let schemaReady = false;
let schemaPromise = null;
let clientsEmailReady = false;
let clientsEmailPromise = null;
let usersMobileReady = false;
let usersMobilePromise = null;
let clientImportsReady = false;
let clientImportsPromise = null;
let documentsReady = false;
let documentsPromise = null;

app.use(cors());
app.use(express.json({ limit: "25mb" }));

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Kuber Finance API",
    health: "/api/health"
  });
});

// ─── Database connection pool ─────────────────────────────
const pool = mysql.createPool({
  host: dbSettings.host,
  port: dbSettings.port,
  user: dbSettings.user,
  password: databaseConfig ? decodeURIComponent(databaseConfig.password) : (process.env.DB_PASSWORD || ""),
  database: dbSettings.database,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  ssl: dbSettings.ssl
});

// ─── In-memory fallback (used when MySQL is not running) ──
// Admin account is always available; customers created in the
// app are stored here when MySQL is unavailable.
let dbAvailable = true;
const memoryUsers = [
  {
    id: "u-admin",
    name: "Admin",
    role: "Admin",
    email: "admin@kuber.local",
    password_hash: "admin123"
  }
];
const memoryClients = [];
const memoryVehicles = [];
const memoryDues = [];
const memoryListings = [];
const memoryCallerActivities = [];
const memoryAuditLogs = [];
const memoryImportRows = [];
const memoryClientImports = [];
const memoryDocuments = [];

function starterRecordsForClient(client) {
  const suffix = String(client.id).replace(/[^a-z0-9]/gi, "").slice(-6) || Date.now();
  const truckId = `v-${suffix}-truck`;
  const trailerId = `v-${suffix}-trailer`;
  return {
    vehicles: [
    {
      id: truckId,
      client_id: client.id,
      type: "Truck",
      reg_no: "GJ01AB1234",
      make: "Tata",
      model: "Prima",
      year: 2021,
      km: 68400,
      principal: 384000,
      overdue: 28000,
      penalty: 2500,
      foreclosure: 15000,
      insurance_expiry: "2026-09-15",
      permit_expiry: "2026-10-20",
      status: "Active"
    },
    {
      id: trailerId,
      client_id: client.id,
      type: "Trailer",
      reg_no: "GJ01TR5678",
      make: "DICV",
      model: "Flatbed",
      year: 2020,
      km: 52200,
      principal: 610000,
      overdue: 0,
      penalty: 0,
      foreclosure: 18000,
      insurance_expiry: "2026-11-05",
      permit_expiry: "2026-12-12",
      status: "Listed"
    }
    ],
    dues: [
    {
      id: `d-${suffix}-emi`,
      client_id: client.id,
      vehicle_id: truckId,
      type: "EMI",
      amount: 28000,
      due_date: "2026-08-25",
      status: "Due",
      caller_id: null,
      priority: "High"
    },
    {
      id: `d-${suffix}-insurance`,
      client_id: client.id,
      vehicle_id: truckId,
      type: "Insurance",
      amount: 42000,
      due_date: "2026-09-15",
      status: "Due",
      caller_id: null,
      priority: "Medium"
    }
    ],
    listings: [{
    id: `m-${suffix}-listing`,
    vehicle_id: trailerId,
    title: "2020 DICV Flatbed Trailer",
    price: 950000,
    location: client.city || "Ahmedabad",
    status: "Active",
    condition_note: "Good"
    }]
  };
}

function createMemoryFleetForClient(client) {
  if (!client || memoryVehicles.some((vehicle) => vehicle.client_id === client.id)) return;
  const records = starterRecordsForClient(client);
  memoryVehicles.push(...records.vehicles);
  memoryDues.push(...records.dues);
  memoryListings.push(...records.listings);
}

function upsertMemoryItem(collection, item) {
  if (!item?.id) return;
  const index = collection.findIndex((entry) => entry.id === item.id);
  if (index >= 0) {
    collection[index] = { ...collection[index], ...item };
  } else {
    collection.push(item);
  }
}

function normalizeClient(row) {
  return {
    id: String(row.id || `c-${Date.now()}`),
    name: String(row.name || "Customer"),
    city: row.city || "",
    phone: row.phone || "",
    caller_id: row.callerId || row.caller_id || null,
    email: String(row.email || row.loginEmail || "").trim().toLowerCase()
  };
}

function toMysqlDate(value) {
  const text = String(value || "").trim();
  const validDate = (year, month, day) => {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return date.getFullYear() === Number(year) &&
      date.getMonth() === Number(month) - 1 &&
      date.getDate() === Number(day);
  };
  const buildDate = (year, month, day) => {
    if (!validDate(year, month, day)) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };
  if (!text || text === "-") return null;
  const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return buildDate(year, month, day);
  }
  const localMatch = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (localMatch) {
    const [, day, month, rawYear] = localMatch;
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return buildDate(year, month, day);
  }
  const namedMonthMatch = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (namedMonthMatch) {
    const [, day, monthName, rawYear] = namedMonthMatch;
    const monthIndex = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthName.slice(0, 3).toLowerCase());
    if (monthIndex >= 0) {
      const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
      return buildDate(year, monthIndex + 1, day);
    }
  }
  return null;
}

function normalizeVehicle(row) {
  return {
    id: String(row.id || `v-${Date.now()}`),
    client_id: row.clientId || row.client_id || "",
    type: row.type || "Truck",
    reg_no: row.regNo || row.reg_no || "",
    make: row.make || "",
    model: row.model || "",
    year: Number(row.year || 0),
    km: Number(row.km || 0),
    principal: Number(row.principal || 0),
    overdue: Number(row.overdue || 0),
    penalty: Number(row.penalty || 0),
    foreclosure: Number(row.foreclosure || 0),
    insurance_expiry: toMysqlDate(row.insuranceExpiry || row.insurance_expiry),
    permit_expiry: toMysqlDate(row.permitExpiry || row.permit_expiry),
    status: row.status || "Active"
  };
}

function normalizeDue(row) {
  return {
    id: String(row.id || `d-${Date.now()}`),
    client_id: row.clientId || row.client_id || "",
    vehicle_id: row.vehicleId || row.vehicle_id || null,
    type: row.type || "EMI",
    amount: Number(row.amount || 0),
    due_date: toMysqlDate(row.dueDate || row.due_date),
    status: row.status || "Due",
    caller_id: row.callerId || row.caller_id || null,
    priority: row.priority || "Medium"
  };
}

function normalizeListing(row) {
  return {
    id: String(row.id || `m-${Date.now()}`),
    vehicle_id: row.vehicleId || row.vehicle_id || "",
    title: row.title || "",
    price: Number(row.price || 0),
    location: row.location || "",
    status: row.status || "Submitted",
    condition_note: row.condition || row.condition_note || "Good"
  };
}

function normalizeClientImport(row) {
  return {
    id: String(row.id || `ci-${Date.now()}`),
    client_id: row.clientId || row.client_id || "",
    file_name: row.fileName || row.file_name || "Customer import",
    imported_at: row.importedAt || row.imported_at || new Date().toISOString(),
    rows: Array.isArray(row.rows) ? row.rows : []
  };
}

function normalizeDocument(row) {
  return {
    id: String(row.id || `doc-${Date.now()}`),
    client_id: row.clientId || row.client_id || "",
    vehicle_id: row.vehicleId || row.vehicle_id || "",
    task_id: row.taskId || row.task_id || "",
    type: row.type || "Other",
    file_name: row.fileName || row.file_name || "document",
    mime_type: row.mimeType || row.mime_type || "application/octet-stream",
    size_bytes: Number(row.size || row.size_bytes || 0),
    data_url: row.dataUrl || row.data_url || "",
    uploaded_by: row.uploadedBy || row.uploaded_by || "",
    uploaded_at: row.uploadedAt || row.uploaded_at || new Date().toLocaleString("en-IN"),
    note: row.note || ""
  };
}

function serializeDocument(row) {
  return {
    id: row.id,
    clientId: row.client_id,
    vehicleId: row.vehicle_id,
    taskId: row.task_id,
    type: row.type,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.size_bytes || 0),
    dataUrl: row.data_url,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    note: row.note || ""
  };
}

function normalizeCallerActivity(row) {
  return {
    id: String(row.id || `ca-${Date.now()}`),
    task_id: row.taskId || row.task_id || "",
    caller_id: row.callerId || row.caller_id || null,
    outcome: row.outcome || "",
    notes: row.notes || "",
    expected_amount: row.expectedAmount || row.expected_amount || "",
    next_follow_up: row.nextFollowUp || row.next_follow_up || "",
    channel: row.channel || "Call",
    occurred_at: row.at || row.occurred_at || new Date().toLocaleString("en-IN")
  };
}

function normalizeAuditLog(row) {
  return {
    id: String(row.id || `a-${Date.now()}`),
    module: row.module || "",
    action: row.action || "",
    record: row.record || "",
    old_value: row.oldValue || row.old_value || "",
    new_value: row.newValue || row.new_value || "",
    remark: row.remark || "",
    event_at: row.at || row.event_at || new Date().toLocaleString("en-IN")
  };
}

function normalizeImportRow(row) {
  return {
    row_no: Number(row.row || row.row_no || 0),
    reg_no: row.regNo || row.reg_no || "",
    asset_type: row.assetType || row.asset_type || "",
    client_name: row.clientName || row.client || row.client_name || "",
    loan_account: row.loanAccount || row.loan_account || "",
    lender: row.lender || "",
    status: row.status || "",
    issue: row.issue || ""
  };
}

function replaceMemoryCollection(collection, rows) {
  collection.splice(0, collection.length, ...rows);
}

async function validUserIdSet(conn, rows, key = "caller_id") {
  const ids = [...new Set(rows.map((row) => row[key]).filter(Boolean))];
  if (ids.length === 0) return new Set();
  const [users] = await conn.query("SELECT id FROM users WHERE id IN (?)", [ids]);
  return new Set(users.map((user) => user.id));
}

function nullInvalidUserIds(rows, validIds, key = "caller_id") {
  return rows.map((row) => ({
    ...row,
    [key]: row[key] && validIds.has(row[key]) ? row[key] : null
  }));
}

async function deleteMissingRows(conn, table, ids) {
  if (ids.length > 0) {
    await conn.query(`DELETE FROM ${table} WHERE id NOT IN (?)`, [ids]);
  } else {
    await conn.query(`DELETE FROM ${table}`);
  }
}

async function ensureCustomerUserForClient(client, conn = null) {
  if (!client?.email) return;
  const commonPassword = await getCommonPassword();
  const userId = client.id?.startsWith("c-") ? `u-${client.id.slice(2)}` : `u-${Date.now()}`;
  if (!dbAvailable) {
    const existing = memoryUsers.find((user) => user.email === client.email);
    if (existing) {
      existing.name = client.name;
      existing.role = existing.role || "Customer";
      return;
    }
    memoryUsers.push({
      id: userId,
      name: client.name,
      role: "Customer",
      email: client.email,
      password_hash: commonPassword
    });
    return;
  }
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  await query(
    `INSERT INTO users (id, name, role, email, password_hash)
     VALUES (?, ?, 'Customer', ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       role = VALUES(role),
       email = VALUES(email)`,
    [userId, client.name, client.email, commonPassword]
  );
}

async function pingDb() {
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
    await ensureSchemaReady();
    lastDbError = "";
  } catch (error) {
    dbAvailable = false;
    lastDbError = error?.message || String(error);
  }
}
pingDb();

async function ensureSchemaReady() {
  if (schemaReady) return;
  if (!schemaPromise) {
    schemaPromise = ensureCoreTables()
      .then(() => {
        schemaReady = true;
      })
      .finally(() => {
        schemaPromise = null;
      });
  }
  await schemaPromise;
}

async function ensureCoreTables() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(32) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      role ENUM('Admin','Owner','Caller','Customer') NOT NULL DEFAULT 'Owner',
      email VARCHAR(160),
      password_hash VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS clients (
      id VARCHAR(32) PRIMARY KEY,
      name VARCHAR(160) NOT NULL,
      email VARCHAR(160),
      city VARCHAR(80),
      phone VARCHAR(24),
      caller_id VARCHAR(32),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS vehicles (
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
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS due_tasks (
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
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS listings (
      id VARCHAR(48) PRIMARY KEY,
      vehicle_id VARCHAR(48) NOT NULL,
      title VARCHAR(200),
      price DECIMAL(14,2) DEFAULT 0,
      location VARCHAR(80),
      status VARCHAR(32) DEFAULT 'Submitted',
      condition_note VARCHAR(64) DEFAULT 'Good',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS caller_activities (
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
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS audit_logs (
      id VARCHAR(48) PRIMARY KEY,
      module VARCHAR(48),
      action VARCHAR(64),
      record VARCHAR(120),
      old_value VARCHAR(255),
      new_value VARCHAR(255),
      remark TEXT,
      event_at VARCHAR(64)
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS import_rows (
      id INT AUTO_INCREMENT PRIMARY KEY,
      row_no INT,
      reg_no VARCHAR(24),
      asset_type VARCHAR(24),
      client_name VARCHAR(160),
      loan_account VARCHAR(64),
      lender VARCHAR(80),
      status VARCHAR(32),
      issue VARCHAR(255)
    )`
  );
  await pool.query(
    `CREATE TABLE IF NOT EXISTS settings (
      setting_key VARCHAR(120) PRIMARY KEY,
      setting_value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`
  );
  await ensureClientsEmailColumn();
  await ensureUsersMobileColumn();
  await ensureClientImportsTable();
  await ensureDocumentsTable();
  await ensureAdminUser();
}

async function ensureUsersMobileColumn(conn = null) {
  if (!dbAvailable) return;
  if (usersMobileReady) return;
  if (!conn && usersMobilePromise) return usersMobilePromise;
  if (!conn) {
    usersMobilePromise = ensureUsersMobileColumn(pool)
      .finally(() => {
        usersMobilePromise = null;
      });
    return usersMobilePromise;
  }
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  try {
    await query("ALTER TABLE users ADD COLUMN mobile VARCHAR(24) NULL AFTER email");
    usersMobileReady = true;
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    if (!message.includes("duplicate column")) throw error;
    usersMobileReady = true;
    // Existing deployments may have mobile as NOT NULL without default; relax it.
    try {
      await query("ALTER TABLE users MODIFY mobile VARCHAR(24) NULL");
    } catch (modifyError) {
      const modifyMessage = String(modifyError?.message || "").toLowerCase();
      if (!modifyMessage.includes("unknown column") && !modifyMessage.includes("duplicate column")) throw modifyError;
    }
  }
}

async function ensureAdminUser() {
  const adminEmail = String(process.env.ADMIN_EMAIL || "admin@kuber.local").trim().toLowerCase();
  const adminPassword = String(process.env.ADMIN_PASSWORD || "admin123");
  await pool.query(
    `INSERT INTO users (id, name, role, email, password_hash)
     VALUES ('u-admin', 'Admin', 'Admin', ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       role = VALUES(role),
       email = VALUES(email),
       password_hash = VALUES(password_hash)`,
    [adminEmail, adminPassword]
  );
}

async function ensureClientImportsTable(conn = null) {
  if (!dbAvailable) return;
  if (clientImportsReady) return;
  if (!conn && clientImportsPromise) return clientImportsPromise;
  if (!conn) {
    clientImportsPromise = ensureClientImportsTable(pool)
      .finally(() => {
        clientImportsPromise = null;
      });
    return clientImportsPromise;
  }
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  await query(
    `CREATE TABLE IF NOT EXISTS client_imports (
      id VARCHAR(64) PRIMARY KEY,
      client_id VARCHAR(32) NOT NULL,
      file_name VARCHAR(255),
      imported_at VARCHAR(64),
      rows_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
    )`
  );
  const columns = [
    ["file_name", "ALTER TABLE client_imports ADD COLUMN file_name VARCHAR(255) NULL AFTER client_id"],
    ["imported_at", "ALTER TABLE client_imports ADD COLUMN imported_at VARCHAR(64) NULL AFTER file_name"],
    ["rows_json", "ALTER TABLE client_imports ADD COLUMN rows_json JSON NULL AFTER imported_at"]
  ];
  for (const [name, statement] of columns) {
    try {
      await query(statement);
    } catch (error) {
      const message = String(error?.message || "").toLowerCase();
      if (!message.includes("duplicate column")) throw error;
    }
  }
  clientImportsReady = true;
}

async function ensureDocumentsTable(conn = null) {
  if (!dbAvailable) return;
  if (documentsReady) return;
  if (!conn && documentsPromise) return documentsPromise;
  if (!conn) {
    documentsPromise = ensureDocumentsTable(pool)
      .finally(() => {
        documentsPromise = null;
      });
    return documentsPromise;
  }
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  await query(
    `CREATE TABLE IF NOT EXISTS documents (
      id VARCHAR(64) PRIMARY KEY,
      client_id VARCHAR(32),
      vehicle_id VARCHAR(48),
      task_id VARCHAR(48),
      type VARCHAR(64),
      file_name VARCHAR(255),
      mime_type VARCHAR(120),
      size_bytes INT DEFAULT 0,
      data_url LONGTEXT,
      uploaded_by VARCHAR(120),
      uploaded_at VARCHAR(64),
      note TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_documents_client (client_id),
      INDEX idx_documents_vehicle (vehicle_id),
      INDEX idx_documents_task (task_id)
    )`
  );
  documentsReady = true;
}

async function ensureClientsEmailColumn(conn = null) {
  if (!dbAvailable) return;
  if (clientsEmailReady) return;
  if (!conn && clientsEmailPromise) return clientsEmailPromise;
  if (!conn) {
    clientsEmailPromise = ensureClientsEmailColumn(pool)
      .finally(() => {
        clientsEmailPromise = null;
      });
    return clientsEmailPromise;
  }
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  try {
    await query("ALTER TABLE clients ADD COLUMN email VARCHAR(160) AFTER name");
    clientsEmailReady = true;
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    if (!message.includes("duplicate column")) throw error;
    clientsEmailReady = true;
  }
}

// Helper to handle async route errors
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

app.use("/api", asyncHandler(async (req, res, next) => {
  if (req.path === "/health") return next();
  await pingDb();
  if (REQUIRE_DATABASE && !dbAvailable) {
    return res.status(503).json({
      error: "Database connection is not available.",
      message: "Configure DB_HOST, DB_PORT, DB_USER, DB_PASSWORD and DB_NAME in backend/.env.",
      config: {
        host: dbSettings.host,
        port: dbSettings.port,
        user: dbSettings.user,
        database: dbSettings.database,
        ssl: process.env.DB_SSL === "true"
      },
      detail: lastDbError
    });
  }
  next();
}));

// Health check
app.get("/api/health", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json({
      status: REQUIRE_DATABASE ? "error" : "ok",
      mode: REQUIRE_DATABASE ? "mysql_unavailable" : "memory",
      dbTime: null,
      message: REQUIRE_DATABASE
        ? "MySQL is required but not reachable. Set the deployed database host and credentials."
        : "MySQL not reachable; using built-in storage.",
      config: {
        host: dbSettings.host,
        port: dbSettings.port,
        user: dbSettings.user,
        database: dbSettings.database,
        ssl: process.env.DB_SSL === "true"
      },
      detail: lastDbError
    });
  }
  const now = await pool.query("SELECT NOW() AS now");
  res.json({ status: "ok", mode: "mysql", dbTime: now[0][0].now });
}));

function findUserByEmail(email) {
  return memoryUsers.find((u) => u.email === String(email || "").trim().toLowerCase());
}

function customerNameFromEmail(email) {
  const local = String(email || "customer").split("@")[0] || "customer";
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .trim() || "Customer";
}

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findMemoryClientForCustomer(email, name) {
  const lowerEmail = String(email || "").trim().toLowerCase();
  const emailName = normalizeName(customerNameFromEmail(email));
  const userName = normalizeName(name);
  return memoryClients.find((client) => {
    if (lowerEmail && String(client.email || "").trim().toLowerCase() === lowerEmail) return true;
    const clientName = normalizeName(client.name);
    return clientName && (clientName === emailName || clientName === userName);
  });
}

function createMemoryCustomerAccount(email, password) {
  const lowerEmail = String(email).trim().toLowerCase();
  const name = customerNameFromEmail(lowerEmail);
  const matchedClient = findMemoryClientForCustomer(lowerEmail, name);
  const id = matchedClient?.id?.startsWith("c-")
    ? `u-${matchedClient.id.slice(2)}`
    : `u-${Date.now()}`;
  const user = { id, name, role: "Customer", email: lowerEmail, password_hash: String(password) };
  const client = matchedClient ?? { id: `c-${id.slice(2)}`, name, email: lowerEmail, city: "", phone: "", caller_id: null, password: String(password) };
  memoryUsers.push(user);
  if (!matchedClient) {
    memoryClients.push(client);
  }
  return { user, client };
}

// Supports the scrypt salt:hash format used by seed.sql while remaining
// compatible with the temporary plaintext passwords created by this build.
function verifyPassword(password, storedValue) {
  const stored = String(storedValue || "");
  if (!stored) return false;
  const parts = stored.split(":");
  if (parts.length === 2 && /^[0-9a-f]+$/i.test(parts[0]) && /^[0-9a-f]+$/i.test(parts[1])) {
    try {
      const calculated = crypto.scryptSync(String(password), parts[0], parts[1].length / 2).toString("hex");
      const a = Buffer.from(calculated, "hex");
      const b = Buffer.from(parts[1], "hex");
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }
  return stored === String(password);
}

let commonPasswordStore = "";
let commonCustomerPassword = process.env.COMMON_CUSTOMER_PASSWORD || "Kuber@123";

// ─── Common customer password (admin sets this) ───────────
app.get("/api/common-password", asyncHandler(async (req, res) => {
  await getCommonPassword();
  res.json({ configured: Boolean(commonPasswordStore), value: commonPasswordStore || "" });
}));

app.get("/api/settings", asyncHandler(async (req, res) => {
  const value = await getCommonPassword();
  res.json({ commonCustomerPassword: value });
}));

app.get("/api/common-password-value", asyncHandler(async (req, res) => {
  const value = await getCommonPassword();
  res.json({ value });
}));

async function getCommonPassword() {
  if (commonPasswordStore) return commonPasswordStore;
  if (dbAvailable) {
    try {
      const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'common_customer_password' LIMIT 1");
      if (rows.length && rows[0].setting_value) {
        commonPasswordStore = rows[0].setting_value;
        return commonPasswordStore;
      }
    } catch { /* ignore */ }
  }
  return commonCustomerPassword;
}

app.put("/api/common-password", asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (!password || String(password).trim().length < 1) {
    return res.status(400).json({ error: "Password required." });
  }
  // Store in a settings store. In-memory and in DB settings table.
  commonPasswordStore = String(password).trim();
  commonCustomerPassword = commonPasswordStore;
  if (dbAvailable) {
    try {
      await pool.query("INSERT INTO settings (setting_key, setting_value) VALUES ('common_customer_password', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [commonPasswordStore]);
    } catch { /* table may not exist */ }
  }
  res.json({ ok: true, commonPassword: commonPasswordStore });
}));

// ─── Users ────────────────────────────────────────────────
app.get("/api/users", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryUsers);
  }
  const [rows] = await pool.query("SELECT * FROM users");
  res.json(rows);
}));

app.post("/api/users", asyncHandler(async (req, res) => {
  const { name, email, password: clientPassword } = req.body;
  const commonPassword = await getCommonPassword();
  const password = clientPassword || commonPassword;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required." });
  }
  const lowerEmail = String(email).trim().toLowerCase();
  const id = `u-${Date.now()}`;
  const userRole = "Customer";
  const clientId = `c-${id.slice(2)}`;

  await pingDb();
  if (!dbAvailable) {
    if (memoryUsers.some((u) => u.email === lowerEmail)) {
      return res.status(400).json({ error: "Email already exists." });
    }
    const client = { id: clientId, name, email: lowerEmail, city: "", phone: "", caller_id: null, password };
    memoryUsers.push({ id, name, role: userRole, email: lowerEmail, password_hash: password });
    memoryClients.push(client);
    return res.status(201).json({ id, name, email: lowerEmail, role: userRole, clientId, mode: "memory" });
  }

  await ensureClientsEmailColumn();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO users (id, name, role, email, password_hash) VALUES (?, ?, ?, ?, ?)",
      [id, name, userRole, lowerEmail, password]
    );
    await conn.query(
      "INSERT INTO clients (id, name, email, city, phone, caller_id) VALUES (?, ?, ?, '', '', NULL)",
      [clientId, name, lowerEmail]
    );
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.status(201).json({ id, name, email: lowerEmail, role: userRole, clientId, mode: "mysql" });
}));

// Delete a customer account + client
app.delete("/api/users/:id", asyncHandler(async (req, res) => {
  const { id } = req.params;
  await pingDb();
  if (!dbAvailable) {
    const index = memoryUsers.findIndex((u) => u.id === id);
    if (index === -1) return res.status(404).json({ error: "User not found" });
    const user = memoryUsers[index];
    memoryUsers.splice(index, 1);
    const clientId = `c-${user.id.slice(2)}`;
    const clientIndex = memoryClients.findIndex((c) => c.id === clientId);
    if (clientIndex >= 0) memoryClients.splice(clientIndex, 1);
    const vehicleIds = new Set(memoryVehicles.filter((vehicle) => vehicle.client_id === clientId).map((vehicle) => vehicle.id));
    for (let i = memoryVehicles.length - 1; i >= 0; i -= 1) {
      if (memoryVehicles[i].client_id === clientId) memoryVehicles.splice(i, 1);
    }
    for (let i = memoryDues.length - 1; i >= 0; i -= 1) {
      if (memoryDues[i].client_id === clientId) memoryDues.splice(i, 1);
    }
    for (let i = memoryListings.length - 1; i >= 0; i -= 1) {
      if (vehicleIds.has(memoryListings[i].vehicle_id)) memoryListings.splice(i, 1);
    }
    return res.json({ ok: true, id, mode: "memory" });
  }
  await pool.query("DELETE FROM users WHERE id = ?", [id]);
  await pool.query("DELETE FROM clients WHERE id = ?", [`c-${id.slice(2)}`]);
  res.json({ ok: true, id, mode: "mysql" });
}));

// Login: verify credentials against the users table
app.post("/api/login", asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
  const lowerEmail = String(email).trim().toLowerCase();
  const commonPassword = await getCommonPassword();

  await pingDb();
  if (!dbAvailable) {
    let user = memoryUsers.find((u) => u.email === lowerEmail);
    if (!user) {
      if (password === commonPassword) {
        const created = createMemoryCustomerAccount(lowerEmail, commonPassword);
        return res.json({
          id: created.user.id,
          name: created.user.name,
          role: created.user.role,
          email: created.user.email,
          clientId: created.client.id,
          needsPasswordChange: true,
          mode: "memory"
        });
      }
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const usingCommon = password === commonPassword;
    const usingOwn = verifyPassword(password, user.password_hash);
    if (!usingCommon && !usingOwn) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const client = memoryClients.find((c) => c.id === `c-${user.id.slice(2)}`)
      ?? findMemoryClientForCustomer(user.email, user.name);
    return res.json({
      id: user.id,
      name: user.name,
      role: user.role,
      email: user.email,
      clientId: client ? client.id : null,
      needsPasswordChange: usingCommon && user.role !== "Admin",
      mode: "memory"
    });
  }
  await ensureClientsEmailColumn();

  // Resolve the user and client separately. A multi-condition JOIN can select
  // an unrelated client when names are duplicated, producing an empty portal.
  const [rows] = await pool.query(
    `SELECT * FROM users
     WHERE LOWER(TRIM(email)) = ?
     ORDER BY CASE WHEN id = 'u-admin' THEN 0 ELSE 1 END, created_at DESC
     LIMIT 1`,
    [lowerEmail]
  );
  if (!rows.length) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  const user = rows[0];
  const usingCommon = password === commonPassword;
  const usingOwn = verifyPassword(password, user.password_hash);
  if (!usingCommon && !usingOwn) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  let clientId = null;
  if (String(user.role).toLowerCase() !== "admin") {
    const expectedClientId = String(user.id).startsWith("u-")
      ? `c-${String(user.id).slice(2)}`
      : "";
    const [clientRows] = await pool.query(
      `SELECT id FROM clients
       WHERE id = ?
          OR LOWER(TRIM(email)) = ?
          OR LOWER(TRIM(name)) = LOWER(TRIM(?))
       ORDER BY CASE
         WHEN id = ? THEN 0
         WHEN LOWER(TRIM(email)) = ? THEN 1
         ELSE 2
       END, created_at DESC
       LIMIT 1`,
      [expectedClientId, lowerEmail, user.name, expectedClientId, lowerEmail]
    );
    clientId = clientRows[0]?.id || null;
  }
  res.json({
    id: user.id,
    name: user.name,
    role: user.role,
    email: user.email,
    clientId,
    needsPasswordChange: usingCommon && user.role !== "Admin",
    mode: "mysql"
  });
}));

// Change customer's own password
app.post("/api/change-password", asyncHandler(async (req, res) => {
  const { id, newPassword } = req.body;
  if (!id || !newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ error: "New password must be at least 4 characters." });
  }
  const lowerId = String(id);
  await pingDb();
  if (!dbAvailable) {
    const user = memoryUsers.find((u) => u.id === lowerId);
    if (!user) return res.status(404).json({ error: "User not found" });
    user.password_hash = String(newPassword);
    return res.json({ ok: true, mode: "memory" });
  }
  await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [String(newPassword), lowerId]);
  res.json({ ok: true, mode: "mysql" });
}));

// ─── Clients ──────────────────────────────────────────────
app.get("/api/clients", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryClients);
  }
  await ensureClientsEmailColumn();
  const [rows] = await pool.query("SELECT * FROM clients");
  res.json(rows);
}));

app.get("/api/clients/:id", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    const row = memoryClients.find((c) => c.id === req.params.id);
    if (!row) return res.status(404).json({ error: "Client not found" });
    return res.json(row);
  }
  await ensureClientsEmailColumn();
  const [rows] = await pool.query("SELECT * FROM clients WHERE id = ?", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "Client not found" });
  res.json(rows[0]);
}));

// ─── Vehicles ─────────────────────────────────────────────
app.get("/api/vehicles", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryVehicles);
  }
  const [rows] = await pool.query(
    `SELECT v.*, c.name AS client_name
     FROM vehicles v
     LEFT JOIN clients c ON c.id = v.client_id`
  );
  res.json(rows);
}));

app.get("/api/vehicles/:id", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    const row = memoryVehicles.find((vehicle) => vehicle.id === req.params.id);
    if (!row) return res.status(404).json({ error: "Vehicle not found" });
    return res.json(row);
  }
  const [rows] = await pool.query(
    `SELECT v.*, c.name AS client_name
     FROM vehicles v
     LEFT JOIN clients c ON c.id = v.client_id
     WHERE v.id = ?`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Vehicle not found" });
  res.json(rows[0]);
}));

// ─── Due Tasks ───────────────────────────────────────────
app.get("/api/dues", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryDues);
  }
  const [rows] = await pool.query(
    `SELECT d.*, c.name AS client_name, v.reg_no AS vehicle_reg_no
     FROM due_tasks d
     LEFT JOIN clients c ON c.id = d.client_id
     LEFT JOIN vehicles v ON v.id = d.vehicle_id`
  );
  res.json(rows);
}));

// ─── Listings ────────────────────────────────────────────
app.get("/api/listings", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryListings);
  }
  const [rows] = await pool.query("SELECT * FROM listings");
  res.json(rows);
}));

// ─── Caller Activities ──────────────────────────────────
app.get("/api/caller-activities", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryCallerActivities);
  }
  const [rows] = await pool.query("SELECT * FROM caller_activities");
  res.json(rows);
}));

// ─── Audit Logs ─────────────────────────────────────────
app.get("/api/audit-logs", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryAuditLogs);
  }
  const [rows] = await pool.query("SELECT * FROM audit_logs");
  res.json(rows);
}));

// ─── Import Rows ────────────────────────────────────────
app.get("/api/imports", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryImportRows);
  }
  const [rows] = await pool.query("SELECT * FROM import_rows");
  res.json(rows);
}));

app.get("/api/client-imports", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryClientImports.map((item) => ({
      id: item.id,
      clientId: item.client_id,
      fileName: item.file_name,
      importedAt: item.imported_at,
      rows: item.rows
    })));
  }
  await ensureClientImportsTable();
  const [rows] = await pool.query("SELECT * FROM client_imports ORDER BY created_at DESC");
  res.json(rows.map((item) => ({
    id: item.id,
    clientId: item.client_id,
    fileName: item.file_name,
    importedAt: item.imported_at,
    rows: typeof item.rows_json === "string" ? JSON.parse(item.rows_json || "[]") : (item.rows_json || [])
  })));
}));

app.get("/api/documents", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryDocuments.map(serializeDocument));
  }
  await ensureDocumentsTable();
  const [rows] = await pool.query("SELECT * FROM documents ORDER BY created_at DESC");
  res.json(rows.map(serializeDocument));
}));

app.post("/api/documents", asyncHandler(async (req, res) => {
  const document = normalizeDocument(req.body || {});
  if (!document.client_id || !document.vehicle_id || !document.task_id) {
    return res.status(400).json({ error: "clientId, vehicleId and taskId are required." });
  }
  if (!document.data_url) {
    return res.status(400).json({ error: "Document file content is required." });
  }
  await pingDb();
  if (!dbAvailable) {
    upsertMemoryItem(memoryDocuments, document);
    return res.status(201).json(serializeDocument(document));
  }
  await ensureDocumentsTable();
  await pool.query(
    `INSERT INTO documents
      (id, client_id, vehicle_id, task_id, type, file_name, mime_type, size_bytes, data_url, uploaded_by, uploaded_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       client_id = VALUES(client_id),
       vehicle_id = VALUES(vehicle_id),
       task_id = VALUES(task_id),
       type = VALUES(type),
       file_name = VALUES(file_name),
       mime_type = VALUES(mime_type),
       size_bytes = VALUES(size_bytes),
       data_url = VALUES(data_url),
       uploaded_by = VALUES(uploaded_by),
       uploaded_at = VALUES(uploaded_at),
       note = VALUES(note)`,
    [
      document.id,
      document.client_id,
      document.vehicle_id,
      document.task_id,
      document.type,
      document.file_name,
      document.mime_type,
      document.size_bytes,
      document.data_url,
      document.uploaded_by,
      document.uploaded_at,
      document.note
    ]
  );
  res.status(201).json(serializeDocument(document));
}));

app.delete("/api/documents/:id", asyncHandler(async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Document id is required." });
  await pingDb();
  if (!dbAvailable) {
    const index = memoryDocuments.findIndex((document) => document.id === id);
    if (index >= 0) memoryDocuments.splice(index, 1);
    return res.json({ ok: true, deleted: id });
  }
  await ensureDocumentsTable();
  await pool.query("DELETE FROM documents WHERE id = ?", [id]);
  res.json({ ok: true, deleted: id });
}));

app.post("/api/sync", asyncHandler(async (req, res) => {
  const clients = Array.isArray(req.body?.clients) ? req.body.clients.map(normalizeClient).filter((row) => row.id && row.name) : [];
  const vehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles.map(normalizeVehicle).filter((row) => row.id && row.client_id) : [];
  const dueTasks = Array.isArray(req.body?.dueTasks) ? req.body.dueTasks.map(normalizeDue).filter((row) => row.id && row.client_id) : [];
  const listings = Array.isArray(req.body?.listings) ? req.body.listings.map(normalizeListing).filter((row) => row.id && row.vehicle_id) : [];
  const callerActivities = Array.isArray(req.body?.callerActivities) ? req.body.callerActivities.map(normalizeCallerActivity).filter((row) => row.id && row.task_id) : [];
  const auditLogs = Array.isArray(req.body?.auditLogs) ? req.body.auditLogs.map(normalizeAuditLog).filter((row) => row.id) : [];
  const importRows = Array.isArray(req.body?.importRows) ? req.body.importRows.map(normalizeImportRow) : [];
  const clientImports = Array.isArray(req.body?.clientImports) ? req.body.clientImports.map(normalizeClientImport).filter((row) => row.id && row.client_id) : [];
  const documents = Array.isArray(req.body?.documents) ? req.body.documents.map(normalizeDocument).filter((row) => row.id && row.client_id && row.vehicle_id && row.task_id) : null;

  await pingDb();
  if (!dbAvailable) {
    replaceMemoryCollection(memoryClients, clients);
    replaceMemoryCollection(memoryVehicles, vehicles);
    replaceMemoryCollection(memoryDues, dueTasks);
    replaceMemoryCollection(memoryListings, listings);
    replaceMemoryCollection(memoryCallerActivities, callerActivities);
    replaceMemoryCollection(memoryAuditLogs, auditLogs);
    replaceMemoryCollection(memoryImportRows, importRows);
    replaceMemoryCollection(memoryClientImports, clientImports);
    if (documents) replaceMemoryCollection(memoryDocuments, documents);
    for (const client of clients) {
      await ensureCustomerUserForClient(client);
    }
    return res.json({
      ok: true,
      mode: "memory",
      synced: { clients: clients.length, vehicles: vehicles.length, dueTasks: dueTasks.length, listings: listings.length, callerActivities: callerActivities.length, auditLogs: auditLogs.length, importRows: importRows.length, clientImports: clientImports.length, documents: documents?.length ?? memoryDocuments.length }
    });
  }

  await ensureClientsEmailColumn();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureClientImportsTable(conn);
    await ensureDocumentsTable(conn);
    const clientCallerIds = await validUserIdSet(conn, clients);
    const dueCallerIds = await validUserIdSet(conn, dueTasks);
    const activityCallerIds = await validUserIdSet(conn, callerActivities);
    const safeClients = nullInvalidUserIds(clients, clientCallerIds);
    const safeDueTasks = nullInvalidUserIds(dueTasks, dueCallerIds);
    const safeCallerActivities = nullInvalidUserIds(callerActivities, activityCallerIds);

    for (const client of safeClients) {
      await conn.query(
        `INSERT INTO clients (id, name, email, city, phone, caller_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           email = VALUES(email),
           city = VALUES(city),
           phone = VALUES(phone),
           caller_id = VALUES(caller_id)`,
        [client.id, client.name, client.email, client.city, client.phone, client.caller_id]
      );
      await ensureCustomerUserForClient(client, conn);
    }
    for (const vehicle of vehicles) {
      await conn.query(
        `INSERT INTO vehicles
          (id, client_id, type, reg_no, make, model, year, km, principal, overdue, penalty, foreclosure, insurance_expiry, permit_expiry, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           client_id = VALUES(client_id),
           type = VALUES(type),
           reg_no = VALUES(reg_no),
           make = VALUES(make),
           model = VALUES(model),
           year = VALUES(year),
           km = VALUES(km),
           principal = VALUES(principal),
           overdue = VALUES(overdue),
           penalty = VALUES(penalty),
           foreclosure = VALUES(foreclosure),
           insurance_expiry = VALUES(insurance_expiry),
           permit_expiry = VALUES(permit_expiry),
           status = VALUES(status)`,
        [
          vehicle.id,
          vehicle.client_id,
          vehicle.type,
          vehicle.reg_no,
          vehicle.make,
          vehicle.model,
          vehicle.year,
          vehicle.km,
          vehicle.principal,
          vehicle.overdue,
          vehicle.penalty,
          vehicle.foreclosure,
          vehicle.insurance_expiry,
          vehicle.permit_expiry,
          vehicle.status
        ]
      );
    }
    for (const due of safeDueTasks) {
      await conn.query(
        `INSERT INTO due_tasks
          (id, client_id, vehicle_id, type, amount, due_date, status, caller_id, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           client_id = VALUES(client_id),
           vehicle_id = VALUES(vehicle_id),
           type = VALUES(type),
           amount = VALUES(amount),
           due_date = VALUES(due_date),
           status = VALUES(status),
           caller_id = VALUES(caller_id),
           priority = VALUES(priority)`,
        [due.id, due.client_id, due.vehicle_id, due.type, due.amount, due.due_date, due.status, due.caller_id, due.priority]
      );
    }
    for (const listing of listings) {
      await conn.query(
        `INSERT INTO listings
          (id, vehicle_id, title, price, location, status, condition_note)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           vehicle_id = VALUES(vehicle_id),
           title = VALUES(title),
           price = VALUES(price),
           location = VALUES(location),
           status = VALUES(status),
           condition_note = VALUES(condition_note)`,
        [listing.id, listing.vehicle_id, listing.title, listing.price, listing.location, listing.status, listing.condition_note]
      );
    }
    for (const item of clientImports) {
      await conn.query(
        `INSERT INTO client_imports (id, client_id, file_name, imported_at, rows_json)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           client_id = VALUES(client_id),
           file_name = VALUES(file_name),
           imported_at = VALUES(imported_at),
           rows_json = VALUES(rows_json)`,
        [item.id, item.client_id, item.file_name, item.imported_at, JSON.stringify(item.rows)]
      );
    }
    if (documents) {
      for (const document of documents) {
        await conn.query(
          `INSERT INTO documents
            (id, client_id, vehicle_id, task_id, type, file_name, mime_type, size_bytes, data_url, uploaded_by, uploaded_at, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             client_id = VALUES(client_id),
             vehicle_id = VALUES(vehicle_id),
             task_id = VALUES(task_id),
             type = VALUES(type),
             file_name = VALUES(file_name),
             mime_type = VALUES(mime_type),
             size_bytes = VALUES(size_bytes),
             data_url = VALUES(data_url),
             uploaded_by = VALUES(uploaded_by),
             uploaded_at = VALUES(uploaded_at),
             note = VALUES(note)`,
          [
            document.id,
            document.client_id,
            document.vehicle_id,
            document.task_id,
            document.type,
            document.file_name,
            document.mime_type,
            document.size_bytes,
            document.data_url,
            document.uploaded_by,
            document.uploaded_at,
            document.note
          ]
        );
      }
    }
    for (const activity of safeCallerActivities) {
      await conn.query(
        `INSERT INTO caller_activities
          (id, task_id, caller_id, outcome, notes, expected_amount, next_follow_up, channel, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           task_id = VALUES(task_id),
           caller_id = VALUES(caller_id),
           outcome = VALUES(outcome),
           notes = VALUES(notes),
           expected_amount = VALUES(expected_amount),
           next_follow_up = VALUES(next_follow_up),
           channel = VALUES(channel),
           occurred_at = VALUES(occurred_at)`,
        [activity.id, activity.task_id, activity.caller_id, activity.outcome, activity.notes, activity.expected_amount, activity.next_follow_up, activity.channel, activity.occurred_at]
      );
    }
    for (const log of auditLogs) {
      await conn.query(
        `INSERT INTO audit_logs
          (id, module, action, record, old_value, new_value, remark, event_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           module = VALUES(module),
           action = VALUES(action),
           record = VALUES(record),
           old_value = VALUES(old_value),
           new_value = VALUES(new_value),
           remark = VALUES(remark),
           event_at = VALUES(event_at)`,
        [log.id, log.module, log.action, log.record, log.old_value, log.new_value, log.remark, log.event_at]
      );
    }
    await conn.query("DELETE FROM import_rows");
    for (const row of importRows) {
      await conn.query(
        `INSERT INTO import_rows
          (row_no, reg_no, asset_type, client_name, loan_account, lender, status, issue)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.row_no, row.reg_no, row.asset_type, row.client_name, row.loan_account, row.lender, row.status, row.issue]
      );
    }
    await deleteMissingRows(conn, "caller_activities", callerActivities.map((item) => item.id));
    await deleteMissingRows(conn, "audit_logs", auditLogs.map((item) => item.id));
    await deleteMissingRows(conn, "client_imports", clientImports.map((item) => item.id));
    await deleteMissingRows(conn, "listings", listings.map((item) => item.id));
    await deleteMissingRows(conn, "due_tasks", dueTasks.map((item) => item.id));
    await deleteMissingRows(conn, "vehicles", vehicles.map((item) => item.id));
    await deleteMissingRows(conn, "clients", clients.map((item) => item.id));
    await conn.commit();
    res.json({
      ok: true,
      mode: "mysql",
      synced: { clients: clients.length, vehicles: vehicles.length, dueTasks: dueTasks.length, listings: listings.length, callerActivities: callerActivities.length, auditLogs: auditLogs.length, importRows: importRows.length, clientImports: clientImports.length, documents: documents?.length ?? 0 }
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}));

// Error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`TransportSoft API running on http://localhost:${PORT}`);
  console.log(`  Database: ${dbAvailable ? "MySQL connected" : "MySQL not reachable — using built-in storage"}`);
  console.log(`  Admin login: admin@kuber.local / admin123`);
});
