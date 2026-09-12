# ECB Kalenderview

Self-hosted calendar viewer for Eissporthalle Solingen — replaces the Google Apps Script version with an independent Node.js application.

## Features

- **Public weekly calendar view** — no login required to view events
- **Editor accounts** — authenticated users can create, edit, and delete events
- **Admin panel** — manage users, categories, and events
- **Color-coded categories** — 11 pre-configured categories matching the original Google Calendar
- **Responsive design** — works on desktop and mobile
- **No Google account needed** — fully self-hosted

## Prerequisites

- [Node.js](https://nodejs.org/) 20 LTS or newer
- npm (comes with Node.js)

## Quick Start

### 1. Install dependencies

```bash
cd ECB_Kalenderview
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set a secure `JWT_SECRET`:

```
JWT_SECRET=your-random-secret-string-here
```

### 3. Create the first admin user

```bash
npm run seed
```

This creates a default admin user (`admin` / `admin123`). You can customize:

```bash
npm run seed -- --username myadmin --password mypassword --name "Max Mustermann"
```

### 4. Start the server

```bash
npm start
```

The application will be available at `http://localhost:3000`.

For development with auto-reload:

```bash
npm run dev
```

## Usage

| URL | Description |
|-----|-------------|
| `http://localhost:3000` | Public calendar view (read-only) |
| `http://localhost:3000/login.html` | Login page |
| `http://localhost:3000/admin.html` | Admin panel (requires login) |

### User Roles

| Role | Permissions |
|------|-------------|
| **Editor** | Create, edit, and delete events in every category |
| **Eismeister** | Same, but only in categories flagged `eismeister_managed` (the *Eismeister* category). Sees only the events tab |
| **Admin** | Everything editor can do + manage users + manage categories |

Categories carry two independent flags: `login_required` hides their events from
anyone who is not logged in — including all iCalendar feeds — and
`eismeister_managed` opens the category to the Eismeister role. The seeded
*Eismeister* category has both set.

## API Endpoints

### Public (no auth required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/events?start=ISO&end=ISO` | Fetch events in date range || `GET` | `/api/events/:id` | Fetch single event |
| `GET` | `/api/categories` | List all categories |
| `GET` | `/api/config` | Calendar configuration |

### Authenticated (JWT required)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/auth/login` | Login, get JWT token |
| `GET` | `/api/auth/me` | Verify token / get user info |
| `POST` | `/api/events` | Create single event |
| `PUT` | `/api/events/:id` | Update event |
| `DELETE` | `/api/events/:id` | Delete event |
| `POST` | `/api/events/series` | Create a weekly series (weekday, times, period) |
| `GET` | `/api/events/series/:id` | Series definition plus all its events |
| `PUT` | `/api/events/series/:id` | Update the whole series (title, category, times) |
| `DELETE` | `/api/events/series/:id` | Delete the series and all its events |
| `GET` | `/api/stats?start=ISO&end=ISO&category_ids=5,7,8` | Billing report: count and total duration per category |

### Serientermine

Im Termin-Formular schaltet ein Umschalter zwischen **Einzeltermin** und
**Serientermin**. Eine Serie wird über Wochentag, Start-/Endzeit und Zeitraum
definiert; eine Live-Vorschau zeigt vor dem Speichern, wie viele Termine
entstehen und wann der erste und letzte liegt.

In der Terminliste erscheint eine Serie als **eine** Zeile. Ein Klick öffnet die
Serienansicht: dort lassen sich einzelne Termine in der Uhrzeit ändern oder
löschen (die Serie bleibt bestehen), Titel/Kategorie/Uhrzeit für alle Termine
auf einmal setzen, oder die ganze Serie löschen. Termine mit abweichender
Uhrzeit werden markiert.

Angemeldete Benutzer (Editor und Admin) können Termine zusätzlich direkt im
Kalender löschen — der Lösch-Button erscheint beim Überfahren des Termins.

**Zeitzone**: Serien werden in lokaler Zeit berechnet, deshalb setzen
`Dockerfile` und `docker-compose.yml` `TZ=Europe/Berlin`. Ohne feste Zeitzone
läuft der Container in UTC und die Uhrzeiten verschieben sich.

### Kalenderansicht: Woche und Monat

Umschalter **Woche / Monat** in der Kopfleiste; die Wahl bleibt über einen Reload
erhalten. Die Pfeile springen in der Einheit der jeweiligen Ansicht (eine Woche
bzw. einen Monat), ergänzt um ein Datumsfeld für den Direktsprung und — in der
Wochenansicht — Knöpfe für ±1 Monat.

Die Monatsansicht zeigt immer sechs Wochen (stabile Höhe beim Blättern) mit bis
zu drei Terminen je Tag, darüber hinaus „+N weitere". Daneben steht ein
Tagespanel mit Stundenraster für den gewählten Tag — es startet auf heute,
folgt einem Klick auf eine Tageszelle und scrollt beim Öffnen auf die aktuelle
Uhrzeit. Auf schmalen Bildschirmen rutscht es unter das Monatsraster.

### Billing report

The **Abrechnung** tab in the admin panel reports, for a chosen period and set of
categories, how many events occurred and their total duration — replacing the
former Google Apps Script tool.

Categories carry a `group_by_title` flag ("Nach Titel aufschlüsseln" in the
category form). When set, that category is additionally broken down by event
title; otherwise all its events are summed into a single line. Defaults:
enabled for *Hobbies*, disabled for *Vermietung*. Results can be exported as CSV
(semicolon-separated, UTF-8 BOM — opens directly in German Excel).

### Admin only

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/users` | List users |
| `POST` | `/api/users` | Create user |
| `PUT` | `/api/users/:id` | Update user |
| `DELETE` | `/api/users/:id` | Delete user |
| `POST` | `/api/categories` | Create category |
| `PUT` | `/api/categories/:id` | Update category |
| `DELETE` | `/api/categories/:id` | Delete category |

## Testing

```bash
npm test
```

## Docker Deployment

### Build and run

```bash
docker build -t ecb-kalender .
docker run -d -p 3000:3000 \
  -v ecb-data:/app/data \
  -e JWT_SECRET=your-secret-here \
  ecb-kalender
```

### Then seed the admin user

```bash
docker exec -it <container-id> node server/seed.js
```

## Deployment on Render.com (Free)

1. Push code to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Connect your GitHub repository
4. Set build command: `npm install`
5. Set start command: `node server/index.js`
6. Add environment variables:
   - `JWT_SECRET` — random secret string
   - `CALENDAR_NAME` — your calendar name
7. Add a **Persistent Disk** mounted at `/app/data` for the SQLite database
8. Deploy

## Project Structure

```
ECB_Kalenderview/
├── server/
│   ├── index.js              # Express app entry point
│   ├── config.js             # Configuration from environment
│   ├── database.js           # SQLite setup + migrations + seed
│   ├── datetime.js           # Local-time helpers for weekly series
│   ├── seed.js               # Create initial admin user
│   ├── middleware/
│   │   └── auth.js           # JWT verification middleware
│   └── routes/
│       ├── auth.js           # Login / verify token
│       ├── events.js         # CRUD events + series
│       ├── categories.js     # CRUD categories
│       ├── stats.js          # Billing report
│       └── users.js          # CRUD users (admin)
├── public/
│   ├── index.html            # Public calendar view
│   ├── login.html            # Login page
│   ├── admin.html            # Admin panel
│   ├── css/
│   │   ├── calendar.css      # Calendar styles
│   │   └── admin.css         # Admin panel styles
│   └── js/
│       ├── api.js            # Fetch wrapper
│       ├── calendar.js       # Calendar rendering
│       └── admin.js          # Admin panel logic
├── tests/
│   ├── auth.test.js
│   ├── events.test.js
│   └── categories.test.js
├── data/                     # SQLite database (gitignored)
├── package.json
├── Dockerfile
├── .env.example
└── .gitignore
```

## License

MIT
