const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

const db = new Database('urls.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    short_code TEXT UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME,
    click_count INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url_id INTEGER NOT NULL,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (url_id) REFERENCES urls(id)
  );

  CREATE INDEX IF NOT EXISTS idx_short_code ON urls(short_code);
  CREATE INDEX IF NOT EXISTS idx_url_id ON clicks(url_id);
`);

function generateShortCode() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/shorten', (req, res) => {
  const { url, expiresIn } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  let finalUrl = url.trim();
  if (!finalUrl.startsWith('http://') && !finalUrl.startsWith('https://')) {
    finalUrl = 'https://' + finalUrl;
  }

  try {
    new URL(finalUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  let expiresAt = null;
  if (expiresIn) {
    const hours = parseInt(expiresIn);
    if (!isNaN(hours) && hours > 0) {
      const now = new Date();
      now.setHours(now.getHours() + hours);
      expiresAt = now.toISOString();
    }
  }

  const existing = db.prepare('SELECT short_code, original_url FROM urls WHERE original_url = ?').get(finalUrl);
  if (existing) {
    return res.json({
      shortCode: existing.short_code,
      originalUrl: existing.original_url,
      expiresAt: db.prepare('SELECT expires_at FROM urls WHERE short_code = ?').get(existing.short_code)?.expires_at
    });
  }

  let shortCode = generateShortCode();
  while (db.prepare('SELECT 1 FROM urls WHERE short_code = ?').get(shortCode)) {
    shortCode = generateShortCode();
  }

  db.prepare('INSERT INTO urls (short_code, original_url, expires_at) VALUES (?, ?, ?)')
    .run(shortCode, finalUrl, expiresAt);

  res.json({ shortCode, originalUrl: finalUrl, expiresAt });
});

app.get('/api/urls', (req, res) => {
  const urls = db.prepare(`
    SELECT short_code, original_url, created_at, expires_at, click_count
    FROM urls ORDER BY created_at DESC
  `).all();
  res.json(urls);
});

app.get('/api/urls/:shortCode', (req, res) => {
  const { shortCode } = req.params;
  const url = db.prepare(`
    SELECT short_code, original_url, created_at, expires_at, click_count
    FROM urls WHERE short_code = ?
  `).get(shortCode);

  if (!url) {
    return res.status(404).json({ error: 'URL not found' });
  }

  const clicks = db.prepare(`
    SELECT DATE(clicked_at) as date, COUNT(*) as count
    FROM clicks WHERE url_id = ?
    GROUP BY DATE(clicked_at)
    ORDER BY date DESC
    LIMIT 30
  `).all(url.id);

  res.json({ ...url, analytics: clicks });
});

app.delete('/api/urls/:shortCode', (req, res) => {
  const { shortCode } = req.params;
  const url = db.prepare('SELECT id FROM urls WHERE short_code = ?').get(shortCode);

  if (!url) {
    return res.status(404).json({ error: 'URL not found' });
  }

  db.prepare('DELETE FROM clicks WHERE url_id = ?').run(url.id);
  db.prepare('DELETE FROM urls WHERE short_code = ?').run(shortCode);

  res.json({ success: true });
});

app.get('/:shortCode', (req, res) => {
  const { shortCode } = req.params;
  const url = db.prepare('SELECT id, original_url, expires_at FROM urls WHERE short_code = ?').get(shortCode);

  if (!url) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }

  if (url.expires_at) {
    const now = new Date();
    const expires = new Date(url.expires_at);
    if (now > expires) {
      db.prepare('DELETE FROM clicks WHERE url_id = ?').run(url.id);
      db.prepare('DELETE FROM urls WHERE short_code = ?').run(shortCode);
      return res.status(410).send('This link has expired');
    }
  }

  db.prepare('UPDATE urls SET click_count = click_count + 1 WHERE id = ?').run(url.id);
  db.prepare('INSERT INTO clicks (url_id) VALUES (?)').run(url.id);

  res.redirect(url.original_url);
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`URL Shortener running at http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  db.close();
  process.exit();
});