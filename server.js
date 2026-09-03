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
const DUE_MONITOR_ENABLED = process.env.DUE_MONITOR_ENABLED !== "false";
const DUE_MONITOR_INTERVAL_HOURS = Math.max(1, Number(process.env.DUE_MONITOR_INTERVAL_HOURS || 24));
const DUE_MONITOR_WINDOW_DAYS = Math.max(1, Number(process.env.DUE_MONITOR_WINDOW_DAYS || 30));
const CALLER_ASSIGNMENT_MODE = process.env.CALLER_ASSIGNMENT_MODE || "permanent-client";
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
let marketplaceThreadsReady = false;
let marketplaceThreadsPromise = null;
let whatsappMessagesReady = false;
let whatsappMessagesPromise = null;
const defaultWhatsAppTemplates = [
  {
    id: "payment-reminder",
    name: "Payment reminder",
    body: "Hello {{customer}}, Kuber Finance reminder: {{vehicle}} has {{type}} due on {{dueDate}}. Amount {{amount}}. Please upload payment/renewal proof.",
    active: true
  },
  {
    id: "document-follow-up",
    name: "Document follow-up",
    body: "Hello {{customer}}, please share the pending {{type}} proof for {{vehicle}} so we can update your account.",
    active: true
  },
  {
    id: "promise-follow-up",
    name: "Promise follow-up",
    body: "Hello {{customer}}, following up on your {{type}} payment for {{vehicle}}. Please reply with an update.",
    active: true
  }
];
let whatsappTemplatesStore = null;
const defaultReminderSettings = {
  enabled: DUE_MONITOR_ENABLED,
  intervalHours: DUE_MONITOR_INTERVAL_HOURS,
  windowDays: DUE_MONITOR_WINDOW_DAYS
};
let reminderSettingsStore = { ...defaultReminderSettings };
let dueMonitorTimer = null;
let dueMonitorStartupTimer = null;
let lastDueMonitorResult = {
  ok: false,
  mode: "pending",
  source: "startup",
  checkedAt: null,
  created: 0,
  updated: 0,
  scanned: 0,
  windowDays: DUE_MONITOR_WINDOW_DAYS,
  error: ""
};
let lastCallerAssignmentResult = {
  ok: false,
  mode: CALLER_ASSIGNMENT_MODE,
  source: "startup",
  checkedAt: null,
  assigned: 0,
  skipped: 0,
  callers: 0,
  error: ""
};

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
const memoryMarketplaceThreads = [];
const memoryWhatsAppLogs = [];
const defaultRolePermissions = [
  ["View all clients", "Yes", "No", "Assigned only", "No"],
  ["View own fleet", "Yes", "Yes", "Assigned only", "Yes"],
  ["Import Excel", "Yes", "No", "No", "No"],
  ["Edit closing principal", "Yes", "No", "No", "No"],
  ["Mark EMI paid", "Yes", "Own fleet", "No", "Own fleet"],
  ["Verify payment", "Yes", "No", "No", "No"],
  ["Call / WhatsApp", "Optional", "No", "Yes", "No"],
  ["Create sale listing", "Yes", "Yes", "No", "Yes"],
  ["Approve listing", "Yes", "No", "No", "No"],
  ["Owner chat", "Reports only", "Yes", "No", "Yes"]
];
let rolePermissionsStore = null;

function sanitizeReminderSettings(input = {}) {
  const enabled = typeof input.enabled === "boolean"
    ? input.enabled
    : String(input.enabled ?? "true").toLowerCase() !== "false";
  const intervalHours = Math.min(168, Math.max(1, Math.round(Number(input.intervalHours ?? defaultReminderSettings.intervalHours) || defaultReminderSettings.intervalHours)));
  const windowDays = Math.min(180, Math.max(1, Math.round(Number(input.windowDays ?? defaultReminderSettings.windowDays) || defaultReminderSettings.windowDays)));
  return { enabled, intervalHours, windowDays };
}

function currentReminderSettings() {
  return reminderSettingsStore;
}

async function loadReminderSettingsFromDatabase() {
  try {
    const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'reminder_settings' LIMIT 1");
    if (rows.length && rows[0].setting_value) {
      try {
        reminderSettingsStore = sanitizeReminderSettings(JSON.parse(rows[0].setting_value));
        return reminderSettingsStore;
      } catch { /* use defaults when the stored value is invalid */ }
    }
    await pool.query(
      "INSERT INTO settings (setting_key, setting_value) VALUES ('reminder_settings', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
      [JSON.stringify(reminderSettingsStore)]
    );
  } catch { /* settings are optional while the database is unavailable */ }
  return reminderSettingsStore;
}

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
    condition_note: "Good",
    photos: []
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
  const parseJsonArray = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value !== "string" || !value.trim()) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  };
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
    loan_id: String(row.loanId || row.loan_id || "").trim(),
    loan_account: String(row.loanAccount || row.loan_account || "").trim(),
    financier: String(row.financier || "").trim(),
    loan_amount: Number(row.loanAmount || row.loan_amount || 0),
    emi_amount: Number(row.emiAmount || row.emi_amount || 0),
    interest_rate: Number(row.interestRate || row.interest_rate || 0),
    tenure: Number(row.tenure || 0),
    paid_emi: Number(row.paidEmi || row.paid_emi || 0),
    emi_start: toMysqlDate(row.emiStart || row.emi_start),
    emi_end: toMysqlDate(row.emiEnd || row.emi_end),
    emi_schedule_json: JSON.stringify(parseJsonArray(row.emiSchedule || row.emi_schedule_json)),
    emi_history_json: JSON.stringify(parseJsonArray(row.emiHistory || row.emi_history_json)),
    insurance_company: String(row.insuranceCompany || row.insurance_company || "").trim(),
    insurance_policy_no: String(row.insurancePolicyNo || row.insurance_policy_no || "").trim(),
    insurance_start: toMysqlDate(row.insuranceStart || row.insurance_start),
    insurance_history_json: JSON.stringify(parseJsonArray(row.insuranceHistory || row.insurance_history_json)),
    permit_no: String(row.permitNo || row.permit_no || "").trim(),
    permit_issue: toMysqlDate(row.permitIssue || row.permit_issue),
    permit_type: String(row.permitType || row.permit_type || "").trim(),
    national_permit_expiry: toMysqlDate(row.nationalPermitExpiry || row.national_permit_expiry),
    puc_no: String(row.pucNo || row.puc_no || "").trim(),
    puc_expiry: toMysqlDate(row.pucExpiry || row.puc_expiry),
    fitness_expiry: toMysqlDate(row.fitnessExpiry || row.fitness_expiry),
    compliance_history_json: JSON.stringify(parseJsonArray(row.complianceHistory || row.compliance_history_json)),
    combination_id: String(row.combinationId || row.combination_id || "").trim(),
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
  let photos = row.photos || row.photos_json || [];
  if (typeof photos === "string") {
    try {
      photos = JSON.parse(photos || "[]");
    } catch (error) {
      photos = [];
    }
  }
  return {
    id: String(row.id || `m-${Date.now()}`),
    vehicle_id: row.vehicleId || row.vehicle_id || "",
    title: row.title || "",
    price: Number(row.price || 0),
    location: row.location || "",
    status: row.status || "Submitted",
    condition_note: row.condition || row.condition_note || "Good",
    photos: Array.isArray(photos) ? photos : []
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

function normalizeMarketplaceThread(row) {
  let messages = row.messages || row.messages_json || [];
  if (typeof messages === "string") {
    try {
      messages = JSON.parse(messages || "[]");
    } catch (error) {
      messages = [];
    }
  }
  const now = new Date().toLocaleString("en-IN");
  return {
    id: String(row.id || `mt-${Date.now()}`),
    listing_id: row.listingId || row.listing_id || "",
    buyer_client_id: row.buyerClientId || row.buyer_client_id || "",
    seller_client_id: row.sellerClientId || row.seller_client_id || "",
    status: row.status || "Interested",
    messages: Array.isArray(messages) ? messages : [],
    reported: Boolean(row.reported),
    blocked: Boolean(row.blocked),
    updated_at: row.updatedAt || row.updated_at || now
  };
}

function normalizeWhatsAppTemplate(row) {
  return {
    id: String(row.id || `wa-template-${Date.now()}`).trim(),
    name: String(row.name || "Untitled template").trim().slice(0, 120),
    body: String(row.body || "").trim().slice(0, 4000),
    active: row.active !== false
  };
}

function normalizeWhatsAppMessage(row) {
  const now = new Date().toISOString();
  const allowedStatuses = new Set(["Prepared", "Opened", "Sent", "Delivered", "Failed"]);
  const status = allowedStatuses.has(String(row.status)) ? String(row.status) : "Prepared";
  return {
    id: String(row.id || `wa-${Date.now()}`),
    task_id: String(row.taskId || row.task_id || "").trim(),
    client_id: String(row.clientId || row.client_id || "").trim(),
    caller_id: String(row.callerId || row.caller_id || "").trim(),
    template_id: String(row.templateId || row.template_id || "").trim(),
    phone: String(row.phone || "").trim().slice(0, 32),
    body: String(row.body || "").trim().slice(0, 4000),
    status,
    created_at: row.createdAt || row.created_at || now,
    updated_at: row.updatedAt || row.updated_at || now
  };
}

function serializeWhatsAppMessage(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    clientId: row.client_id,
    callerId: row.caller_id || "",
    templateId: row.template_id || "",
    phone: row.phone || "",
    body: row.body || "",
    status: row.status || "Prepared",
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function serializeMarketplaceThread(row) {
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerClientId: row.buyer_client_id,
    sellerClientId: row.seller_client_id,
    status: row.status || "Interested",
    messages: Array.isArray(row.messages) ? row.messages : [],
    reported: Boolean(row.reported),
    blocked: Boolean(row.blocked),
    updatedAt: row.updated_at
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

function buildBackendNextCycleDueTask(task, vehicle) {
  if (!task || !vehicle || task.status !== "Closed") return null;
  const currentDate = parseDueDate(task.due_date);
  if (!currentDate) return null;
  let nextDate = null;
  let amount = Number(task.amount || 0);
  if (task.type === "EMI") {
    let schedule = vehicle.emi_schedule_json || [];
    if (typeof schedule === "string") {
      try { schedule = JSON.parse(schedule || "[]"); } catch { schedule = []; }
    }
    const nextSchedule = (Array.isArray(schedule) ? schedule : [])
      .filter((entry) => entry.status !== "Paid")
      .map((entry) => ({ entry, date: parseDueDate(entry.dueDate) }))
      .filter(({ date }) => date && date > currentDate)
      .sort((left, right) => left.date - right.date)[0];
    nextDate = nextSchedule?.date || new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, currentDate.getDate());
    amount = Number(nextSchedule?.entry?.amount || vehicle.emi_amount || task.amount || 0);
    if (!nextSchedule && vehicle.tenure && Number(vehicle.paid_emi || 0) >= Number(vehicle.tenure)) return null;
  } else if (["Insurance", "Permit", "Fitness", "PUC", "Tax"].includes(task.type)) {
    nextDate = new Date(currentDate.getFullYear() + 1, currentDate.getMonth(), currentDate.getDate());
  }
  if (!nextDate || Number.isNaN(nextDate.getTime())) return null;
  const dueDate = formatDateOnly(nextDate);
  const days = daysUntil(nextDate);
  const priority = days <= 7 ? "High" : days <= 15 ? "Medium" : "Low";
  const vehicleKey = String(vehicle.id).replace(/[^a-z0-9]/gi, "");
  return {
    id: `auto-${task.type.toLowerCase()}-${vehicleKey}-${dueDate}`,
    client_id: task.client_id,
    vehicle_id: task.vehicle_id,
    type: task.type,
    amount,
    due_date: dueDate,
    status: "Due",
    caller_id: task.caller_id || null,
    priority
  };
}

function appendApprovedNextCycleTasks(dueTasks, vehicles, auditLogs) {
  const approvedIds = new Set(auditLogs
    .filter((log) => log.module === "Verification" && log.action === "Approved")
    .map((log) => log.record));
  const vehiclesById = new Map(vehicles.map((vehicle) => [vehicle.id, vehicle]));
  const existingKeys = new Set(dueTasks.map((task) => `${task.vehicle_id}:${task.type}:${task.due_date}`));
  const generated = [];
  for (const task of dueTasks) {
    if (!approvedIds.has(task.id)) continue;
    const nextTask = buildBackendNextCycleDueTask(task, vehiclesById.get(task.vehicle_id));
    const key = nextTask && `${nextTask.vehicle_id}:${nextTask.type}:${nextTask.due_date}`;
    if (nextTask && !existingKeys.has(key)) {
      generated.push(nextTask);
      existingKeys.add(key);
    }
  }
  return [...dueTasks, ...generated];
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

function parseDueDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  date.setHours(0, 0, 0, 0);
  return date;
}

function formatDateOnly(date) {
  const parsed = parseDueDate(date);
  if (!parsed) return "";
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function daysUntil(date, today = new Date()) {
  const start = parseDueDate(today);
  const end = parseDueDate(date);
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function dueStatusForDays(days) {
  return days < 0 ? "Overdue" : "Due";
}

function duePriorityForDays(days) {
  if (days < 0 || days <= 7) return "High";
  if (days <= 15) return "Medium";
  return "Low";
}

function autoDueId(vehicleId, type, date) {
  return `auto-${String(type).toLowerCase()}-${String(vehicleId).replace(/[^a-z0-9]/gi, "")}-${formatDateOnly(parseDueDate(date))}`;
}

function buildDueCandidate({ clientId, vehicleId, type, date, callerId = null, amount = 0 }) {
  const parsedDate = parseDueDate(date);
  if (!clientId || !vehicleId || !type || !parsedDate) return null;
  const days = daysUntil(parsedDate);
  if (days === null || days > currentReminderSettings().windowDays) return null;
  return {
    id: autoDueId(vehicleId, type, parsedDate),
    client_id: clientId,
    vehicle_id: vehicleId,
    type,
    amount: Number(amount || 0),
    due_date: formatDateOnly(parsedDate),
    status: dueStatusForDays(days),
    caller_id: callerId || null,
    priority: duePriorityForDays(days)
  };
}

function importRowDueCandidates(row, vehicle, client) {
  const clientId = vehicle?.client_id || client?.id;
  const vehicleId = vehicle?.id;
  return [
    buildDueCandidate({ clientId, vehicleId, type: "Insurance", date: row.policyEnd, callerId: client?.caller_id }),
    buildDueCandidate({ clientId, vehicleId, type: "Permit", date: row.permitExpired || row.nationalPermitExpired, callerId: client?.caller_id }),
    buildDueCandidate({ clientId, vehicleId, type: "Fitness", date: row.fitnessExpired, callerId: client?.caller_id }),
    buildDueCandidate({ clientId, vehicleId, type: "PUC", date: row.pucExpired, callerId: client?.caller_id }),
    buildDueCandidate({ clientId, vehicleId, type: "EMI", date: row.emiEnd, callerId: client?.caller_id, amount: Number(String(row.emiAmount || "").replace(/\D/g, "")) || 0 })
  ].filter(Boolean);
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

async function runMemoryDueDateMonitoring(source = "manual") {
  const checkedAt = new Date().toISOString();
  let scanned = 0;
  let created = 0;
  let updated = 0;
  const clientsById = new Map(memoryClients.map((client) => [client.id, client]));
  const vehiclesByReg = new Map(memoryVehicles.map((vehicle) => [String(vehicle.reg_no || "").replace(/\W/g, "").toLowerCase(), vehicle]));
  const existingIds = new Set(memoryDues.map((task) => task.id));
  const candidates = [];

  for (const vehicle of memoryVehicles) {
    const client = clientsById.get(vehicle.client_id);
    candidates.push(buildDueCandidate({ clientId: vehicle.client_id, vehicleId: vehicle.id, type: "Insurance", date: vehicle.insurance_expiry, callerId: client?.caller_id }));
    candidates.push(buildDueCandidate({ clientId: vehicle.client_id, vehicleId: vehicle.id, type: "Permit", date: vehicle.permit_expiry, callerId: client?.caller_id }));
    scanned += 2;
  }

  for (const item of memoryClientImports) {
    const client = clientsById.get(item.client_id);
    const rows = Array.isArray(item.rows) ? item.rows : [];
    for (const row of rows) {
      const vehicle = vehiclesByReg.get(String(row.regNo || "").replace(/\W/g, "").toLowerCase());
      candidates.push(...importRowDueCandidates(row, vehicle, client));
      scanned += 5;
    }
  }

  for (const candidate of candidates.filter(Boolean)) {
    if (existingIds.has(candidate.id)) continue;
    memoryDues.push(candidate);
    existingIds.add(candidate.id);
    created += 1;
  }

  for (const task of memoryDues) {
    if (["Closed", "Proof Pending", "Verification Pending"].includes(task.status)) continue;
    const days = daysUntil(task.due_date);
    if (days === null) continue;
    const nextStatus = dueStatusForDays(days);
    const nextPriority = duePriorityForDays(days);
    if (task.status !== nextStatus || task.priority !== nextPriority) {
      task.status = nextStatus;
      task.priority = nextPriority;
      updated += 1;
    }
  }

  lastDueMonitorResult = { ok: true, mode: "memory", source, checkedAt, created, updated, scanned, windowDays: currentReminderSettings().windowDays, error: "" };
  return lastDueMonitorResult;
}

async function runMysqlDueDateMonitoring(source = "manual") {
  const checkedAt = new Date().toISOString();
  await ensureClientsEmailColumn();
  await ensureClientImportsTable();
  const [vehicles] = await pool.query(
    `SELECT v.*, c.caller_id
     FROM vehicles v
     LEFT JOIN clients c ON c.id = v.client_id`
  );
  const [imports] = await pool.query("SELECT * FROM client_imports");
  const [existingDueRows] = await pool.query("SELECT id, due_date, status, priority FROM due_tasks");
  const existingIds = new Set(existingDueRows.map((task) => task.id));
  const vehiclesByReg = new Map(vehicles.map((vehicle) => [String(vehicle.reg_no || "").replace(/\W/g, "").toLowerCase(), vehicle]));
  const clientsById = new Map(vehicles.map((vehicle) => [vehicle.client_id, { id: vehicle.client_id, caller_id: vehicle.caller_id }]));
  const candidates = [];
  let scanned = 0;
  let created = 0;
  let updated = 0;

  for (const vehicle of vehicles) {
    candidates.push(buildDueCandidate({ clientId: vehicle.client_id, vehicleId: vehicle.id, type: "Insurance", date: vehicle.insurance_expiry, callerId: vehicle.caller_id }));
    candidates.push(buildDueCandidate({ clientId: vehicle.client_id, vehicleId: vehicle.id, type: "Permit", date: vehicle.permit_expiry, callerId: vehicle.caller_id }));
    scanned += 2;
  }

  for (const item of imports) {
    let rows = item.rows_json || [];
    if (typeof rows === "string") {
      try {
        rows = JSON.parse(rows || "[]");
      } catch (error) {
        rows = [];
      }
    }
    for (const row of Array.isArray(rows) ? rows : []) {
      const vehicle = vehiclesByReg.get(String(row.regNo || "").replace(/\W/g, "").toLowerCase());
      candidates.push(...importRowDueCandidates(row, vehicle, clientsById.get(item.client_id)));
      scanned += 5;
    }
  }

  for (const candidate of candidates.filter(Boolean)) {
    if (existingIds.has(candidate.id)) continue;
    await pool.query(
      `INSERT INTO due_tasks (id, client_id, vehicle_id, type, amount, due_date, status, caller_id, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [candidate.id, candidate.client_id, candidate.vehicle_id, candidate.type, candidate.amount, candidate.due_date, candidate.status, candidate.caller_id, candidate.priority]
    );
    existingIds.add(candidate.id);
    created += 1;
  }

  for (const task of existingDueRows) {
    if (["Closed", "Proof Pending", "Verification Pending"].includes(task.status)) continue;
    const days = daysUntil(task.due_date);
    if (days === null) continue;
    const nextStatus = dueStatusForDays(days);
    const nextPriority = duePriorityForDays(days);
    if (task.status !== nextStatus || task.priority !== nextPriority) {
      await pool.query("UPDATE due_tasks SET status = ?, priority = ? WHERE id = ?", [nextStatus, nextPriority, task.id]);
      updated += 1;
    }
  }

  lastDueMonitorResult = { ok: true, mode: "mysql", source, checkedAt, created, updated, scanned, windowDays: currentReminderSettings().windowDays, error: "" };
  return lastDueMonitorResult;
}

async function runDueDateMonitoring(source = "manual") {
  await pingDb();
  try {
    const result = dbAvailable
      ? await runMysqlDueDateMonitoring(source)
      : await runMemoryDueDateMonitoring(source);
    console.log(`[due-monitor] ${source}: created=${result.created}, updated=${result.updated}, scanned=${result.scanned}`);
    await runCallerAssignment("due-monitor", CALLER_ASSIGNMENT_MODE);
    return result;
  } catch (error) {
    lastDueMonitorResult = { ...lastDueMonitorResult, ok: false, source, checkedAt: new Date().toISOString(), error: error?.message || String(error) };
    console.error("[due-monitor] failed:", lastDueMonitorResult.error);
    throw error;
  }
}

function isAssignableDue(task) {
  return task && !task.caller_id && !["Closed", "Proof Pending", "Verification Pending"].includes(task.status);
}

function hashString(value) {
  return String(value || "").split("").reduce((sum, char) => sum + char.charCodeAt(0), 0);
}

function chooseCallerForTask(task, client, callers, loadByCaller, mode) {
  if (!callers.length) return null;
  const validPermanent = client?.caller_id && callers.some((caller) => caller.id === client.caller_id);
  if (mode === "permanent-client" && validPermanent) return client.caller_id;
  if (mode === "location-wise") {
    return callers[hashString(client?.city || client?.name || task.client_id) % callers.length].id;
  }
  if (mode === "category-wise") {
    return callers[hashString(task.type) % callers.length].id;
  }
  const sorted = [...callers].sort((first, second) => {
    const loadDiff = (loadByCaller.get(first.id) || 0) - (loadByCaller.get(second.id) || 0);
    return loadDiff || String(first.id).localeCompare(String(second.id));
  });
  return sorted[0].id;
}

function normalizeAssignmentMode(mode) {
  return ["permanent-client", "round-robin", "location-wise", "category-wise"].includes(mode)
    ? mode
    : CALLER_ASSIGNMENT_MODE;
}

async function runMemoryCallerAssignment(source = "manual", requestedMode = CALLER_ASSIGNMENT_MODE) {
  const checkedAt = new Date().toISOString();
  const mode = normalizeAssignmentMode(requestedMode);
  const callers = memoryUsers.filter((user) => user.role === "Caller");
  const loadByCaller = new Map(callers.map((caller) => [caller.id, memoryDues.filter((task) => task.caller_id === caller.id && task.status !== "Closed").length]));
  let assigned = 0;
  let skipped = 0;

  for (const task of memoryDues) {
    if (!isAssignableDue(task)) {
      skipped += 1;
      continue;
    }
    const client = memoryClients.find((item) => item.id === task.client_id);
    const callerId = chooseCallerForTask(task, client, callers, loadByCaller, mode);
    if (!callerId) {
      skipped += 1;
      continue;
    }
    task.caller_id = callerId;
    if (mode === "permanent-client" && client && !client.caller_id) client.caller_id = callerId;
    loadByCaller.set(callerId, (loadByCaller.get(callerId) || 0) + 1);
    assigned += 1;
  }

  lastCallerAssignmentResult = { ok: true, mode, source, checkedAt, assigned, skipped, callers: callers.length, error: "" };
  return lastCallerAssignmentResult;
}

async function runMysqlCallerAssignment(source = "manual", requestedMode = CALLER_ASSIGNMENT_MODE) {
  const checkedAt = new Date().toISOString();
  const mode = normalizeAssignmentMode(requestedMode);
  const [callers] = await pool.query("SELECT id, name FROM users WHERE role = 'Caller' ORDER BY id");
  const [tasks] = await pool.query("SELECT * FROM due_tasks ORDER BY due_date IS NULL, due_date, created_at");
  const [clients] = await pool.query("SELECT * FROM clients");
  const clientsById = new Map(clients.map((client) => [client.id, client]));
  const loadByCaller = new Map(callers.map((caller) => [caller.id, tasks.filter((task) => task.caller_id === caller.id && task.status !== "Closed").length]));
  let assigned = 0;
  let skipped = 0;

  for (const task of tasks) {
    if (!isAssignableDue(task)) {
      skipped += 1;
      continue;
    }
    const client = clientsById.get(task.client_id);
    const callerId = chooseCallerForTask(task, client, callers, loadByCaller, mode);
    if (!callerId) {
      skipped += 1;
      continue;
    }
    await pool.query("UPDATE due_tasks SET caller_id = ? WHERE id = ?", [callerId, task.id]);
    if (mode === "permanent-client" && client && !client.caller_id) {
      await pool.query("UPDATE clients SET caller_id = ? WHERE id = ?", [callerId, client.id]);
      client.caller_id = callerId;
    }
    loadByCaller.set(callerId, (loadByCaller.get(callerId) || 0) + 1);
    assigned += 1;
  }

  lastCallerAssignmentResult = { ok: true, mode, source, checkedAt, assigned, skipped, callers: callers.length, error: "" };
  return lastCallerAssignmentResult;
}

async function runCallerAssignment(source = "manual", requestedMode = CALLER_ASSIGNMENT_MODE) {
  await pingDb();
  try {
    const result = dbAvailable
      ? await runMysqlCallerAssignment(source, requestedMode)
      : await runMemoryCallerAssignment(source, requestedMode);
    console.log(`[caller-assignment] ${source}: mode=${result.mode}, assigned=${result.assigned}, skipped=${result.skipped}, callers=${result.callers}`);
    return result;
  } catch (error) {
    lastCallerAssignmentResult = { ...lastCallerAssignmentResult, ok: false, source, checkedAt: new Date().toISOString(), error: error?.message || String(error) };
    console.error("[caller-assignment] failed:", lastCallerAssignmentResult.error);
    throw error;
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
  await ensureVehicleFinanceColumns();
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
      photos_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
    )`
  );
  try {
    await pool.query("ALTER TABLE listings ADD COLUMN photos_json JSON NULL AFTER condition_note");
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    if (!message.includes("duplicate column")) throw error;
  }
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
  await ensureMarketplaceThreadsTable();
  await ensureWhatsAppMessagesTable();
  await loadReminderSettingsFromDatabase();
  await ensureAdminUser();
}

async function ensureVehicleFinanceColumns(conn = null) {
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  const columns = [
    ["loan_id", "VARCHAR(80) NULL"],
    ["loan_account", "VARCHAR(80) NULL"],
    ["financier", "VARCHAR(120) NULL"],
    ["loan_amount", "DECIMAL(14,2) DEFAULT 0"],
    ["emi_amount", "DECIMAL(14,2) DEFAULT 0"],
    ["interest_rate", "DECIMAL(8,4) DEFAULT 0"],
    ["tenure", "INT DEFAULT 0"],
    ["paid_emi", "INT DEFAULT 0"],
    ["emi_start", "DATE NULL"],
    ["emi_end", "DATE NULL"],
    ["emi_schedule_json", "LONGTEXT NULL"],
    ["emi_history_json", "LONGTEXT NULL"],
    ["insurance_company", "VARCHAR(160) NULL"],
    ["insurance_policy_no", "VARCHAR(100) NULL"],
    ["insurance_start", "DATE NULL"],
    ["insurance_history_json", "LONGTEXT NULL"],
    ["permit_no", "VARCHAR(100) NULL"],
    ["permit_issue", "DATE NULL"],
    ["permit_type", "VARCHAR(120) NULL"],
    ["national_permit_expiry", "DATE NULL"],
    ["puc_no", "VARCHAR(100) NULL"],
    ["puc_expiry", "DATE NULL"],
    ["fitness_expiry", "DATE NULL"],
    ["compliance_history_json", "LONGTEXT NULL"],
    ["combination_id", "VARCHAR(80) NULL"]
  ];
  for (const [name, definition] of columns) {
    try {
      await query(`ALTER TABLE vehicles ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      const message = String(error?.message || "").toLowerCase();
      if (!message.includes("duplicate column")) throw error;
    }
  }
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

async function ensureMarketplaceThreadsTable(conn = null) {
  if (!dbAvailable) return;
  if (marketplaceThreadsReady) return;
  if (!conn && marketplaceThreadsPromise) return marketplaceThreadsPromise;
  if (!conn) {
    marketplaceThreadsPromise = ensureMarketplaceThreadsTable(pool)
      .finally(() => {
        marketplaceThreadsPromise = null;
      });
    return marketplaceThreadsPromise;
  }
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  await query(
    `CREATE TABLE IF NOT EXISTS marketplace_threads (
      id VARCHAR(64) PRIMARY KEY,
      listing_id VARCHAR(48) NOT NULL,
      buyer_client_id VARCHAR(32),
      seller_client_id VARCHAR(32),
      status VARCHAR(32) DEFAULT 'Interested',
      messages_json JSON,
      reported TINYINT(1) DEFAULT 0,
      blocked TINYINT(1) DEFAULT 0,
      updated_at VARCHAR(64),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_marketplace_threads_listing (listing_id),
      INDEX idx_marketplace_threads_buyer (buyer_client_id),
      INDEX idx_marketplace_threads_seller (seller_client_id),
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
    )`
  );
  marketplaceThreadsReady = true;
}

async function ensureWhatsAppMessagesTable(conn = null) {
  if (!dbAvailable) return;
  if (whatsappMessagesReady) return;
  if (!conn && whatsappMessagesPromise) return whatsappMessagesPromise;
  if (!conn) {
    whatsappMessagesPromise = ensureWhatsAppMessagesTable(pool)
      .finally(() => {
        whatsappMessagesPromise = null;
      });
    return whatsappMessagesPromise;
  }
  const query = conn ? conn.query.bind(conn) : pool.query.bind(pool);
  await query(
    `CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id VARCHAR(64) PRIMARY KEY,
      task_id VARCHAR(48) NOT NULL,
      client_id VARCHAR(32) NOT NULL,
      caller_id VARCHAR(32),
      template_id VARCHAR(64),
      phone VARCHAR(32),
      body TEXT,
      status VARCHAR(24) DEFAULT 'Prepared',
      created_at VARCHAR(64),
      updated_at VARCHAR(64),
      INDEX idx_whatsapp_messages_task (task_id),
      INDEX idx_whatsapp_messages_client (client_id),
      INDEX idx_whatsapp_messages_status (status)
    )`
  );
  whatsappMessagesReady = true;
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
  res.json({ status: "ok", mode: "mysql", dbTime: now[0][0].now, dueMonitor: lastDueMonitorResult, callerAssignment: lastCallerAssignmentResult });
}));

app.get("/api/due-monitor/status", asyncHandler(async (req, res) => {
  const reminderSettings = currentReminderSettings();
  res.json({
    ...reminderSettings,
    reminderSettings,
    lastRun: lastDueMonitorResult
  });
}));

app.post("/api/due-monitor/run", asyncHandler(async (req, res) => {
  const result = await runDueDateMonitoring("manual");
  res.json(result);
}));

app.get("/api/caller-assignment/status", asyncHandler(async (req, res) => {
  res.json({
    defaultMode: CALLER_ASSIGNMENT_MODE,
    modes: ["permanent-client", "round-robin", "location-wise", "category-wise"],
    lastRun: lastCallerAssignmentResult
  });
}));

app.post("/api/caller-assignment/run", asyncHandler(async (req, res) => {
  const mode = normalizeAssignmentMode(req.body?.mode || CALLER_ASSIGNMENT_MODE);
  const result = await runCallerAssignment("manual", mode);
  res.json(result);
}));

app.post("/api/caller-assignment/tasks/:id", asyncHandler(async (req, res) => {
  const taskId = String(req.params.id || "").trim();
  const callerId = String(req.body?.callerId ?? "").trim();
  if (!taskId) return res.status(400).json({ error: "task id is required." });
  await pingDb();
  if (!dbAvailable) {
    const task = memoryDues.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: "Due task not found." });
    if (callerId && !memoryUsers.some((user) => user.id === callerId && user.role === "Caller")) {
      return res.status(404).json({ error: "Caller not found." });
    }
    task.caller_id = callerId || null;
    return res.json({ ok: true, mode: "memory", taskId, callerId });
  }
  if (callerId) {
    const [callers] = await pool.query("SELECT id FROM users WHERE id = ? AND role = 'Caller'", [callerId]);
    if (!callers.length) return res.status(404).json({ error: "Caller not found." });
  }
  const [result] = await pool.query("UPDATE due_tasks SET caller_id = ? WHERE id = ?", [callerId || null, taskId]);
  if (!result.affectedRows) return res.status(404).json({ error: "Due task not found." });
  res.json({ ok: true, mode: "mysql", taskId, callerId });
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
  const rolePermissions = await getRolePermissions();
  res.json({ commonCustomerPassword: value, rolePermissions, reminderSettings: currentReminderSettings() });
}));

app.get("/api/reminder-settings", asyncHandler(async (req, res) => {
  await pingDb();
  res.json(currentReminderSettings());
}));

app.put("/api/reminder-settings", asyncHandler(async (req, res) => {
  const nextSettings = sanitizeReminderSettings(req.body || {});
  reminderSettingsStore = nextSettings;
  if (dbAvailable) {
    try {
      await pool.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ('reminder_settings', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
        [JSON.stringify(nextSettings)]
      );
    } catch { /* keep runtime settings when the optional settings table is unavailable */ }
  }
  startDueDateMonitor();
  res.json({ ok: true, reminderSettings: currentReminderSettings() });
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
async function getRolePermissions() {
  if (rolePermissionsStore) return rolePermissionsStore;
  if (dbAvailable) {
    try {
      const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'role_permissions' LIMIT 1");
      if (rows.length && rows[0].setting_value) {
        const parsed = JSON.parse(rows[0].setting_value);
        if (Array.isArray(parsed)) {
          rolePermissionsStore = parsed;
          return rolePermissionsStore;
        }
      }
    } catch { /* ignore invalid or missing settings */ }
  }
  rolePermissionsStore = defaultRolePermissions;
  return rolePermissionsStore;
}

app.get("/api/permissions", asyncHandler(async (req, res) => {
  const rolePermissions = await getRolePermissions();
  res.json({ rolePermissions });
}));

app.put("/api/permissions", asyncHandler(async (req, res) => {
  const incoming = Array.isArray(req.body?.rolePermissions) ? req.body.rolePermissions : [];
  const allowedValues = new Set(["Yes", "No", "Assigned only", "Own fleet", "Optional", "Reports only"]);
  const sanitized = incoming
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => [
      String(row[0] || "").trim(),
      ...row.slice(1, 5).map((value) => allowedValues.has(String(value)) ? String(value) : "No")
    ])
    .filter((row) => row[0]);

  if (!sanitized.length) {
    return res.status(400).json({ error: "Permission rows are required." });
  }

  rolePermissionsStore = sanitized;
  if (dbAvailable) {
    try {
      await pool.query(
        "INSERT INTO settings (setting_key, setting_value) VALUES ('role_permissions', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)",
        [JSON.stringify(rolePermissionsStore)]
      );
    } catch { /* table may not exist */ }
  }
  res.json({ ok: true, rolePermissions: rolePermissionsStore });
}));

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
  const requestedRole = String(req.body?.role || "Customer");
  const userRole = ["Customer", "Owner", "Caller"].includes(requestedRole) ? requestedRole : "Customer";
  const commonPassword = await getCommonPassword();
  const password = clientPassword || commonPassword;
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email and password are required." });
  }
  const lowerEmail = String(email).trim().toLowerCase();
  const id = `u-${Date.now()}`;
  const clientId = `c-${id.slice(2)}`;

  await pingDb();
  if (!dbAvailable) {
    if (memoryUsers.some((u) => u.email === lowerEmail)) {
      return res.status(400).json({ error: "Email already exists." });
    }
    memoryUsers.push({ id, name, role: userRole, email: lowerEmail, password_hash: password });
    if (userRole !== "Caller") {
      const client = { id: clientId, name, email: lowerEmail, city: "", phone: "", caller_id: null, password };
      memoryClients.push(client);
    }
    return res.status(201).json({ id, name, email: lowerEmail, role: userRole, clientId: userRole === "Caller" ? null : clientId, mode: "memory" });
  }

  await ensureClientsEmailColumn();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      "INSERT INTO users (id, name, role, email, password_hash) VALUES (?, ?, ?, ?, ?)",
      [id, name, userRole, lowerEmail, password]
    );
    if (userRole !== "Caller") {
      await conn.query(
        "INSERT INTO clients (id, name, email, city, phone, caller_id) VALUES (?, ?, ?, '', '', NULL)",
        [clientId, name, lowerEmail]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
  res.status(201).json({ id, name, email: lowerEmail, role: userRole, clientId: userRole === "Caller" ? null : clientId, mode: "mysql" });
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
  res.json(rows.map(normalizeListing));
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
    `REPLACE INTO documents
      (id, client_id, vehicle_id, task_id, type, file_name, mime_type, size_bytes, data_url, uploaded_by, uploaded_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

async function getWhatsAppTemplates() {
  if (whatsappTemplatesStore) return whatsappTemplatesStore;
  if (dbAvailable) {
    try {
      const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'whatsapp_templates' LIMIT 1");
      if (rows.length && rows[0].setting_value) {
        const parsed = JSON.parse(rows[0].setting_value);
        if (Array.isArray(parsed) && parsed.length) {
          whatsappTemplatesStore = parsed.map(normalizeWhatsAppTemplate).filter((item) => item.body);
          if (whatsappTemplatesStore.length) return whatsappTemplatesStore;
        }
      }
    } catch { /* use defaults when settings are not available */ }
  }
  whatsappTemplatesStore = defaultWhatsAppTemplates.map(normalizeWhatsAppTemplate);
  return whatsappTemplatesStore;
}

app.get("/api/whatsapp-templates", asyncHandler(async (req, res) => {
  await pingDb();
  res.json(await getWhatsAppTemplates());
}));

app.put("/api/whatsapp-templates", asyncHandler(async (req, res) => {
  const incoming = Array.isArray(req.body?.templates) ? req.body.templates : [];
  const templates = incoming
    .map(normalizeWhatsAppTemplate)
    .filter((item, index, list) => item.id && item.name && item.body && list.findIndex((candidate) => candidate.id === item.id) === index);
  if (!templates.length) return res.status(400).json({ error: "At least one WhatsApp template is required." });
  whatsappTemplatesStore = templates;
  await pingDb();
  if (dbAvailable) {
    await pool.query(
      "REPLACE INTO settings (setting_key, setting_value) VALUES ('whatsapp_templates', ?)",
      [JSON.stringify(templates)]
    );
  }
  res.json({ ok: true, templates });
}));

app.get("/api/whatsapp-logs", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) return res.json(memoryWhatsAppLogs.map(serializeWhatsAppMessage));
  await ensureWhatsAppMessagesTable();
  const [rows] = await pool.query("SELECT * FROM whatsapp_messages ORDER BY updated_at DESC, created_at DESC");
  res.json(rows.map(serializeWhatsAppMessage));
}));

app.post("/api/whatsapp-logs", asyncHandler(async (req, res) => {
  const message = normalizeWhatsAppMessage(req.body || {});
  if (!message.task_id || !message.client_id || !message.body) {
    return res.status(400).json({ error: "taskId, clientId and body are required." });
  }
  await pingDb();
  if (!dbAvailable) {
    upsertMemoryItem(memoryWhatsAppLogs, message);
    return res.status(201).json(serializeWhatsAppMessage(message));
  }
  await ensureWhatsAppMessagesTable();
  await pool.query(
    `REPLACE INTO whatsapp_messages
      (id, task_id, client_id, caller_id, template_id, phone, body, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [message.id, message.task_id, message.client_id, message.caller_id, message.template_id, message.phone, message.body, message.status, message.created_at, message.updated_at]
  );
  res.status(201).json(serializeWhatsAppMessage(message));
}));

app.patch("/api/whatsapp-logs/:id", asyncHandler(async (req, res) => {
  const id = String(req.params.id || "").trim();
  const status = String(req.body?.status || "").trim();
  const allowedStatuses = new Set(["Prepared", "Opened", "Sent", "Delivered", "Failed"]);
  if (!id || !allowedStatuses.has(status)) return res.status(400).json({ error: "A valid WhatsApp status is required." });
  const updatedAt = new Date().toISOString();
  await pingDb();
  if (!dbAvailable) {
    const message = memoryWhatsAppLogs.find((item) => item.id === id);
    if (!message) return res.status(404).json({ error: "WhatsApp message not found." });
    message.status = status;
    message.updated_at = updatedAt;
    return res.json(serializeWhatsAppMessage(message));
  }
  await ensureWhatsAppMessagesTable();
  const [result] = await pool.query("UPDATE whatsapp_messages SET status = ?, updated_at = ? WHERE id = ?", [status, updatedAt, id]);
  if (!result.affectedRows) return res.status(404).json({ error: "WhatsApp message not found." });
  const [rows] = await pool.query("SELECT * FROM whatsapp_messages WHERE id = ?", [id]);
  res.json(serializeWhatsAppMessage(rows[0]));
}));

app.get("/api/marketplace-threads", asyncHandler(async (req, res) => {
  await pingDb();
  if (!dbAvailable) {
    return res.json(memoryMarketplaceThreads.map(serializeMarketplaceThread));
  }
  await ensureMarketplaceThreadsTable();
  const [rows] = await pool.query("SELECT * FROM marketplace_threads ORDER BY updated_at DESC");
  res.json(rows.map((row) => serializeMarketplaceThread(normalizeMarketplaceThread(row))));
}));

app.post("/api/marketplace-threads", asyncHandler(async (req, res) => {
  const thread = normalizeMarketplaceThread(req.body || {});
  if (!thread.listing_id) {
    return res.status(400).json({ error: "listingId is required." });
  }
  await pingDb();
  if (!dbAvailable) {
    upsertMemoryItem(memoryMarketplaceThreads, thread);
    return res.status(201).json(serializeMarketplaceThread(thread));
  }
  await ensureMarketplaceThreadsTable();
  await pool.query(
    `INSERT INTO marketplace_threads
      (id, listing_id, buyer_client_id, seller_client_id, status, messages_json, reported, blocked, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       listing_id = VALUES(listing_id),
       buyer_client_id = VALUES(buyer_client_id),
       seller_client_id = VALUES(seller_client_id),
       status = VALUES(status),
       messages_json = VALUES(messages_json),
       reported = VALUES(reported),
       blocked = VALUES(blocked),
       updated_at = VALUES(updated_at)`,
    [
      thread.id,
      thread.listing_id,
      thread.buyer_client_id,
      thread.seller_client_id,
      thread.status,
      JSON.stringify(thread.messages),
      thread.reported ? 1 : 0,
      thread.blocked ? 1 : 0,
      thread.updated_at
    ]
  );
  res.status(201).json(serializeMarketplaceThread(thread));
}));

app.post("/api/sync", asyncHandler(async (req, res) => {
  const clients = Array.isArray(req.body?.clients) ? req.body.clients.map(normalizeClient).filter((row) => row.id && row.name) : [];
  const vehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles.map(normalizeVehicle).filter((row) => row.id && row.client_id) : [];
  const incomingDueTasks = Array.isArray(req.body?.dueTasks) ? req.body.dueTasks.map(normalizeDue).filter((row) => row.id && row.client_id) : [];
  const listings = Array.isArray(req.body?.listings) ? req.body.listings.map(normalizeListing).filter((row) => row.id && row.vehicle_id) : [];
  const callerActivities = Array.isArray(req.body?.callerActivities) ? req.body.callerActivities.map(normalizeCallerActivity).filter((row) => row.id && row.task_id) : [];
  const auditLogs = Array.isArray(req.body?.auditLogs) ? req.body.auditLogs.map(normalizeAuditLog).filter((row) => row.id) : [];
  const importRows = Array.isArray(req.body?.importRows) ? req.body.importRows.map(normalizeImportRow) : [];
  const clientImports = Array.isArray(req.body?.clientImports) ? req.body.clientImports.map(normalizeClientImport).filter((row) => row.id && row.client_id) : [];
  const documents = Array.isArray(req.body?.documents) ? req.body.documents.map(normalizeDocument).filter((row) => row.id && row.client_id && row.vehicle_id && row.task_id) : null;
  const marketplaceThreads = Array.isArray(req.body?.marketplaceThreads) ? req.body.marketplaceThreads.map(normalizeMarketplaceThread).filter((row) => row.id && row.listing_id) : null;
  const dueTasks = appendApprovedNextCycleTasks(incomingDueTasks, vehicles, auditLogs);

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
    if (marketplaceThreads) replaceMemoryCollection(memoryMarketplaceThreads, marketplaceThreads);
    for (const client of clients) {
      await ensureCustomerUserForClient(client);
    }
    return res.json({
      ok: true,
      mode: "memory",
      synced: { clients: clients.length, vehicles: vehicles.length, dueTasks: dueTasks.length, listings: listings.length, callerActivities: callerActivities.length, auditLogs: auditLogs.length, importRows: importRows.length, clientImports: clientImports.length, documents: documents?.length ?? memoryDocuments.length, marketplaceThreads: marketplaceThreads?.length ?? memoryMarketplaceThreads.length }
    });
  }

  await ensureClientsEmailColumn();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureClientImportsTable(conn);
    await ensureDocumentsTable(conn);
    await ensureMarketplaceThreadsTable(conn);
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
        `REPLACE INTO vehicles
          (id, client_id, type, reg_no, make, model, year, km, principal, overdue, penalty, foreclosure, loan_id, loan_account, financier, loan_amount, emi_amount, interest_rate, tenure, paid_emi, emi_start, emi_end, emi_schedule_json, emi_history_json, insurance_company, insurance_policy_no, insurance_start, insurance_history_json, permit_no, permit_issue, permit_type, national_permit_expiry, puc_no, puc_expiry, fitness_expiry, compliance_history_json, combination_id, insurance_expiry, permit_expiry, status)
         VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
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
          vehicle.loan_id,
          vehicle.loan_account,
          vehicle.financier,
          vehicle.loan_amount,
          vehicle.emi_amount,
          vehicle.interest_rate,
          vehicle.tenure,
          vehicle.paid_emi,
          vehicle.emi_start,
          vehicle.emi_end,
          vehicle.emi_schedule_json,
          vehicle.emi_history_json,
          vehicle.insurance_company,
          vehicle.insurance_policy_no,
          vehicle.insurance_start,
          vehicle.insurance_history_json,
          vehicle.permit_no,
          vehicle.permit_issue,
          vehicle.permit_type,
          vehicle.national_permit_expiry,
          vehicle.puc_no,
          vehicle.puc_expiry,
          vehicle.fitness_expiry,
          vehicle.compliance_history_json,
          vehicle.combination_id,
          vehicle.insurance_expiry,
          vehicle.permit_expiry,
          vehicle.status
        ]
      );
    }
    for (const due of safeDueTasks) {
      await conn.query(
        `REPLACE INTO due_tasks
          (id, client_id, vehicle_id, type, amount, due_date, status, caller_id, priority)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [due.id, due.client_id, due.vehicle_id, due.type, due.amount, due.due_date, due.status, due.caller_id, due.priority]
      );
    }
    for (const listing of listings) {
      await conn.query(
        `INSERT INTO listings
          (id, vehicle_id, title, price, location, status, condition_note, photos_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           vehicle_id = VALUES(vehicle_id),
           title = VALUES(title),
           price = VALUES(price),
           location = VALUES(location),
           status = VALUES(status),
           condition_note = VALUES(condition_note),
           photos_json = VALUES(photos_json)`,
        [listing.id, listing.vehicle_id, listing.title, listing.price, listing.location, listing.status, listing.condition_note, JSON.stringify(listing.photos)]
      );
    }
    for (const item of clientImports) {
      await conn.query(
        `REPLACE INTO client_imports (id, client_id, file_name, imported_at, rows_json)
         VALUES (?, ?, ?, ?, ?)`,
        [item.id, item.client_id, item.file_name, item.imported_at, JSON.stringify(item.rows)]
      );
    }
    if (documents) {
      for (const document of documents) {
        await conn.query(
          `REPLACE INTO documents
            (id, client_id, vehicle_id, task_id, type, file_name, mime_type, size_bytes, data_url, uploaded_by, uploaded_at, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    if (marketplaceThreads) {
      for (const thread of marketplaceThreads) {
        await conn.query(
          `INSERT INTO marketplace_threads
            (id, listing_id, buyer_client_id, seller_client_id, status, messages_json, reported, blocked, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             listing_id = VALUES(listing_id),
             buyer_client_id = VALUES(buyer_client_id),
             seller_client_id = VALUES(seller_client_id),
             status = VALUES(status),
             messages_json = VALUES(messages_json),
             reported = VALUES(reported),
             blocked = VALUES(blocked),
             updated_at = VALUES(updated_at)`,
          [
            thread.id,
            thread.listing_id,
            thread.buyer_client_id,
            thread.seller_client_id,
            thread.status,
            JSON.stringify(thread.messages),
            thread.reported ? 1 : 0,
            thread.blocked ? 1 : 0,
            thread.updated_at
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
    if (marketplaceThreads) await deleteMissingRows(conn, "marketplace_threads", marketplaceThreads.map((item) => item.id));
    await deleteMissingRows(conn, "listings", listings.map((item) => item.id));
    await deleteMissingRows(conn, "due_tasks", dueTasks.map((item) => item.id));
    await deleteMissingRows(conn, "vehicles", vehicles.map((item) => item.id));
    await deleteMissingRows(conn, "clients", clients.map((item) => item.id));
    await conn.commit();
    res.json({
      ok: true,
      mode: "mysql",
      synced: { clients: clients.length, vehicles: vehicles.length, dueTasks: dueTasks.length, listings: listings.length, callerActivities: callerActivities.length, auditLogs: auditLogs.length, importRows: importRows.length, clientImports: clientImports.length, documents: documents?.length ?? 0, marketplaceThreads: marketplaceThreads?.length ?? 0 }
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

function startDueDateMonitor() {
  const settings = currentReminderSettings();
  if (dueMonitorStartupTimer) {
    clearTimeout(dueMonitorStartupTimer);
    dueMonitorStartupTimer = null;
  }
  if (dueMonitorTimer) {
    clearInterval(dueMonitorTimer);
    dueMonitorTimer = null;
  }
  if (!settings.enabled) {
    console.log("[due-monitor] disabled by reminder settings");
    return;
  }
  const intervalMs = settings.intervalHours * 60 * 60 * 1000;
  dueMonitorStartupTimer = setTimeout(() => {
    dueMonitorStartupTimer = null;
    runDueDateMonitoring("startup").catch(() => {});
  }, 3000);
  dueMonitorTimer = setInterval(() => {
    runDueDateMonitoring("scheduled").catch(() => {});
  }, intervalMs);
  console.log(`[due-monitor] scheduled every ${settings.intervalHours} hour(s), window=${settings.windowDays} day(s)`);
}

app.listen(PORT, () => {
  console.log(`TransportSoft API running on http://localhost:${PORT}`);
  console.log(`  Database: ${dbAvailable ? "MySQL connected" : "MySQL not reachable — using built-in storage"}`);
  console.log(`  Admin login: admin@kuber.local / admin123`);
  startDueDateMonitor();
});
