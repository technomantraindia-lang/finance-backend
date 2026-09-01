const mysql = require('mysql2/promise');

(async () => {
  try {
    const conn = await mysql.createConnection({
      host: process.env.DB_HOST || '209.182.233.18',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'transportsoft',
      password: process.env.DB_PASSWORD || 'YM4EFyph7h48akDj',
      database: process.env.DB_NAME || 'transportsoft',
      connectTimeout: 15000,
    });
    const [r] = await conn.query('SELECT DATABASE() AS db, VERSION() AS ver');
    console.log('CONNECTED:', JSON.stringify(r[0]));
    const [t] = await conn.query('SHOW TABLES');
    console.log('TABLES:', t.map((x) => Object.values(x)[0]).join(', ') || '(none)');
    await conn.end();
  } catch (e) {
    console.error('FAILED:', e.code, e.message);
    process.exit(1);
  }
})();