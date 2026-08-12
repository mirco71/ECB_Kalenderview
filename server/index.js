const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { dbReady } = require('./database');

const app = express();

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

// Rate limit on auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
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
