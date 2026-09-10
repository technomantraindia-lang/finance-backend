const crypto = require("node:crypto");

const CHAT_RETENTION_DAYS = 7;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const isClient = (auth) => ["Customer", "Owner"].includes(auth.role) && auth.clientId;
const participant = (auth, thread) => isClient(auth) && [thread.buyer_client_id, thread.seller_client_id].includes(auth.clientId);

function decode(row) {
  const messages = typeof row.messages_json === "string" ? JSON.parse(row.messages_json || "[]") : row.messages_json;
  return { ...row, messages: Array.isArray(messages) ? messages : [] };
}

function serialize(row) {
  return {
    id: row.id, listingId: row.listing_id, title: row.title || row.listing_id,
    registration: row.registration || "", requesterName: row.requester_name || "Client",
    ownerName: row.owner_name || "Vehicle owner",
    buyerClientId: row.buyer_client_id, sellerClientId: row.seller_client_id,
    approval: row.approval_status || "Pending", status: row.status,
    blocked: Boolean(row.blocked), reported: Boolean(row.reported),
    messages: row.messages, updatedAt: row.updated_at
  };
}

function applyAction(auth, row, action, body) {
  if (action === "decision") {
    if (auth.role !== "Admin") fail(403, "Admin approval required.");
    if (!["Approved", "Rejected"].includes(body.decision)) fail(400, "Invalid decision.");
    if (row.approval_status !== "Pending") fail(409, "This request has already been reviewed.");
    row.approval_status = body.decision;
    row.status = body.decision === "Approved" ? "Interested" : "Closed";
    return;
  }
  if (!participant(auth, row)) fail(403, "This conversation belongs to other clients.");
  if (row.approval_status !== "Approved") fail(403, "Wait for Admin to approve this chat request.");
  if (row.blocked) fail(409, "This conversation is blocked.");
  if (action === "status") {
    if (!["Closed", "Negotiating", "Reported", "Blocked", "Reserved"].includes(body.status)) fail(400, "Invalid chat status.");
    if (body.status === "Reserved" && auth.clientId !== row.seller_client_id) fail(403, "Only the listing owner can mark this conversation reserved.");
    row.status = body.status;
    row.reported = row.reported || body.status === "Reported";
    row.blocked = body.status === "Blocked";
    return;
  }
  if (action !== "message") fail(400, "Invalid action.");
  if (row.status === "Closed") fail(409, "Reopen the conversation before sending.");
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (text.length > 4000) fail(400, "Message must be 4,000 characters or fewer.");
  const id = typeof body.messageId === "string" ? body.messageId : "";
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) fail(400, "A valid message ID is required.");
  let attachment = null;
  if (body.attachment) {
    const file = body.attachment;
    const match = typeof file.dataUrl === "string" && file.dataUrl.match(/^data:(application\/pdf|image\/(?:png|jpeg|gif|webp));base64,([a-zA-Z0-9+/=\r\n]+)$/);
    if (!match) fail(400, "Use a PDF, PNG, JPG, GIF or WebP file.");
    const size = Buffer.from(match[2], "base64").length;
    if (!size || size > 8 * 1024 * 1024) fail(400, "File must be smaller than 8 MB.");
    attachment = { fileName: String(file.fileName || "attachment").slice(0, 200), mimeType: match[1], size, dataUrl: file.dataUrl };
  }
  if (!text && !attachment) fail(400, "Enter a message or attach a file.");
  // Client-generated IDs make a retry after a lost response safe.
  if (row.messages.some((message) => message.id === id)) return;
  row.messages.push({
    id, text, attachment, senderId: auth.userId, senderClientId: auth.clientId,
    senderName: auth.clientId === row.buyer_client_id ? row.requester_name : row.owner_name,
    sentAt: new Date().toISOString()
  });
  row.status = "Negotiating";
}

function createMysqlStore(pool, ensureThreads) {
  let ready;
  async function ensure() {
    if (!ready) ready = (async () => {
      await ensureThreads();
      const [columns] = await pool.query("SHOW COLUMNS FROM marketplace_threads LIKE 'approval_status'");
      if (!columns.length) {
        try {
          await pool.query("ALTER TABLE marketplace_threads ADD COLUMN approval_status VARCHAR(16) NOT NULL DEFAULT 'Pending'");
        } catch (error) {
          if (error.code !== "ER_DUP_FIELDNAME") throw error;
        }
      }
    })().catch((error) => { ready = null; throw error; });
    return ready;
  }
  const joined = "SELECT t.*, l.title, v.reg_no AS registration, requester.name AS requester_name, owner.name AS owner_name FROM marketplace_threads t LEFT JOIN listings l ON l.id = t.listing_id LEFT JOIN vehicles v ON v.id = l.vehicle_id LEFT JOIN clients requester ON requester.id = t.buyer_client_id LEFT JOIN clients owner ON owner.id = t.seller_client_id";
  return {
    async cleanupExpired() {
      await ensure();
      const [result] = await pool.query(
        "DELETE FROM marketplace_threads WHERE COALESCE(" +
          "STR_TO_DATE(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ'), " +
          "STR_TO_DATE(updated_at, '%Y-%m-%dT%H:%i:%sZ'), " +
          "STR_TO_DATE(updated_at, '%e/%c/%Y, %l:%i:%s %p')" +
        ") < DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${CHAT_RETENTION_DAYS} DAY)"
      );
      return result.affectedRows || 0;
    },
    async list(auth) {
      await ensure();
      const admin = auth.role === "Admin";
      if (!admin && !isClient(auth)) fail(403, "Client access required.");
      const [rows] = await pool.query(joined + (admin ? "" : " WHERE t.buyer_client_id = ? OR t.seller_client_id = ?") + " ORDER BY t.updated_at DESC, t.id", admin ? [] : [auth.clientId, auth.clientId]);
      return rows.map(decode);
    },
    async request(auth, listingId) {
      if (!isClient(auth)) fail(403, "Client access required.");
      await ensure();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [listings] = await conn.query("SELECT l.id, l.status, v.client_id FROM listings l JOIN vehicles v ON v.id = l.vehicle_id WHERE l.id = ? FOR UPDATE", [listingId]);
        const listing = listings[0];
        if (!listing || !["Active", "Reserved"].includes(listing.status)) fail(409, "This listing is not available for chat.");
        if (!listing.client_id || listing.client_id === auth.clientId) fail(400, "You cannot request a chat with your own listing.");
        const [existing] = await conn.query("SELECT id FROM marketplace_threads WHERE listing_id = ? AND buyer_client_id = ? AND seller_client_id = ? ORDER BY created_at LIMIT 1", [listingId, auth.clientId, listing.client_id]);
        const id = existing[0]?.id || "mt-" + crypto.randomUUID();
        if (!existing.length) {
          await conn.query("INSERT INTO marketplace_threads (id, listing_id, buyer_client_id, seller_client_id, status, approval_status, messages_json, updated_at) VALUES (?, ?, ?, ?, 'Interested', 'Pending', '[]', ?)", [id, listingId, auth.clientId, listing.client_id, new Date().toISOString()]);
        }
        await conn.commit();
        return id;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally { conn.release(); }
    },
    async mutate(auth, id, action, body) {
      await ensure();
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        // Lock before reading history so simultaneous sends cannot overwrite each other.
        const [locked] = await conn.query("SELECT id FROM marketplace_threads WHERE id = ? FOR UPDATE", [id]);
        if (!locked.length) fail(404, "Conversation not found.");
        const [rows] = await conn.query(joined + " WHERE t.id = ?", [id]);
        const row = decode(rows[0]);
        applyAction(auth, row, action, body);
        row.updated_at = new Date().toISOString();
        await conn.query("UPDATE marketplace_threads SET approval_status = ?, status = ?, messages_json = ?, reported = ?, blocked = ?, updated_at = ? WHERE id = ?", [row.approval_status, row.status, JSON.stringify(row.messages), row.reported ? 1 : 0, row.blocked ? 1 : 0, row.updated_at, id]);
        await conn.commit();
        return row;
      } catch (error) {
        await conn.rollback();
        throw error;
      } finally { conn.release(); }
    }
  };
}

function mountMarketplaceChat(app, store) {
  const subscribers = new Set();
  let cleanupBusy = false;
  const wrap = (handler) => async (req, res, next) => {
    try { await handler(req, res); } catch (error) {
      if (error.status) res.status(error.status).json({ error: error.message });
      else next(error);
    }
  };
  const changed = () => { for (const refresh of subscribers) refresh(); };
  const cleanupExpired = async () => {
    if (cleanupBusy || !store.cleanupExpired) return;
    cleanupBusy = true;
    try {
      const deleted = await store.cleanupExpired();
      if (deleted) changed();
    } catch (error) {
      console.error("[marketplace-chat] cleanup failed:", error.message);
    } finally {
      cleanupBusy = false;
    }
  };
  void cleanupExpired();
  setInterval(cleanupExpired, 24 * 60 * 60 * 1000);
  app.get("/api/marketplace-chat/threads", wrap(async (req, res) => {
    res.set("Cache-Control", "no-store").json((await store.list(req.auth)).map(serialize));
  }));
  app.get("/api/marketplace-chat/events", wrap(async (req, res) => {
    await store.list(req.auth);
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let last = "";
    let stopped = false;
    let busy = false;
    let again = false;
    const refresh = async () => {
      if (stopped) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        if (req.auth.expiresAt <= Date.now()) { res.end(); return; }
        const snapshot = JSON.stringify((await store.list(req.auth)).map(serialize));
        if (!stopped && snapshot !== last) {
          last = snapshot;
          res.write("data: " + snapshot + "\n\n");
        }
      } catch {
        if (!stopped) res.end();
      } finally {
        busy = false;
        if (again && !stopped) { again = false; void refresh(); }
      }
    };
    subscribers.add(refresh);
    // Reconcile across backend instances and missed events.
    const timer = setInterval(refresh, 3000);
    const heartbeat = setInterval(() => { if (!stopped) res.write(": heartbeat\n\n"); }, 15000);
    res.on("close", () => { stopped = true; clearInterval(timer); clearInterval(heartbeat); subscribers.delete(refresh); });
    void refresh();
  }));
  app.post("/api/marketplace-chat/requests", wrap(async (req, res) => {
    const id = await store.request(req.auth, String(req.body?.listingId || ""));
    changed();
    res.status(201).json({ id });
  }));
  app.post("/api/marketplace-chat/threads/:id/:action", wrap(async (req, res) => {
    const row = await store.mutate(req.auth, req.params.id, req.params.action, req.body || {});
    changed();
    res.json(serialize(row));
  }));
}

module.exports = { mountMarketplaceChat, createMysqlStore, applyAction, serialize };
