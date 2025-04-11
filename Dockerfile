FROM node:20-alpine

WORKDIR /app

# Install dependencies
RUN npm install -g pnpm typescript

# Copy package files for dependency installation
COPY . ./

# Install dependencies (production mode)
RUN pnpm install

# Build TypeScript files
RUN pnpm run build

# Create a simple health check file
COPY <<'EOF' /app/health.js
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('OK'));
app.listen(8080, () => console.log('Health check server running on port 8080'));
EOF

# Create the startup script
COPY <<'EOF' /app/start.sh
#!/bin/sh

# Start the HTTP health check server
node /app/health.js &

# Wait for API keys to be set
while [ -z "$PLAYHT_API_KEY" ] || [ -z "$PLAYHT_USER_ID" ] || [ "$PLAYHT_API_KEY" = "YOUR_API_KEY" ] || [ "$PLAYHT_USER_ID" = "YOUR_USER_ID" ]; do
  echo "Waiting for valid PlayHT API keys..."
  sleep 10
done

# Run the TTS tests
cd /app && NODE_ENV=production pnpm test:tts
EOF

# Make the script executable
RUN chmod +x /app/start.sh

# Expose the port
EXPOSE 8080

# Start the app with our custom script
CMD ["/app/start.sh"] 