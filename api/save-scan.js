import { createClient } from "@libsql/client";

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { TURSO_DB_URL, TURSO_AUTH_TOKEN } = process.env;
  if (!TURSO_DB_URL || !TURSO_AUTH_TOKEN) {
    return res.status(500).json({ error: 'Turso credentials not configured' });
  }

  const client = createClient({ url: TURSO_DB_URL, authToken: TURSO_AUTH_TOKEN });

  try {
    // Create table if it doesn't exist
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

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const {
      product_name, search_query, score, score_label,
      oxalate_level, category, safe, calcium_oxalate_risk,
      uric_acid_risk, summary, negatives, positives, source
    } = body;

    // Don't save duplicates scanned within 1 hour
    const recent = await client.execute({
      sql: `SELECT id FROM scans WHERE product_name = ? AND scanned_at > datetime('now', '-1 hour') LIMIT 1`,
      args: [product_name]
    });
    if (recent.rows.length > 0) {
      return res.status(200).json({ saved: false, reason: 'recent duplicate' });
    }

    await client.execute({
      sql: `INSERT INTO scans
        (product_name, search_query, score, score_label, oxalate_level, category,
         safe, calcium_oxalate_risk, uric_acid_risk, summary, negatives, positives, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        product_name, search_query, score, score_label,
        oxalate_level, category, safe, calcium_oxalate_risk,
        uric_acid_risk, summary,
        JSON.stringify(negatives || []),
        JSON.stringify(positives || []),
        source || 'AI Analysis'
      ]
    });

    return res.status(200).json({ saved: true });
  } catch (err) {
    console.error('Turso error:', err);
    return res.status(500).json({ error: err.message });
  }
}
