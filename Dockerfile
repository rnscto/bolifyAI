# ==========================================
# STAGE 1: Build the React Frontend (Vite)
# ==========================================
FROM node:20-alpine AS frontend-builder

WORKDIR /app
COPY package*.json ./
RUN npm install

# Copy all frontend source files
COPY . .

# Build the frontend into the /app/dist folder
RUN npm run build

# ==========================================
# STAGE 2: Run the Deno Backend API + Frontend
# ==========================================
FROM denoland/deno:alpine-2.5.0

WORKDIR /app

# The port that the unified application listens to
EXPOSE 8000

# Copy the frontend build from the previous stage
COPY --chown=deno:deno --from=frontend-builder /app/dist /app/dist

# Copy backend files into /app
COPY --chown=deno:deno backend /app

# Fix ownership of /app directory itself
RUN chown -R deno:deno /app

# Prefer not to run as root
USER deno

# Cache the Deno dependencies — use --no-lock to avoid lockfile permission issues
RUN deno cache --no-lock main.ts

# Run the unified application
CMD ["task", "start"]

