/**
 * Imports schema.sql and seed.sql into the configured MySQL database.
 * Usage: node import-db.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    connectTimeout: 20000,
  });

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const seed = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');

  console.log('Importing schema...');
  await conn.query(schema);

  console.log('Importing seed data...');
  await conn.query(seed);

  const [tables] = await conn.query('SHOW TABLES');
  console.log('TABLES:', tables.map((r) => Object.values(r)[0]).join(', '));

  const [users] = await conn.query('SELECT id, name, role, email FROM users');
  console.log('USERS:', JSON.stringify(users));

  await conn.end();
  console.log('IMPORT DONE');
}

main().catch((err) => {
  console.error('IMPORT FAILED:', err.message);
  process.exit(1);
});