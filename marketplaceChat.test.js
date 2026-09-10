const test = require("node:test");
const assert = require("node:assert/strict");
const { applyAction } = require("./marketplaceChat");

const owner = { role: "Customer", userId: "u-owner", clientId: "client-owner" };
const buyer = { role: "Customer", userId: "u-buyer", clientId: "client-buyer" };
const other = { role: "Customer", userId: "u-other", clientId: "client-other" };
const admin = { role: "Admin", userId: "u-admin" };

function makeThread(approval = "Pending") {
  return { id: "thread-1", listing_id: "listing-1", buyer_client_id: buyer.clientId, seller_client_id: owner.clientId,
    requester_name: "Buyer client", owner_name: "Vehicle owner", approval_status: approval, status: "Interested", messages: [], reported: false, blocked: false };
}
function send(auth, row, id, text) {
  applyAction(auth, row, "message", { messageId: id, text });
}

test("Admin approval is required before either client can send", () => {
  const row = makeThread();
  assert.throws(() => send(buyer, row, "message-1", "Hello"), { status: 403 });
  assert.throws(() => applyAction(buyer, row, "decision", { decision: "Approved" }), { status: 403 });
  applyAction(admin, row, "decision", { decision: "Approved" });
  send(buyer, row, "message-1", "Hello");
  send(owner, row, "message-2", "Reply");
  assert.deepEqual(row.messages.map((message) => message.senderClientId), [buyer.clientId, owner.clientId]);
});

test("Only the two clients in the listing thread can write it", () => {
  const row = makeThread("Approved");
  assert.throws(() => send(other, row, "message-1", "Private"), { status: 403 });
  send(buyer, row, "message-1", "Hello");
  assert.equal(row.messages[0].senderClientId, buyer.clientId);
  assert.equal(row.messages[0].senderName, "Buyer client");
});

test("Retries do not duplicate a message and closed chats must be reopened", () => {
  const row = makeThread("Approved");
  send(buyer, row, "message-1", "Hello");
  send(buyer, row, "message-1", "Hello");
  assert.equal(row.messages.length, 1);
  applyAction(owner, row, "status", { status: "Closed" });
  assert.throws(() => send(buyer, row, "message-2", "Second"), { status: 409 });
  applyAction(buyer, row, "status", { status: "Negotiating" });
  send(buyer, row, "message-2", "Second");
  assert.equal(row.messages.length, 2);
});

test("Only the listing owner can reserve the listing conversation", () => {
  const row = makeThread("Approved");
  assert.throws(() => applyAction(buyer, row, "status", { status: "Reserved" }), { status: 403 });
  applyAction(owner, row, "status", { status: "Reserved" });
  assert.equal(row.status, "Reserved");
});

test("Invalid attachment types and empty messages are rejected", () => {
  const row = makeThread("Approved");
  assert.throws(() => applyAction(buyer, row, "message", { messageId: "message-1", text: " " }), { status: 400 });
  assert.throws(() => applyAction(buyer, row, "message", {
    messageId: "message-2",
    attachment: { fileName: "script.html", dataUrl: "data:text/html;base64,PHNjcmlwdD4=" }
  }), { status: 400 });
});

