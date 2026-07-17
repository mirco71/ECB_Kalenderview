const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { dbReady } = require('./database');

const app = express();

// ============ MIDDLEWARE ============

// Security headers (relaxed CSP for inline styles/scripts in calendar)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        // Ausschalten: sonst zwingt Helmet den Browser, alle Ressourcen auf
        // HTTPS hochzustufen. Beim Betrieb hinter HTTP (z. B. Portainer-Test
        // über LAN-IP:Port) bricht dann das Laden von CSS/JS mit SSL-Fehler.
        upgradeInsecureRequests: null,
      },
    },
  })
);

app.use(cors());
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
