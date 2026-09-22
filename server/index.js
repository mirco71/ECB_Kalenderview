const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { dbReady } = require('./database');

const app = express();

// Trust exactly one proxy hop (the Cloudflare tunnel in front of the container),
// so req.ip is the client IP instead of the tunnel's. Without it every request
// shares one IP and the login rate limit locks out all users at once.
app.set('trust proxy', 1);

// ============ MIDDLEWARE ============

// Security headers.
// - No 'unsafe-inline' in script-src: inline <script> blocks are blocked, which
//   removes the main stored-XSS execution vector. All page scripts are external.
// - script-src-attr keeps 'unsafe-inline' for the static onclick= handlers in the
//   HTML; combined with strict output-escaping there is no HTML-injection path to
//   abuse them.
// - style-src keeps 'unsafe-inline' because the calendar positions events via
//   inline style="" attributes.
// - upgrade-insecure-requests disabled so CSS/JS load over plain HTTP (Portainer
//   test via LAN-IP:Port); behind an HTTPS reverse proxy this is a no-op.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        upgradeInsecureRequests: null,
      },
    },
  })
);

// CORS is opt-in: the bundled frontend is same-origin and needs no CORS headers.
// Only enable (with a specific allowed origin) when a separate origin must call
// the API — never a wildcard.
if (config.corsOrigin) {
  app.use(cors({ origin: config.corsOrigin }));
}
app.use(express.json());

// Rate limit on auth endpoints.
// Keyed on CF-Connecting-IP: Cloudflare sets it to exactly one client IP, whereas
// the X-Forwarded-For chain through cloudflared can come out wrong when the
// original request already carried the header. Falls back to req.ip without the
// tunnel (local dev, tests).
// Caveat: a client reaching the published container port directly bypasses
// Cloudflare and can forge this header as well — only closing that port fixes it.
// Only failed requests count: successful logins and the /me check on every page
// load must not lock out legitimate users; guessing passwords still hits the limit.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 failed attempts per window
  skipSuccessfulRequests: true,
  keyGenerator: req => req.get('CF-Connecting-IP') || req.ip,
  message: { error: 'Zu viele Anmeldeversuche. Bitte versuchen Sie es später erneut.' },
});

// ============ ROUTES ============

// API routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/events', require('./routes/events'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/users', require('./routes/users'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api/sync', require('./routes/sync'));
app.use('/api/sync-tokens', require('./routes/syncTokens'));

// Öffentliche iCalendar-Feeds. Ohne /api-Präfix, weil die URL in
// Kalender-Apps von Hand eingetragen wird und kurz bleiben soll. Muss vor
// express.static und dem SPA-Fallback stehen, sonst fängt einer der beiden
// die .ics-Pfade ab.
app.use('/feeds', require('./routes/feeds'));

// Config endpoint (public, returns calendar settings)
app.get('/api/config', (req, res) => {
  res.json({
    calendarName: config.calendarName,
    startHour: config.startHour,
    endHour: config.endHour,
  });
});

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// SPA fallback — serve index.html for non-API routes
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API-Endpunkt nicht gefunden' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ============ ERROR HANDLER ============

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Interner Serverfehler' });
});

// ============ START ============

async function start() {
  // Wait for database to be ready before accepting requests
  await dbReady;
  console.log('✅ Database initialized');

  if (require.main === module) {
    app.listen(config.port, () => {
      console.log(`🚀 ECB Kalenderview läuft auf http://localhost:${config.port}`);
      console.log(`   Umgebung: ${config.nodeEnv}`);
      console.log(`   Datenbank: ${config.dbPath}`);
    });
  }
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

module.exports = app;
