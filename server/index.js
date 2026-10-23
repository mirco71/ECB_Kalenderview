const express = require('express');
const path = require('path');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const { dbReady } = require('./database');
const { loadVersionedPages } = require('./assets');

const app = express();

// Trust exactly one proxy hop (the Cloudflare tunnel in front of the container),
// so req.ip is the client IP instead of the tunnel's. Without it every request
// shares one IP and the login rate limit locks out all users at once.
app.set('trust proxy', 1);

// ============ MIDDLEWARE ============

// Security headers.
// - No 'unsafe-inline' in script-src: inline <script> blocks are blocked, which
//   removes the main stored-XSS execution vector. All page scripts are external.
// - script-src-attr is 'none': inline event-handler attributes (onclick= etc.) are
//   blocked as well. The frontend registers all handlers via addEventListener
//   (data-action attributes), so injected markup cannot execute script through
//   an attribute either.
// - style-src is 'self' only: no <style> blocks, all stylesheets are files under
//   /css. style-src-attr keeps 'unsafe-inline' because the calendar positions
//   events via inline style="" attributes (values are computed client-side; the
//   category colour comes from the database and is validated server-side).
//   Attributes cannot load code, so this is far less exposed than a <style> block.
// - font-src 'self': no external fonts.
// - upgrade-insecure-requests only with config.secureTransport, so plain-HTTP
//   setups (Portainer test via LAN-IP:Port) still load CSS/JS; behind HTTPS
//   it makes the browser upgrade sub-resource requests.
// - Violations are reported to POST /api/csp-report (report-uri for older
//   browsers, report-to + Reporting-Endpoints for current ones).
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'"],
        styleSrcAttr: ["'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        upgradeInsecureRequests: config.secureTransport ? [] : null,
        reportUri: ['/api/csp-report'],
        reportTo: ['csp'],
      },
    },
  })
);

// Reporting API endpoint name referenced by the CSP's report-to directive, and
// a Permissions-Policy that switches off powerful features the app never uses.
app.use((req, res, next) => {
  res.setHeader('Reporting-Endpoints', 'csp="/api/csp-report"');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
  );
  next();
});

// API responses carry session-dependent and non-public data: never cache them
// in browsers or intermediate proxies.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// CORS is opt-in: the bundled frontend is same-origin and needs no CORS headers.
// Only enable (with a specific allowed origin) when a separate origin must call
// the API — never a wildcard.
if (config.corsOrigin) {
  app.use(cors({ origin: config.corsOrigin }));
}

// CSP violation reports. Must be mounted before the global express.json() below:
// that parser would otherwise consume application/json bodies first, with the
// larger default limit. Reports are unauthenticated by nature (the browser sends
// them), so: small body limit, own rate limit, log only, nothing in the audit log.
const cspReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: req => req.get('CF-Connecting-IP') || req.ip,
  message: { error: 'Zu viele Anfragen.' },
});
app.post(
  '/api/csp-report',
  cspReportLimiter,
  express.json({
    type: ['application/csp-report', 'application/reports+json', 'application/json'],
    limit: '10kb',
  }),
  (req, res) => {
    console.warn('CSP report:', JSON.stringify(req.body || {}).slice(0, 500));
    res.status(204).end();
  },
  // Oversized or malformed report bodies: answer with the parser's status
  // (413/400) instead of falling through to the 500 handler.
  (err, req, res, next) => {
    res.status(err.status >= 400 && err.status < 500 ? err.status : 500).end();
  }
);

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
app.use('/api/audit', require('./routes/audit'));

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

// Public contact for vulnerability reports (RFC 9116). Only served when
// SECURITY_CONTACT is set; read per request so it can be switched via env.
app.get('/.well-known/security.txt', (req, res) => {
  const contact = process.env.SECURITY_CONTACT;
  if (!contact) return res.status(404).type('text/plain').send('Nicht gefunden');
  const expires = new Date();
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  res
    .type('text/plain')
    .send(
      `Contact: ${contact}
Expires: ${expires.toISOString()}
Preferred-Languages: de, en
`
    );
});

// Keep the login and admin pages out of search indexes.
app.use(['/login.html', '/admin.html'], (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// HTML pages with versioned JS/CSS references (?v=<hash of the assets>), read once
// at start. Cloudflare caches JS for 4h; without the version a browser can keep
// running an outdated api.js against a newer server. The HTML itself is
// no-cache so the new references are picked up immediately. Must stay before
// express.static (which would serve the unversioned files) and after the
// X-Robots-Tag middleware above.
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const { pages: htmlPages } = loadVersionedPages(PUBLIC_DIR);
function sendPage(res, name) {
  res
    .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    .send(htmlPages[name]);
}
app.get(['/', '/index.html'], (req, res) => sendPage(res, 'index.html'));
app.get('/login.html', (req, res) => sendPage(res, 'login.html'));
app.get('/admin.html', (req, res) => sendPage(res, 'admin.html'));

// Static files
app.use(express.static(PUBLIC_DIR));

// SPA fallback — index.html only for extension-less GET paths (client-side
// routes). Anything that looks like a file but was not found by express.static
// is a plain 404, so scanners probing /x.php or /favicon.ico don't get a 200 page.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API-Endpunkt nicht gefunden' });
  }
  const lastSegment = req.path.split('/').pop();
  if (lastSegment.includes('.')) {
    return res.status(404).type('text/plain').send('Nicht gefunden');
  }
  sendPage(res, 'index.html');
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
