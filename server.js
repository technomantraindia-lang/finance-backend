const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Kuber Finance API",
    health: "/api/health"
  });
});

// ─── Database connection pool ─────────────────────────────
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "transportsoft",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "transportsoft",
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0
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
  },
  {
    id: "u-customer",
    name: "Customer",
    role: "Customer",
    email: "customer@kuber.local",
    password_hash: "Kuber@123"
  }
];
const memoryClients = [
  { id: "c-customer", name: "Customer", city: "Ahmedabad", phone: "+919999999999", caller_id: null, password: "Kuber@123" }
];
const memoryVehicles = [];
const memoryDues = [];
const memoryListings = [];
const memoryCallerActivities = [];
const memoryAuditLogs = [];
const memoryImportRows = [];

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

memoryClients.forEach(createMemoryFleetForClient);

async function pingDb() {
  try {
    await pool.query("SELECT 1");
    dbAvailable = true;
  } catch {
    dbAvailable = false;
  }
}
pingDb();

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
    const client = { id: clientId, name, city: "", phone: "", caller_id: null, password };
    memoryUsers.push({ id, name, role: userRole, email: lowerEmail, password_hash: password });
    memoryClients.push(client);
    createMemoryFleetForClient(client);
    return res.status(201).json({ id, name, email: lowerEmail, role: userRole, clientId, mode: "memory" });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO users (id, name, role, email, password_hash) VALUES (?, ?, ?, ?, ?)",
      [id, name, userRole, lowerEmail, password]
    );
    await conn.query(
      "INSERT INTO clients (id, name, city, phone, caller_id) VALUES (?, ?, '', '', NULL)",
      [clientId, name]
    );
    const starter = starterRecordsForClient({ id: clientId, name, city: "", phone: "", caller_id: null });
    for (const vehicle of starter.vehicles) {
      await conn.query(
        `INSERT INTO vehicles
          (id, client_id, type, reg_no, make, model, year, km, principal, overdue, penalty, foreclosure, insurance_expiry, permit_expiry, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    for (const due of starter.dues) {
      await conn.query(
        `INSERT INTO due_tasks
          (id, client_id, vehicle_id, type, amount, due_date, status, caller_id, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          due.id,
          due.client_id,
          due.vehicle_id,
          due.type,
          due.amount,
          due.due_date,
          due.status,
          due.caller_id,
          due.priority
        ]
      );
    }
    for (const listing of starter.listings) {
      await conn.query(
        `INSERT INTO listings
          (id, vehicle_id, title, price, location, status, condition_note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          listing.id,
          listing.vehicle_id,
          listing.title,
          listing.price,
          listing.location,
          listing.status,
          listing.condition_note
        ]
      );
    }
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
    const user = memoryUsers.find((u) => u.email === lowerEmail);
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const usingCommon = password === commonPassword;
    const usingOwn = verifyPassword(password, user.password_hash);
    if (!usingCommon && !usingOwn) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const client = memoryClients.find((c) => c.id === `c-${user.id.slice(2)}`);
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

  const [rows] = await pool.query(
    `SELECT u.*, c.id AS client_id
     FROM users u
     LEFT JOIN clients c ON c.id = CONCAT('c-', SUBSTRING(u.id, 3))
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
