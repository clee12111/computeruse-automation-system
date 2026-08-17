# Dockerfile — clean-room verification.
# Usage:
#   docker build -t cuas .
#   docker run --rm -e CONSOLE_USER=operator -e CONSOLE_PASS=demo123 cuas
#
# The container starts from ZERO: no .env, no trust entries, no build output.
# Credentials come ONLY from env vars passed at docker run time.

FROM node:20-bookworm

# curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Playwright system dependencies
RUN npx -y playwright@1.52.0 install-deps chromium

# Copy package files for layer caching
COPY package.json package-lock.json ./
RUN npm ci

# Install Chromium browser binary
RUN npx playwright install chromium

# Copy the rest of the repo (respects .dockerignore)
COPY . .

# Ensure clean state: no .env, empty trust store
RUN rm -f .env && echo '{}' > capabilities/trust.json

# Default: run the clean-room verification script
CMD ["bash", "scripts/clean-room-verify.sh"]
