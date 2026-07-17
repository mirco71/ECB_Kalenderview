require('dotenv').config();

module.exports = {
  port: parseInt(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  dbPath: process.env.DB_PATH || './data/calendar.db',
  calendarName: process.env.CALENDAR_NAME || 'Kalender',
  startHour: parseInt(process.env.START_HOUR) || 6,
  endHour: parseInt(process.env.END_HOUR) || 23,
  nodeEnv: process.env.NODE_ENV || 'development',
};
