const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── Page routes ───────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presage-consult.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id          SERIAL PRIMARY KEY,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      service     TEXT,
      concept     TEXT,
      neighborhood TEXT,
      phone       TEXT,
      notes       TEXT,
      status      TEXT DEFAULT 'pending'
    )
  `);
  console.log('Database ready.');
}

// ── POST /api/chat ─ Anthropic proxy ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });

    const data = await response.json();

    if (!response.ok) {
      const code = data?.error?.type === 'authentication_error' ? 'NO_KEY'
        : data?.error?.type === 'rate_limit_error' ? 'RATE_LIMITED'
        : 'API_ERROR';
      return res.status(response.status).json({ ...data, code });
    }

    res.json(data);
  } catch (err) {
    console.error('Anthropic proxy error:', err);
    res.status(502).json({ error: 'Upstream error', code: 'NETWORK' });
  }
});

// ── POST /api/contact ─ save client + send emails ────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, service, concept, neighborhood, phone, notes } = req.body;

  if (!name || !email || !service || !concept) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Save to database
    const result = await pool.query(
      `INSERT INTO clients (name, email, service, concept, neighborhood, phone, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id, created_at`,
      [name, email, service, concept, neighborhood || null, phone || null, notes || null]
    );
    const client = result.rows[0];

    // Send emails via Resend (non-blocking)
    sendEmails({ id: client.id, name, email, service, concept, neighborhood, phone, notes })
      .catch(err => console.error('Email send error:', err));

    res.json({ success: true, id: client.id });
  } catch (err) {
    console.error('Contact save error:', err);
    res.status(500).json({ error: 'Failed to save request' });
  }
});

async function sendEmails({ id, name, email, service, concept, neighborhood, phone, notes }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;

  const serviceLabel = service === 'consult' ? 'Presage Consult ($500)' : 'Presage Audit ($2,500)';
  const nbhd = neighborhood || 'Not specified';
  const ph = phone || 'Not provided';
  const nt = notes || 'None';

  // Internal notification
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'PresageIQ <noreply@presageiq.com>',
      to: ['walley.research@gmail.com'],
      subject: `New ${serviceLabel} Request — ${name} (#${id})`,
      html: `
        <div style="font-family:monospace;background:#080b10;color:#eef1f4;padding:24px;border-radius:8px;max-width:600px;">
          <h2 style="color:#c8963e;margin:0 0 16px;">New Client Request #${id}</h2>
          <table style="border-collapse:collapse;width:100%;font-size:13px;">
            <tr><td style="color:#8a9aaa;padding:6px 0;width:140px;">Name</td><td style="color:#eef1f4;">${name}</td></tr>
            <tr><td style="color:#8a9aaa;padding:6px 0;">Email</td><td style="color:#eef1f4;">${email}</td></tr>
            <tr><td style="color:#8a9aaa;padding:6px 0;">Service</td><td style="color:#c8963e;">${serviceLabel}</td></tr>
            <tr><td style="color:#8a9aaa;padding:6px 0;">Neighborhood</td><td style="color:#eef1f4;">${nbhd}</td></tr>
            <tr><td style="color:#8a9aaa;padding:6px 0;">Phone</td><td style="color:#eef1f4;">${ph}</td></tr>
            <tr><td style="color:#8a9aaa;padding:6px 0;">Business/Concept</td><td style="color:#eef1f4;">${concept}</td></tr>
            <tr><td style="color:#8a9aaa;padding:6px 0;">Notes</td><td style="color:#eef1f4;">${nt}</td></tr>
          </table>
          <p style="margin:16px 0 0;font-size:11px;color:#3d5060;">View in queue: presage-audit.html → Client Queue</p>
        </div>
      `,
    }),
  });

  // Client confirmation
  const isAudit = service === 'audit';
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Towns & Walley Intelligence <noreply@presageiq.com>',
      to: [email],
      subject: `We received your ${isAudit ? 'Presage Audit' : 'Presage Consult'} request`,
      html: `
        <div style="font-family:monospace;background:#080b10;color:#eef1f4;padding:32px;border-radius:8px;max-width:560px;margin:0 auto;">
          <h1 style="font-size:22px;color:#c8963e;margin:0 0 8px;">Towns &amp; Walley Intelligence</h1>
          <p style="color:#52c5b0;font-size:11px;letter-spacing:2px;text-transform:uppercase;margin:0 0 24px;">Request Confirmed</p>
          <p style="color:#eef1f4;line-height:1.7;margin:0 0 16px;">
            Hi ${name} — we've received your <strong style="color:#c8963e;">${isAudit ? 'Presage Audit' : 'Presage Consult'}</strong> request and will be in touch within 48 hours to confirm your session and next steps.
          </p>
          <div style="background:#0d1117;border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:16px;margin:20px 0;">
            <p style="font-size:11px;color:#8a9aaa;margin:0 0 8px;letter-spacing:1px;text-transform:uppercase;">What you submitted</p>
            <p style="color:#eef1f4;margin:0 0 6px;font-size:13px;"><strong style="color:#8a9aaa;">Service:</strong> ${serviceLabel}</p>
            <p style="color:#eef1f4;margin:0 0 6px;font-size:13px;"><strong style="color:#8a9aaa;">Neighborhood:</strong> ${nbhd}</p>
            <p style="color:#eef1f4;margin:0;font-size:13px;"><strong style="color:#8a9aaa;">Concept:</strong> ${concept.substring(0, 120)}${concept.length > 120 ? '…' : ''}</p>
          </div>
          <p style="color:#8a9aaa;font-size:12px;line-height:1.6;margin:0 0 8px;">
            Questions? Reply to this email or reach us at walley.research@gmail.com.
          </p>
          <p style="color:#3d5060;font-size:11px;margin:24px 0 0;">Towns &amp; Walley Intelligence · Kansas City</p>
        </div>
      `,
    }),
  });
}

// ── GET /api/clients ──────────────────────────────────────────────────────────
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM clients ORDER BY created_at DESC`);
    res.json(result.rows);
  } catch (err) {
    console.error('Fetch clients error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── GET /api/clients/:id ──────────────────────────────────────────────────────
app.get('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  try {
    const result = await pool.query(`SELECT * FROM clients WHERE id = $1`, [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Fetch client error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── PATCH /api/clients/:id ────────────────────────────────────────────────────
app.patch('/api/clients/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body;
  const allowed = ['pending', 'active', 'complete'];

  if (!id) return res.status(400).json({ error: 'Invalid id' });
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: 'status must be pending, active, or complete' });
  }

  try {
    const result = await pool.query(
      `UPDATE clients SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Update client error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── Fallback ──────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'presage-consult.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PresageIQ running on port ${PORT}`);
  if (!process.env.DATABASE_URL) {
    console.warn('WARNING: DATABASE_URL not set — database features disabled. Add a PostgreSQL service in Railway.');
    return;
  }
  initDb().catch(err => {
    console.error('DB init failed (server still running):', err.message);
  });
});
