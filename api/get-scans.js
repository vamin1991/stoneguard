import { createClient } from "@libsql/client";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { TURSO_DB_URL, TURSO_AUTH_TOKEN } = process.env;
  if (!TURSO_DB_URL || !TURSO_AUTH_TOKEN) {
    return res.status(500).json({ error: 'Turso credentials not configured' });
  }

  const client = createClient({ url: TURSO_DB_URL, authToken: TURSO_AUTH_TOKEN });

  try {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS scans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_name TEXT NOT NULL,
        search_query TEXT,
        score INTEGER,
        score_label TEXT,
        oxalate_level TEXT,
        category TEXT,
        safe TEXT,
        calcium_oxalate_risk TEXT,
        uric_acid_risk TEXT,
        summary TEXT,
        negatives TEXT,
        positives TEXT,
        source TEXT,
        status TEXT DEFAULT 'Pending Review',
        scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const limit = req.query?.limit || 100;
    const status = req.query?.status || null;

    let sql = `SELECT * FROM scans`;
    const args = [];
    if (status) {
      sql += ` WHERE status = ?`;
      args.push(status);
    }
    sql += ` ORDER BY scanned_at DESC LIMIT ?`;
    args.push(Number(limit));

    const result = await client.execute({ sql, args });

    // Stats
    const stats = await client.execute(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'Pending Review' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'Approved' THEN 1 END) as approved,
        COUNT(CASE WHEN DATE(scanned_at) = DATE('now') THEN 1 END) as today
      FROM scans
    `);

    return res.status(200).json({
      scans: result.rows,
      stats: stats.rows[0]
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
