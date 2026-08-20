const fs = require("fs");
const mysql = require("mysql2/promise");

const out = [];
const log = (s) => out.push(s);

(async () => {
  const c = await mysql.createConnection({
    host: "localhost",
    user: "transportsoft",
    password: "YM4EFyph7h48akDj",
    database: "transportsoft"
  });

  const [rows] = await c.execute("SELECT id, name, email, role, password_hash FROM users");
  log("USERS TABLE:");
  log(JSON.stringify(rows, null, 2));

  const [loginRows] = await c.execute(
    `SELECT u.*, c.id AS client_id
     FROM users u
     LEFT JOIN clients c ON c.id = CONCAT('c-', SUBSTRING(u.id, 3))
     WHERE u.email = ? AND u.password_hash = ?`,
    ["admin@kuber.local", "admin123"]
  );
  log("LOGIN RESULT (admin123):");
  log(JSON.stringify(loginRows, null, 2));

  await c.end();
})().catch((e) => {
  log("EXCEPTION: " + e.message);
  if (e.errors) {
    log("AGGREGATE ERRORS:");
    for (const err of e.errors) {
      log("  - " + err.code + ": " + err.message);
    }
  }
  log("STACK: " + e.stack);
}).finally(() => {
  fs.writeFileSync("test-output.txt", out.join("\n"), "utf8");
  process.exit(0);
});