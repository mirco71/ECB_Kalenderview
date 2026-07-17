FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --production

# Copy application code
COPY server/ ./server/
COPY public/ ./public/

# Create data directory for SQLite
RUN mkdir -p /app/data

# Set environment defaults
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/app/data/calendar.db

# Expose port
EXPOSE 3000

# Persistent volume for database
VOLUME /app/data

# Start the application
CMD ["node", "server/index.js"]
