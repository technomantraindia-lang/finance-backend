const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

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
const databaseUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || "";
const databaseConfig = databaseUrl ? new URL(databaseUrl) : null;
const pool = mysql.createPool({
  host: databaseConfig?.hostname || process.env.DB_HOST || "localhost",
  port: Number(databaseConfig?.port || process.env.DB_PORT || 3306),
  user: databaseConfig ? decodeURIComponent(databaseConfig.username) : (process.env.DB_USER || "transportsoft"),
  password: databaseConfig ? decodeURIComponent(databaseConfig.password) : (process.env.DB_PASSWORD || ""),
  database: databaseConfig ? databaseConfig.pathname.replace(/^\//, "") : (process.env.DB_NAME || "transportsoft"),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined
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
    insurance_expiry: row.insuranceExpiry || row.insurance_expiry || null,
    permit_expiry: row.permitExpiry || row.permit_expiry || null,
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
    due_date: row.dueDate || row.due_date || null,
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
  } catch {
    dbAvailable = false;
  }
}
pingDb();

async function ensureClientImportsTable(conn = null) {
  if (!dbAvailable) return;
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
}

async function ensureClientsEmailColumn(conn = null) {
  if (!dbAvailable) return;
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  try {
    await query("ALTER TABLE clients ADD COLUMN email VARCHAR(160) AFTER name");
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    if (!message.includes("duplicate column")) throw error;
  }
}

// Helper to handle async route errors
const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// Health check
app.get("/api/health", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json({ status: "ok", mode: "memory", dbTime: null, message: "MySQL not reachable; using built-in storage." });
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

  const [rows] = await pool.query(
    `SELECT u.*, c.id AS client_id
     FROM users u
     LEFT JOIN clients c ON c.id = CONCAT('c-', SUBSTRING(u.id, 3)) OR LOWER(TRIM(c.email)) = LOWER(TRIM(u.email)) OR LOWER(TRIM(c.name)) = LOWER(TRIM(u.name))
     WHERE u.email = ?`,
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
  res.json({
    id: user.id,
    name: user.name,
    role: user.role,
    email: user.email,
    clientId: user.client_id || null,
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

app.post("/api/sync", asyncHandler(async (req, res) => {
  const clients = Array.isArray(req.body?.clients) ? req.body.clients.map(normalizeClient).filter((row) => row.id && row.name) : [];
  const vehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles.map(normalizeVehicle).filter((row) => row.id && row.client_id) : [];
  const dueTasks = Array.isArray(req.body?.dueTasks) ? req.body.dueTasks.map(normalizeDue).filter((row) => row.id && row.client_id) : [];
  const listings = Array.isArray(req.body?.listings) ? req.body.listings.map(normalizeListing).filter((row) => row.id && row.vehicle_id) : [];
  const clientImports = Array.isArray(req.body?.clientImports) ? req.body.clientImports.map(normalizeClientImport).filter((row) => row.id && row.client_id) : [];

  await pingDb();
  if (!dbAvailable) {
    for (const client of clients) {
      upsertMemoryItem(memoryClients, client);
      await ensureCustomerUserForClient(client);
    }
    vehicles.forEach((vehicle) => upsertMemoryItem(memoryVehicles, vehicle));
    dueTasks.forEach((due) => upsertMemoryItem(memoryDues, due));
    listings.forEach((listing) => upsertMemoryItem(memoryListings, listing));
    clientImports.forEach((item) => upsertMemoryItem(memoryClientImports, item));
    return res.json({
      ok: true,
      mode: "memory",
      synced: { clients: clients.length, vehicles: vehicles.length, dueTasks: dueTasks.length, listings: listings.length, clientImports: clientImports.length }
    });
  }

  await ensureClientsEmailColumn();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureClientImportsTable(conn);
    for (const client of clients) {
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
    for (const due of dueTasks) {
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
    await conn.commit();
    res.json({
      ok: true,
      mode: "mysql",
      synced: { clients: clients.length, vehicles: vehicles.length, dueTasks: dueTasks.length, listings: listings.length, clientImports: clientImports.length }
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
