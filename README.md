# WOMB Circle — Setup & Run Guide

## Quick Start

### 1. Install Node.js
Download from https://nodejs.org (LTS version).

### 2. Set up environment variables
```
copy .env.example .env
```
Open `.env` and fill in your real values (Razorpay keys, Brevo API key, admin password).

### 3. Install dependencies
```
npm install
```

### 4. Start the server
```
npm start
```

The site runs at **http://localhost:3000**  
Admin panel: **http://localhost:3000/admin**

---

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Server port (default: 3000) |
| `ADMIN_PASSWORD` | Password to log in to the admin panel |
| `JWT_SECRET` | Secret key for admin JWT tokens (any long random string) |
| `RAZORPAY_KEY_ID` | From Razorpay Dashboard → Settings → API Keys |
| `RAZORPAY_KEY_SECRET` | From Razorpay Dashboard → Settings → API Keys |
| `RAZORPAY_WEBHOOK_SECRET` | From Razorpay Dashboard → Webhooks (optional but recommended) |
| `MEMBERSHIP_FEE_PAISE` | Membership fee in paise (500000 = ₹5,000) |
| `BREVO_API_KEY` | From Brevo → Settings → API Keys |
| `BREVO_SENDER_EMAIL` | Verified sender email in Brevo |
| `BREVO_SENDER_NAME` | Display name for outgoing emails |
| `BREVO_ADMIN_EMAIL` | Where admin notifications are sent |
| `SITE_URL` | Your public domain (used in email links) |

---

## Razorpay Webhook Setup

1. Go to Razorpay Dashboard → Webhooks → Add New Webhook
2. URL: `https://yourdomain.com/api/razorpay-webhook`
3. Events: check `payment.captured`
4. Copy the webhook secret to `RAZORPAY_WEBHOOK_SECRET` in `.env`

---

## Admin Panel Features

- **Dashboard** — Stats: total enquiries, paid members, revenue, pending payments
- **Enquiries** — All contact form submissions with full details
- **Payments** — All Razorpay orders with status (created / paid), amounts, IDs
- **Events** — Add/edit/delete events shown on the public website
- **Photos** — Add/remove photos in the gallery (paste image URLs from any host)
- **Videos** — Add/remove YouTube videos (paste any YouTube link — embed generated automatically)
- **Settings** — Update membership fee amount and display label

---

## Hosting

For production, use any Node.js host:
- **Render.com** (free tier available) — connect your GitHub repo
- **Railway.app** — simple deploy with env vars
- **DigitalOcean App Platform**
- **VPS** — run with `pm2 start server.js --name womb`

The SQLite database (`womb.db`) is created automatically in the project folder.  
For production, ensure the database file is on persistent storage.

---

## File Structure

```
WOMB Circle/
├── index.html      ← Public website (do not rename)
├── admin.html      ← Admin dashboard
├── server.js       ← Express backend (Node.js)
├── package.json    ← Dependencies
├── .env.example    ← Copy to .env and fill in keys
├── .env            ← Your secrets (never commit this!)
└── womb.db         ← SQLite database (auto-created on first run)
```
