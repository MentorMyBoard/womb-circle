require('dotenv').config();
const express    = require('express');
const compression = require('compression');
const initSqlJs  = require('sql.js');
const Razorpay   = require('razorpay');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'womb.db');
const SITE_URL = (process.env.SITE_URL || 'https://mmbwombcircle.com').replace(/\/$/, '');

// ── Pure-JS SQLite wrapper (sql.js, no native compilation) ──────────────────
// Provides a better-sqlite3-style synchronous API (prepare/run/get/all).
class DB {
  constructor(sqlJs) {
    let buf = null;
    try { buf = fs.readFileSync(DB_PATH); } catch {}
    this._db = buf ? new sqlJs.Database(buf) : new sqlJs.Database();
    this._timer = null;
  }

  exec(sql) {
    this._db.run(sql);
    this._save();
    return this;
  }

  prepare(sql) {
    const self = this;
    return {
      run(...params) {
        const args = params.flat();
        self._db.run(sql, args);
        self._save();
        const idRows = self._db.exec('SELECT last_insert_rowid() AS id');
        return { lastInsertRowid: idRows[0]?.values[0][0] ?? null };
      },
      get(...params) {
        const args = params.flat();
        const stmt = self._db.prepare(sql);
        stmt.bind(args);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      },
      all(...params) {
        const args = params.flat();
        const stmt = self._db.prepare(sql);
        stmt.bind(args);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      }
    };
  }

  _save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      const data = this._db.export();
      fs.writeFileSync(DB_PATH, Buffer.from(data));
    }, 300);
  }
}

// ── Bootstrap: init sql.js, then start Express ─────────────────────────────
async function main() {
  const sqlJs = await initSqlJs();
  const db = new DB(sqlJs);

  // ── Create tables ─────────────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT,
      role        TEXT,
      interest    TEXT,
      message     TEXT,
      ip_address  TEXT,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payments (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      razorpay_order_id   TEXT UNIQUE,
      razorpay_payment_id TEXT,
      razorpay_signature  TEXT,
      name                TEXT,
      email               TEXT,
      phone               TEXT,
      amount              INTEGER,
      currency            TEXT DEFAULT 'INR',
      status              TEXT DEFAULT 'created',
      created_at          TEXT DEFAULT (datetime('now')),
      paid_at             TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      kicker      TEXT,
      description TEXT,
      image_url   TEXT,
      date_label  TEXT,
      location    TEXT,
      edition     TEXT,
      partner     TEXT,
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS photos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      url         TEXT NOT NULL,
      caption     TEXT,
      event_tag   TEXT,
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS videos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_url TEXT NOT NULL,
      embed_url   TEXT,
      title       TEXT,
      description TEXT,
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS page_visits (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_address  TEXT,
      user_agent  TEXT,
      referrer    TEXT,
      visited_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS womb_program_videos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      youtube_url TEXT NOT NULL,
      embed_url   TEXT,
      title       TEXT,
      description TEXT,
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS womb_batches (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_name     TEXT NOT NULL,
      cohort_number  INTEGER DEFAULT 0,
      batch_period   TEXT,
      status         TEXT DEFAULT 'completed',
      participants   INTEGER DEFAULT 0,
      highlights     TEXT,
      apply_url      TEXT,
      active         INTEGER DEFAULT 1,
      order_index    INTEGER DEFAULT 0,
      created_at     TEXT DEFAULT (datetime('now'))
    );
  `);

  // Seed default settings (idempotent)
  const defaultFee = process.env.MEMBERSHIP_FEE_PAISE || '500000';
  db._db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('membership_fee_paise', ?)", [defaultFee]);
  db._db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('membership_fee_label', '₹5,000')");
  db._db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('womb_apply_url', '')");
  db._db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('womb_apply_cta', 'Apply for the Next Cohort')");
  db._db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('womb_brochure_url', '')");
  db._save();

  // ── Razorpay ──────────────────────────────────────────────────────────────
  const razorpay = new Razorpay({
    key_id:     process.env.RAZORPAY_KEY_ID     || '',
    key_secret: process.env.RAZORPAY_KEY_SECRET || ''
  });

  // ── Load HTML template once (SSR replaces placeholders per request) ──────
  const htmlTemplate = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

  // ── Migrations (safe: ignore if column already exists) ───────────────────
  try { db._db.run('ALTER TABLE payments ADD COLUMN notes TEXT'); db._save(); } catch {}

  // ── Middleware ────────────────────────────────────────────────────────────
  app.use(compression());
  app.use(express.static(path.join(__dirname)));
  // Raw body needed for Razorpay webhook signature verification
  app.use('/api/razorpay-webhook',   express.raw({ type: 'application/json' }));
  app.use('/api/webhooks/razorpay',  express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // ── Helpers ───────────────────────────────────────────────────────────────
  function getClientIP(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  }

  function youtubeToEmbed(url) {
    if (!url) return '';
    const patterns = [
      /(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
      /[?&]v=([A-Za-z0-9_-]{11})/,
      /(?:youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/,
      /(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
    }
    return url;
  }

  // Convert any Google Drive sharing link to a direct embeddable image URL.
  // Supports: /file/d/ID/view, /open?id=ID, /d/ID, uc?id=ID forms.
  function googleDriveToDirectUrl(url) {
    if (!url) return url;
    if (!url.includes('drive.google.com') && !url.includes('docs.google.com')) return url;

    const patterns = [
      /\/file\/d\/([a-zA-Z0-9_-]+)/,
      /[?&]id=([a-zA-Z0-9_-]+)/,
      /\/d\/([a-zA-Z0-9_-]+)/
    ];
    for (const p of patterns) {
      const m = url.match(p);
      if (m) return `https://lh3.googleusercontent.com/d/${m[1]}`;
    }
    return url;
  }

  // ── Brevo email ───────────────────────────────────────────────────────────
  async function sendBrevoEmail({ to, toName, subject, htmlContent }) {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) { console.log('[Brevo] No API key — skipping email to:', to); return; }
    try {
      await axios.post('https://api.brevo.com/v3/smtp/email', {
        sender:      { name: process.env.BREVO_SENDER_NAME || 'WOMB Circle', email: process.env.BREVO_SENDER_EMAIL || 'noreply@wombcircle.com' },
        to:          [{ email: to, name: toName || to }],
        subject,
        htmlContent
      }, { headers: { 'api-key': apiKey, 'Content-Type': 'application/json' } });
    } catch (err) {
      console.error('[Brevo] Failed:', err?.response?.data || err.message);
    }
  }

  async function notifyAdmin(subject, html) {
    const e = process.env.BREVO_ADMIN_EMAIL;
    if (e) await sendBrevoEmail({ to: e, toName: 'WOMB Admin', subject, htmlContent: html });
  }

  // ── JWT middleware ────────────────────────────────────────────────────────
  function requireAdmin(req, res, next) {
    const auth  = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : (req.query.token || null);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try {
      jwt.verify(token, process.env.JWT_SECRET || 'womb-secret-key');
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/events', (_, res) => {
    res.json(db.prepare('SELECT * FROM events WHERE active=1 ORDER BY order_index ASC, id DESC').all());
  });

  app.get('/api/photos', (_, res) => {
    res.json(db.prepare('SELECT * FROM photos WHERE active=1 ORDER BY order_index ASC, id DESC').all());
  });

  app.get('/api/videos', (_, res) => {
    res.json(db.prepare('SELECT * FROM videos WHERE active=1 ORDER BY order_index ASC, id DESC').all());
  });

  app.get('/api/settings/public', (_, res) => {
    const fee        = db.prepare("SELECT value FROM settings WHERE key='membership_fee_paise'").get();
    const label      = db.prepare("SELECT value FROM settings WHERE key='membership_fee_label'").get();
    const applyUrl   = db.prepare("SELECT value FROM settings WHERE key='womb_apply_url'").get();
    const applyCta   = db.prepare("SELECT value FROM settings WHERE key='womb_apply_cta'").get();
    const brochureUrl= db.prepare("SELECT value FROM settings WHERE key='womb_brochure_url'").get();
    res.json({
      membership_fee_paise: fee ? parseInt(fee.value) : 500000,
      membership_fee_label: label ? label.value : '₹5,000',
      razorpay_key_id:      process.env.RAZORPAY_KEY_ID || '',
      womb_apply_url:       applyUrl ? applyUrl.value : '',
      womb_apply_cta:       applyCta ? applyCta.value : 'Apply for the Next Cohort',
      womb_brochure_url:    brochureUrl ? brochureUrl.value : ''
    });
  });

  app.get('/api/womb-batches', (_, res) => {
    res.json(db.prepare('SELECT * FROM womb_batches WHERE active=1 ORDER BY order_index ASC, id DESC').all());
  });

  app.get('/api/womb-program-videos', (_, res) => {
    res.json(db.prepare('SELECT * FROM womb_program_videos WHERE active=1 ORDER BY order_index ASC, id DESC').all());
  });

  // ── Zoho CRM helpers ─────────────────────────────────────────────────────
  async function getZohoAccessToken() {
    const clientId     = process.env.ZOHO_CLIENT_ID;
    const clientSecret = process.env.ZOHO_CLIENT_SECRET;
    let   refreshToken = process.env.ZOHO_REFRESH_TOKEN;
    if (!refreshToken) {
      const row = db.prepare("SELECT value FROM settings WHERE key='zoho_refresh_token'").get();
      refreshToken = row?.value;
    }
    if (!clientId || !clientSecret || !refreshToken) return null;
    const r = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
      params: { grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }
    });
    return r.data.access_token || null;
  }

  async function createZohoLead({ name, email, phone, role, interest, message }) {
    try {
      const token = await getZohoAccessToken();
      if (!token) return;
      const parts    = (name || '').trim().split(' ');
      const lastName  = parts.pop() || name;
      const firstName = parts.join(' ');
      await axios.post('https://www.zohoapis.in/crm/v2/Leads', {
        data: [{
          First_Name:  firstName,
          Last_Name:   lastName || 'Unknown',
          Email:       email,
          Phone:       phone || '',
          Lead_Source: 'Web Site',
          Designation: role || '',
          Description: `Interest: ${interest || ''}\n\nMessage: ${message || ''}`,
          Lead_Status: 'Not Contacted',
          Company:     'WOMB Circle'
        }]
      }, { headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' } });
      console.log(`Zoho Lead created: ${name} (${email})`);
    } catch (e) {
      console.error('Zoho Lead creation failed:', e.response?.data || e.message);
    }
  }

  // ── Zoho OAuth callback (one-time setup) ──────────────────────────────────
  app.get('/zoho-callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.send(`<h2>Zoho Error: ${error}</h2>`);
    if (!code) return res.send('<h2>No authorisation code received.</h2>');
    try {
      const r = await axios.post('https://accounts.zoho.in/oauth/v2/token', null, {
        params: {
          grant_type:    'authorization_code',
          client_id:     process.env.ZOHO_CLIENT_ID,
          client_secret: process.env.ZOHO_CLIENT_SECRET,
          redirect_uri:  `${SITE_URL}/zoho-callback`,
          code
        }
      });
      const { refresh_token, error: zErr } = r.data;
      if (zErr) return res.send(`<h2>Zoho Error: ${zErr}</h2><pre>${JSON.stringify(r.data,null,2)}</pre>`);
      if (refresh_token) {
        db._db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('zoho_refresh_token', ?)", [refresh_token]);
        db._save();
      }
      res.send(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:0 auto">
        <h2 style="color:#191970">&#10003; Zoho CRM Connected!</h2>
        <p>WOMB Circle is now linked. All enquiries will be created as Leads in Zoho CRM automatically.</p>
        ${refresh_token ? `<p>Also add this line to your <code>.env</code> on the server so it survives restarts:</p>
        <code style="background:#f0f0f8;padding:12px;display:block;border-radius:6px;word-break:break-all">ZOHO_REFRESH_TOKEN=${refresh_token}</code>` : ''}
        <p style="margin-top:24px"><a href="/admin" style="color:#191970">&#8592; Back to Admin</a></p>
      </body></html>`);
    } catch (e) {
      res.send(`<h2>Token exchange failed</h2><pre>${e.response?.data ? JSON.stringify(e.response.data,null,2) : e.message}</pre>`);
    }
  });

  // ── Enquiry form ──────────────────────────────────────────────────────────
  app.post('/api/enquiry', async (req, res) => {
    const { name, email, phone, role, interest, message } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    const ip = getClientIP(req);
    const r = db.prepare(
      'INSERT INTO enquiries (name, email, phone, role, interest, message, ip_address) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(name, email, phone || '', role || '', interest || '', message || '', ip);

    sendBrevoEmail({
      to: email, toName: name,
      subject: 'We received your enquiry — WOMB Circle',
      htmlContent: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
        <h2 style="color:#191970">Thank you, ${name}!</h2>
        <p style="color:#5d5d7a;line-height:1.6">We've received your enquiry and our team will get back to you within 1–2 business days.</p>
        <div style="background:#f6f6fb;border-radius:8px;padding:16px 20px;margin:24px 0">
          <strong>Interest:</strong> ${interest || '—'}<br>
          ${message ? `<strong>Message:</strong> ${message}` : ''}
        </div>
        <p style="color:#5d5d7a;font-size:.85rem">— The WOMB Circle Team</p>
      </div>`
    });

    notifyAdmin(`New Enquiry: ${name} (${interest || 'General'})`,
      `<div style="font-family:sans-serif;padding:24px"><h3>New Enquiry #${r.lastInsertRowid}</h3>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Name</td><td style="padding:6px 12px">${name}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Email</td><td style="padding:6px 12px">${email}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Phone</td><td style="padding:6px 12px">${phone || '—'}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Role</td><td style="padding:6px 12px">${role || '—'}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Interest</td><td style="padding:6px 12px">${interest || '—'}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Message</td><td style="padding:6px 12px">${message || '—'}</td></tr>
      </table></div>`
    );

    res.json({ success: true, id: r.lastInsertRowid });

    // Push lead to Zoho CRM (fire-and-forget, doesn't affect response)
    createZohoLead({ name, email, phone, role, interest, message });
  });

  // ── Create Razorpay order ─────────────────────────────────────────────────
  app.post('/api/create-order', async (req, res) => {
    const { name, email, phone } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    const feeSetting = db.prepare("SELECT value FROM settings WHERE key='membership_fee_paise'").get();
    const amount = parseInt(feeSetting?.value || process.env.MEMBERSHIP_FEE_PAISE || '500000');

    try {
      const order = await razorpay.orders.create({
        amount, currency: 'INR', receipt: `womb_${Date.now()}`,
        notes: { name, email, phone: phone || '' }, payment_capture: 1
      });

      db.prepare(
        'INSERT OR IGNORE INTO payments (razorpay_order_id, name, email, phone, amount, status) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(order.id, name, email, phone || '', amount, 'created');

      res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
    } catch (err) {
      console.error('[Razorpay] Create order error:', err);
      res.status(500).json({ error: 'Could not create payment order. Please try again.' });
    }
  });

  // ── Verify payment ────────────────────────────────────────────────────────
  app.post('/api/verify-payment', (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, name, email, phone } = req.body;

    const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
    const expectedSig = crypto.createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex');

    if (expectedSig !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    db.prepare(`UPDATE payments SET razorpay_payment_id=?, razorpay_signature=?, status='paid', paid_at=datetime('now') WHERE razorpay_order_id=?`)
      .run(razorpay_payment_id, razorpay_signature, razorpay_order_id);

    const payment = db.prepare('SELECT * FROM payments WHERE razorpay_order_id=?').get(razorpay_order_id);
    const amt = payment ? `₹${(payment.amount / 100).toLocaleString('en-IN')}` : '';

    sendBrevoEmail({
      to: email, toName: name,
      subject: 'Welcome to WOMB Circle — Membership Confirmed!',
      htmlContent: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
        <h2 style="color:#191970">Welcome to WOMB Circle, ${name}!</h2>
        <p style="color:#5d5d7a;line-height:1.6">Your membership payment of <strong>${amt}</strong> has been received. You are now part of India's premier community of women board leaders.</p>
        <div style="background:#f6f6fb;border-radius:8px;padding:16px 20px;margin:24px 0">
          <strong>Payment ID:</strong> ${razorpay_payment_id}<br>
          <strong>Order ID:</strong> ${razorpay_order_id}<br>
          <strong>Amount:</strong> ${amt}
        </div>
        <p style="color:#5d5d7a;line-height:1.6">Our team will reach out within 1–2 business days to complete your onboarding.</p>
        <p style="color:#5d5d7a;font-size:.85rem">— The WOMB Circle Team</p>
      </div>`
    });

    notifyAdmin(`New Payment: ${name} — ${amt}`,
      `<div style="font-family:sans-serif;padding:24px"><h3 style="color:#191970">✅ New Membership Payment</h3>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Name</td><td style="padding:6px 12px">${name}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Email</td><td style="padding:6px 12px">${email}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Phone</td><td style="padding:6px 12px">${phone || '—'}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Amount</td><td style="padding:6px 12px">${amt}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Payment ID</td><td style="padding:6px 12px">${razorpay_payment_id}</td></tr>
        <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Order ID</td><td style="padding:6px 12px">${razorpay_order_id}</td></tr>
      </table></div>`
    );

    res.json({ success: true });
  });

  // ── Shared webhook handler (used by both routes) ─────────────────────────
  function verifyWebhookSig(req) {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return true;
    const sig      = req.headers['x-razorpay-signature'] || '';
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    return sig === expected;
  }

  async function handleWebhookBody(body) {
    const event = body.event;
    console.log('[Webhook]', event);

    // ── Extract payment entity ──────────────────────────────────────────────
    const payEnt  = body.payload?.payment?.entity;
    const linkEnt = body.payload?.payment_link?.entity;

    const paymentId = payEnt?.id || '';
    const orderId   = payEnt?.order_id || '';
    const amount    = payEnt?.amount || linkEnt?.amount || 0;
    const email     = payEnt?.email     || linkEnt?.customer?.email   || '';
    const phone     = payEnt?.contact   || linkEnt?.customer?.contact || '';
    const name      = payEnt?.notes?.name || payEnt?.notes?.['Name'] ||
                      linkEnt?.customer?.name || '';
    const linkId    = linkEnt?.id || '';
    const amtFmt    = `₹${(amount / 100).toLocaleString('en-IN')}`;

    // ── Filter: only process WOMB Circle payment page ─────────────────────
    const allowedPageId = process.env.RAZORPAY_PAYMENT_PAGE_ID;
    if (allowedPageId) {
      // payment_link.paid carries linkEnt.id; payment.captured may carry payment_link_id or invoice_id
      const incomingPageId = linkEnt?.id
        || payEnt?.payment_page_id
        || payEnt?.payment_link_id
        || payEnt?.invoice_id
        || '';
      if (incomingPageId) {
        if (incomingPageId !== allowedPageId) {
          console.log(`[Webhook] BLOCKED — page ${incomingPageId} is not WOMB Circle`);
          return;
        }
      } else {
        // payment.captured / order.paid don't always carry the page ID.
        // Log full diagnostic payload so we can see exactly what Razorpay sends.
        console.log(`[Webhook] no page ID in ${event} — diagnostic:`, JSON.stringify({
          payment_link_id: payEnt?.payment_link_id,
          payment_page_id: payEnt?.payment_page_id,
          invoice_id:      payEnt?.invoice_id,
          order_id:        payEnt?.order_id,
          description:     payEnt?.description,
          method:          payEnt?.method,
          notes:           payEnt?.notes
        }));

        // Allow only if the payment was already recorded via a prior payment_link.paid event.
        const recorded = paymentId ? db.prepare('SELECT id FROM payments WHERE razorpay_payment_id=?').get(paymentId) : null;
        if (!recorded) {
          console.log(`[Webhook] SKIP ${event} — no page ID match and payment not yet in WOMB records`);
          // Alert admin so no payment is silently missed
          notifyAdmin(
            `⚠️ Possible missed WOMB payment — ${event}`,
            `<div style="font-family:sans-serif;padding:24px">
              <h3 style="color:#c0392b">Payment event skipped — manual review needed</h3>
              <p>A <strong>${event}</strong> webhook arrived with no Payment Page ID and no matching DB record.</p>
              <table style="border-collapse:collapse;font-size:.9rem">
                <tr><td style="padding:4px 12px 4px 0"><strong>Payment ID</strong></td><td>${paymentId || '—'}</td></tr>
                <tr><td style="padding:4px 12px 4px 0"><strong>Order ID</strong></td><td>${orderId || '—'}</td></tr>
                <tr><td style="padding:4px 12px 4px 0"><strong>Amount</strong></td><td>${amtFmt}</td></tr>
                <tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td>${email || '—'}</td></tr>
                <tr><td style="padding:4px 12px 4px 0"><strong>Name</strong></td><td>${name || '—'}</td></tr>
              </table>
              <p style="margin-top:16px">If this looks like a WOMB Circle payment, please add it manually in the Admin → Payments section.</p>
            </div>`
          );
          return;
        }
      }
    }

    if (event === 'payment.captured' || event === 'payment_link.paid' || event === 'order.paid') {
      const notes = linkId ? `Payment Link: ${linkId}` : `Event: ${event}`;

      // Upsert — avoid duplicates
      const existing = db.prepare('SELECT id FROM payments WHERE razorpay_payment_id=?').get(paymentId);
      if (existing) {
        db.prepare(`UPDATE payments SET status='paid', paid_at=datetime('now'), notes=? WHERE razorpay_payment_id=?`)
          .run(notes, paymentId);
      } else {
        db.prepare(`INSERT INTO payments (razorpay_payment_id, razorpay_order_id, name, email, phone, amount, status, notes, paid_at)
                    VALUES (?, ?, ?, ?, ?, ?, 'paid', ?, datetime('now'))`)
          .run(paymentId, orderId, name, email, phone, amount, notes);
      }

      // Email to customer
      if (email) {
        sendBrevoEmail({
          to: email, toName: name || email,
          subject: 'Welcome to WOMB Circle — Payment Confirmed!',
          htmlContent: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
              <h2 style="color:#191970">Welcome to WOMB Circle${name ? ', ' + name : ''}!</h2>
              <p style="color:#5d5d7a;line-height:1.6">Your membership payment of <strong>${amtFmt}</strong> has been received.
              You are now part of India's premier community of women board leaders.</p>
              <div style="background:#f6f6fb;border-radius:8px;padding:16px 20px;margin:24px 0">
                <strong>Payment ID:</strong> ${paymentId}<br>
                <strong>Amount:</strong> ${amtFmt}<br>
                <strong>Status:</strong> ✅ Confirmed
              </div>
              <p style="color:#5d5d7a;line-height:1.6">Our team will reach out within 1–2 business days to complete your onboarding.</p>
              <p style="color:#5d5d7a;font-size:.85rem">— The WOMB Circle Team<br>
              <a href="${SITE_URL}" style="color:#f99f1b">mmbwombcircle.com</a></p>
            </div>`
        });
      }

      notifyAdmin(`✅ New Payment: ${name || email} — ${amtFmt}`,
        `<div style="font-family:sans-serif;padding:24px">
          <h3 style="color:#191970">New Membership Payment</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Name</td><td style="padding:6px 12px">${name || '—'}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Email</td><td style="padding:6px 12px">${email || '—'}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Phone</td><td style="padding:6px 12px">${phone || '—'}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Amount</td><td style="padding:6px 12px">${amtFmt}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Payment ID</td><td style="padding:6px 12px">${paymentId}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Event</td><td style="padding:6px 12px">${event}</td></tr>
          </table>
          <p><a href="${SITE_URL}/admin">View Admin Panel →</a></p>
        </div>`
      );

    } else if (event === 'payment.failed') {
      const errCode = payEnt?.error_code || '';
      const errDesc = payEnt?.error_description || payEnt?.error_reason || 'Unknown error';
      const notes   = `FAILED — ${errCode}: ${errDesc}`;

      const existing = db.prepare('SELECT id FROM payments WHERE razorpay_payment_id=?').get(paymentId);
      if (!existing) {
        db.prepare(`INSERT INTO payments (razorpay_payment_id, razorpay_order_id, name, email, phone, amount, status, notes)
                    VALUES (?, ?, ?, ?, ?, ?, 'failed', ?)`)
          .run(paymentId, orderId, name, email, phone, amount, notes);
      }

      // Email customer about failure
      if (email) {
        sendBrevoEmail({
          to: email, toName: name || email,
          subject: 'Payment Failed — WOMB Circle',
          htmlContent: `
            <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px">
              <h2 style="color:#ef4444">Payment Could Not Be Processed</h2>
              <p style="color:#5d5d7a;line-height:1.6">Unfortunately your payment of <strong>${amtFmt}</strong> could not be completed.</p>
              <div style="background:#fee2e2;border-radius:8px;padding:16px 20px;margin:24px 0;color:#dc2626">
                <strong>Reason:</strong> ${errDesc}
              </div>
              <p style="color:#5d5d7a;line-height:1.6">Please try again or contact us at
              <a href="mailto:support@mentormyboard.com" style="color:#f99f1b">support@mentormyboard.com</a></p>
              <a href="${SITE_URL}/#join" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#f99f1b;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Try Again →</a>
              <p style="color:#5d5d7a;font-size:.85rem;margin-top:24px">— The WOMB Circle Team</p>
            </div>`
        });
      }

      notifyAdmin(`❌ Payment Failed: ${email || paymentId} — ${amtFmt}`,
        `<div style="font-family:sans-serif;padding:24px">
          <h3 style="color:#ef4444">Payment Failed</h3>
          <table style="border-collapse:collapse;width:100%">
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Email</td><td style="padding:6px 12px">${email || '—'}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Amount</td><td style="padding:6px 12px">${amtFmt}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Error</td><td style="padding:6px 12px">${errCode}: ${errDesc}</td></tr>
            <tr><td style="padding:6px 12px;background:#f6f6fb;font-weight:600">Payment ID</td><td style="padding:6px 12px">${paymentId}</td></tr>
          </table>
        </div>`
      );
    }
  }

  // ── Webhook routes (both old + new URL from Razorpay dashboard) ───────────
  function webhookRoute(req, res) {
    if (!verifyWebhookSig(req)) return res.status(400).send('Invalid signature');
    let body;
    try { body = JSON.parse(req.body); } catch { return res.status(400).send('Bad JSON'); }
    handleWebhookBody(body);
    res.json({ received: true });
  }

  app.post('/api/razorpay-webhook',  webhookRoute);
  app.post('/api/webhooks/razorpay', webhookRoute);

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN AUTH
  // ═══════════════════════════════════════════════════════════════════════════

  app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    if (password !== adminPass) return res.status(401).json({ error: 'Invalid password' });
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'womb-secret-key', { expiresIn: '24h' });
    res.json({ token });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ADMIN DATA ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/api/admin/enquiries', requireAdmin, (_, res) => {
    res.json(db.prepare('SELECT * FROM enquiries ORDER BY id DESC').all());
  });

  app.get('/api/admin/payments', requireAdmin, (_, res) => {
    res.json(db.prepare('SELECT * FROM payments ORDER BY id DESC').all());
  });

  app.delete('/api/admin/payments/:id', requireAdmin, (req, res) => {
    db.prepare('DELETE FROM payments WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  app.post('/api/admin/payments/manual', requireAdmin, (req, res) => {
    const { razorpay_payment_id, name, email, phone, amount_inr, paid_at, status } = req.body;
    if (!razorpay_payment_id) return res.status(400).json({ error: 'Payment ID is required' });
    const amount = Math.round(parseFloat(amount_inr || 0) * 100);
    if (!amount) return res.status(400).json({ error: 'Valid amount is required' });
    const existing = db.prepare('SELECT id FROM payments WHERE razorpay_payment_id=?').get(razorpay_payment_id);
    if (existing) return res.status(409).json({ error: 'Payment ID already exists' });
    const dateStr = paid_at ? paid_at.replace('T', ' ').slice(0, 19) : new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.prepare(`INSERT INTO payments (razorpay_payment_id, name, email, phone, amount, status, notes, paid_at) VALUES (?, ?, ?, ?, ?, ?, 'Manual entry', ?)`)
      .run(razorpay_payment_id, name || '', email || '', phone || '', amount, status || 'paid', dateStr);
    res.json({ success: true });
  });

  app.post('/api/admin/payments/import', requireAdmin, (req, res) => {
    const { rows } = req.body;
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows provided' });
    let inserted = 0, skipped = 0;
    for (const r of rows) {
      if (!r.razorpay_payment_id) { skipped++; continue; }
      const amount = Math.round(parseFloat(r.amount_inr || 0) * 100);
      if (!amount) { skipped++; continue; }
      const existing = db.prepare('SELECT id FROM payments WHERE razorpay_payment_id=?').get(r.razorpay_payment_id);
      if (existing) { skipped++; continue; }
      const dateStr = r.paid_at ? r.paid_at.replace('T', ' ').slice(0, 19) : new Date().toISOString().slice(0, 19).replace('T', ' ');
      db.prepare(`INSERT INTO payments (razorpay_payment_id, name, email, phone, amount, status, notes, paid_at) VALUES (?, ?, ?, ?, ?, ?, 'CSV Import', ?)`)
        .run(r.razorpay_payment_id, r.name || '', r.email || '', r.phone || '', amount, r.status || 'paid', dateStr);
      inserted++;
    }
    res.json({ success: true, inserted, skipped });
  });

  app.get('/api/admin/stats', requireAdmin, (_, res) => {
    const enquiries    = db.prepare('SELECT COUNT(*) AS c FROM enquiries').get()?.c ?? 0;
    const payments     = db.prepare("SELECT COUNT(*) AS c FROM payments WHERE status='paid'").get()?.c ?? 0;
    const revenue      = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid'").get()?.s ?? 0;
    const pending      = db.prepare("SELECT COUNT(*) AS c FROM payments WHERE status='created'").get()?.c ?? 0;
    const totalVisits  = db.prepare('SELECT COUNT(*) AS c FROM page_visits').get()?.c ?? 0;
    const uniqueVisits = db.prepare('SELECT COUNT(DISTINCT ip_address) AS c FROM page_visits').get()?.c ?? 0;
    const todayVisits  = db.prepare("SELECT COUNT(*) AS c FROM page_visits WHERE date(visited_at)=date('now')").get()?.c ?? 0;
    res.json({ enquiries, payments, revenue: revenue / 100, pending, totalVisits, uniqueVisits, todayVisits });
  });

  app.get('/api/admin/visitors', requireAdmin, (_, res) => {
    const recent = db.prepare('SELECT * FROM page_visits ORDER BY id DESC LIMIT 200').all();
    const daily  = db.prepare(
      "SELECT date(visited_at) AS day, COUNT(*) AS visits, COUNT(DISTINCT ip_address) AS unique_ips " +
      "FROM page_visits GROUP BY date(visited_at) ORDER BY day DESC LIMIT 30"
    ).all();
    const topIPs = db.prepare(
      "SELECT ip_address, COUNT(*) AS visits, MAX(visited_at) AS last_seen " +
      "FROM page_visits GROUP BY ip_address ORDER BY visits DESC LIMIT 50"
    ).all();
    res.json({ recent, daily, topIPs });
  });

  app.delete('/api/admin/visitors', requireAdmin, (_, res) => {
    db.exec('DELETE FROM page_visits');
    res.json({ success: true });
  });

  // Events CRUD
  app.get('/api/admin/events', requireAdmin, (_, res) => {
    res.json(db.prepare('SELECT * FROM events ORDER BY order_index ASC, id DESC').all());
  });

  app.post('/api/admin/events', requireAdmin, (req, res) => {
    const { title, kicker, description, image_url, date_label, location, edition, partner, order_index } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const r = db.prepare(
      'INSERT INTO events (title, kicker, description, image_url, date_label, location, edition, partner, order_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(title, kicker || '', description || '', image_url || '', date_label || '', location || '', edition || '', partner || '', order_index || 0);
    res.json({ id: r.lastInsertRowid });
  });

  app.put('/api/admin/events/:id', requireAdmin, (req, res) => {
    const { title, kicker, description, image_url, date_label, location, edition, partner, order_index, active } = req.body;
    db.prepare('UPDATE events SET title=?, kicker=?, description=?, image_url=?, date_label=?, location=?, edition=?, partner=?, order_index=?, active=? WHERE id=?')
      .run(title, kicker || '', description || '', image_url || '', date_label || '', location || '', edition || '', partner || '', order_index || 0, active ?? 1, req.params.id);
    res.json({ success: true });
  });

  app.delete('/api/admin/events/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE events SET active=0 WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  // Photos CRUD
  app.get('/api/admin/photos', requireAdmin, (_, res) => {
    res.json(db.prepare('SELECT * FROM photos ORDER BY order_index ASC, id DESC').all());
  });

  app.post('/api/admin/photos', requireAdmin, (req, res) => {
    const { url, caption, event_tag, order_index } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const directUrl = googleDriveToDirectUrl(url);
    const r = db.prepare('INSERT INTO photos (url, caption, event_tag, order_index) VALUES (?, ?, ?, ?)')
      .run(directUrl, caption || '', event_tag || '', order_index || 0);
    res.json({ id: r.lastInsertRowid });
  });

  app.put('/api/admin/photos/:id', requireAdmin, (req, res) => {
    const { url, caption, event_tag, order_index, active } = req.body;
    const directUrl = googleDriveToDirectUrl(url);
    db.prepare('UPDATE photos SET url=?, caption=?, event_tag=?, order_index=?, active=? WHERE id=?')
      .run(directUrl, caption || '', event_tag || '', order_index || 0, active ?? 1, req.params.id);
    res.json({ success: true });
  });

  app.delete('/api/admin/photos/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE photos SET active=0 WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  // Videos CRUD
  app.get('/api/admin/videos', requireAdmin, (_, res) => {
    res.json(db.prepare('SELECT * FROM videos ORDER BY order_index ASC, id DESC').all());
  });

  app.post('/api/admin/videos', requireAdmin, (req, res) => {
    const { youtube_url, title, description, order_index } = req.body;
    if (!youtube_url) return res.status(400).json({ error: 'YouTube URL required' });
    const embed_url = youtubeToEmbed(youtube_url);
    const r = db.prepare('INSERT INTO videos (youtube_url, embed_url, title, description, order_index) VALUES (?, ?, ?, ?, ?)')
      .run(youtube_url, embed_url, title || '', description || '', order_index || 0);
    res.json({ id: r.lastInsertRowid });
  });

  app.put('/api/admin/videos/:id', requireAdmin, (req, res) => {
    const { youtube_url, title, description, order_index, active } = req.body;
    const embed_url = youtubeToEmbed(youtube_url);
    db.prepare('UPDATE videos SET youtube_url=?, embed_url=?, title=?, description=?, order_index=?, active=? WHERE id=?')
      .run(youtube_url, embed_url, title || '', description || '', order_index || 0, active ?? 1, req.params.id);
    res.json({ success: true });
  });

  app.delete('/api/admin/videos/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE videos SET active=0 WHERE id=?').run(req.params.id);
    res.json({ success: true });
  });

  // Settings
  app.get('/api/admin/settings', requireAdmin, (_, res) => {
    const rows = db.prepare('SELECT * FROM settings').all();
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    res.json(s);
  });

  app.post('/api/admin/settings', requireAdmin, (req, res) => {
    const { membership_fee_paise, membership_fee_label, womb_apply_url, womb_apply_cta, womb_brochure_url } = req.body;
    if (membership_fee_paise) db._db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('membership_fee_paise', ?)", [String(parseInt(membership_fee_paise))]);
    if (membership_fee_label) db._db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('membership_fee_label', ?)", [membership_fee_label]);
    if (womb_apply_url  !== undefined) db._db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('womb_apply_url', ?)", [womb_apply_url]);
    if (womb_apply_cta  !== undefined) db._db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('womb_apply_cta', ?)", [womb_apply_cta]);
    if (womb_brochure_url !== undefined) db._db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('womb_brochure_url', ?)", [womb_brochure_url]);
    db._save();
    res.json({ success: true });
  });

  // ── WOMB Program batch CRUD ───────────────────────────────────────────────
  app.get('/api/admin/womb-batches', requireAdmin, (_, res) => {
    res.json(db.prepare('SELECT * FROM womb_batches ORDER BY order_index ASC, id DESC').all());
  });

  app.post('/api/admin/womb-batches', requireAdmin, (req, res) => {
    const { batch_name, cohort_number, batch_period, status, participants, highlights, apply_url, order_index } = req.body;
    if (!batch_name) return res.status(400).json({ error: 'batch_name required' });
    const r = db.prepare(`INSERT INTO womb_batches (batch_name, cohort_number, batch_period, status, participants, highlights, apply_url, order_index) VALUES (?,?,?,?,?,?,?,?)`)
      .run(batch_name, cohort_number || 0, batch_period || '', status || 'completed', participants || 0, highlights || '', apply_url || '', order_index || 0);
    db._save();
    res.json({ success: true, id: r.lastInsertRowid });
  });

  app.put('/api/admin/womb-batches/:id', requireAdmin, (req, res) => {
    const { batch_name, cohort_number, batch_period, status, participants, highlights, apply_url, active, order_index } = req.body;
    db.prepare(`UPDATE womb_batches SET batch_name=?, cohort_number=?, batch_period=?, status=?, participants=?, highlights=?, apply_url=?, active=?, order_index=? WHERE id=?`)
      .run(batch_name, cohort_number || 0, batch_period || '', status || 'completed', participants || 0, highlights || '', apply_url || '', active ?? 1, order_index || 0, req.params.id);
    db._save();
    res.json({ success: true });
  });

  app.delete('/api/admin/womb-batches/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE womb_batches SET active=0 WHERE id=?').run(req.params.id);
    db._save();
    res.json({ success: true });
  });

  // ── WOMB Program Videos CRUD ─────────────────────────────────────────────
  app.get('/api/admin/womb-program-videos', requireAdmin, (_, res) => {
    res.json(db.prepare('SELECT * FROM womb_program_videos ORDER BY order_index ASC, id DESC').all());
  });

  app.post('/api/admin/womb-program-videos', requireAdmin, (req, res) => {
    const { youtube_url, title, description, order_index } = req.body;
    if (!youtube_url) return res.status(400).json({ error: 'youtube_url required' });
    const embed_url = youtubeToEmbed(youtube_url);
    db.prepare('INSERT INTO womb_program_videos (youtube_url, embed_url, title, description, order_index) VALUES (?,?,?,?,?)')
      .run(youtube_url, embed_url, title || '', description || '', order_index || 0);
    db._save();
    res.json({ success: true });
  });

  app.put('/api/admin/womb-program-videos/:id', requireAdmin, (req, res) => {
    const { youtube_url, title, description, order_index, active } = req.body;
    const embed_url = youtubeToEmbed(youtube_url);
    db.prepare('UPDATE womb_program_videos SET youtube_url=?, embed_url=?, title=?, description=?, order_index=?, active=? WHERE id=?')
      .run(youtube_url, embed_url, title || '', description || '', order_index || 0, active ?? 1, req.params.id);
    db._save();
    res.json({ success: true });
  });

  app.delete('/api/admin/womb-program-videos/:id', requireAdmin, (req, res) => {
    db.prepare('UPDATE womb_program_videos SET active=0 WHERE id=?').run(req.params.id);
    db._save();
    res.json({ success: true });
  });

  // ── CSV export helpers ────────────────────────────────────────────────────
  function csvCell(v) {
    const s = String(v == null ? '' : v).replace(/"/g, '""');
    return `"${s}"`;
  }

  app.get('/api/admin/export/enquiries', requireAdmin, (_, res) => {
    const rows = db.prepare('SELECT * FROM enquiries ORDER BY id DESC').all();
    const lines = [
      ['ID','Name','Email','Phone','Role','Interest','Message','Date'].join(','),
      ...rows.map(r => [r.id, csvCell(r.name), csvCell(r.email), csvCell(r.phone),
        csvCell(r.role), csvCell(r.interest), csvCell(r.message), csvCell(r.created_at)].join(','))
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="womb-enquiries-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });

  app.get('/api/admin/export/payments', requireAdmin, (_, res) => {
    const rows = db.prepare('SELECT * FROM payments ORDER BY id DESC').all();
    const lines = [
      ['ID','Name','Email','Phone','Amount (INR)','Status','Payment ID','Order ID','Notes','Created','Paid At'].join(','),
      ...rows.map(r => [r.id, csvCell(r.name), csvCell(r.email), csvCell(r.phone),
        r.amount ? (r.amount / 100).toFixed(2) : '0',
        r.status || '', csvCell(r.razorpay_payment_id), csvCell(r.razorpay_order_id),
        csvCell(r.notes), csvCell(r.created_at), csvCell(r.paid_at)].join(','))
    ];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="womb-payments-${new Date().toISOString().split('T')[0]}.csv"`);
    res.send('﻿' + lines.join('\r\n'));
  });

  // ── SSR render helpers ────────────────────────────────────────────────────
  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function renderPhotos(photos) {
    if (!photos.length) return '<div class="photo-empty">Photos coming soon — check back after our next event.</div>';
    return photos.map(p =>
      `<div class="photo-item" onclick="openLightbox('${esc(p.url)}','${esc(p.caption)}')">` +
        `<img src="${esc(p.url)}" alt="${esc(p.caption || 'WOMB Circle event photo')}" loading="lazy">` +
        `<div class="photo-overlay">` +
          (p.event_tag ? `<div><span class="photo-tag">${esc(p.event_tag)}</span><br></div>` : '') +
          (p.caption   ? `<span class="photo-caption">${esc(p.caption)}</span>` : '') +
        `</div>` +
      `</div>`
    ).join('\n');
  }

  function renderVideos(videos) {
    if (!videos.length) return '<div class="video-empty">Event videos coming soon.</div>';
    return videos.map(v =>
      `<div class="video-card">` +
        `<div class="video-frame"><iframe src="${esc(v.embed_url)}" title="${esc(v.title || 'WOMB Circle event video')}" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture" allowfullscreen loading="lazy"></iframe></div>` +
        ((v.title || v.description) ?
          `<div class="video-info">` +
            (v.title       ? `<h4>${esc(v.title)}</h4>` : '') +
            (v.description ? `<p>${esc(v.description)}</p>` : '') +
          `</div>` : '') +
      `</div>`
    ).join('\n');
  }

  // ── Page routes ───────────────────────────────────────────────────────────
  app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'admin.html')));
  app.get('/womb-program', (_, res) => res.sendFile(path.join(__dirname, 'womb-program.html')));

  // Homepage — SSR injects photos & videos so Googlebot indexes real content
  app.get('/', (_, res) => {
    const photos = db.prepare('SELECT * FROM photos WHERE active=1 ORDER BY order_index ASC, id DESC').all();
    const videos = db.prepare('SELECT * FROM videos WHERE active=1 ORDER BY order_index ASC, id DESC').all();
    const html = htmlTemplate
      .replace('<!-- SSR_PHOTOS -->', renderPhotos(photos))
      .replace('<!-- SSR_VIDEOS -->', renderVideos(videos));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  });

  // ── Visitor tracking (called by client-side JS, bypass-caching safe) ───────
  app.post('/api/track', (req, res) => {
    const ua = req.headers['user-agent'] || '';
    if (!/bot|crawl|spider|slurp|googlebot|bingbot|yandex|baidu|lighthouse|headless|prerender/i.test(ua)) {
      const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
      const ref = (req.body && req.body.referrer) || req.headers['referer'] || '';
      db.prepare('INSERT INTO page_visits (ip_address, user_agent, referrer) VALUES (?, ?, ?)').run(ip, ua, ref);
    }
    res.json({ ok: true });
  });

  // ── favicon.ico (Google looks here first before the <link> tag) ───────────
  app.get('/favicon.ico', (_, res) => res.sendFile(path.join(__dirname, 'favicon.png')));

  // ── robots.txt ────────────────────────────────────────────────────────────
  app.get('/robots.txt', (_, res) => {
    res.setHeader('Content-Type', 'text/plain');
    res.send(
`User-agent: *
Allow: /
Allow: /api/events
Allow: /api/photos
Allow: /api/videos
Disallow: /admin
Disallow: /api/admin/
Disallow: /api/razorpay-webhook
Disallow: /api/webhooks/

Sitemap: ${SITE_URL}/sitemap.xml`
    );
  });

  // ── sitemap.xml ───────────────────────────────────────────────────────────
  app.get('/sitemap.xml', (_, res) => {
    const today = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'application/xml');
    res.send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>`
    );
  });

  // ── Start ─────────────────────────────────────────────────────────────────
  app.listen(PORT, () => {
    console.log(`\n✅  WOMB Circle running at http://localhost:${PORT}`);
    console.log(`   Admin panel : http://localhost:${PORT}/admin`);
    console.log(`   Default password: ${process.env.ADMIN_PASSWORD || 'admin123'}\n`);
  });
}

main().catch(err => { console.error('Startup error:', err); process.exit(1); });
