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
FROM denoland/deno:alpine

WORKDIR /app

# The port that the unified application listens to
EXPOSE 8000

# Copy the frontend build from the previous stage
COPY --from=frontend-builder /app/dist /app/dist

# Copy backend files
COPY backend /app/backend

# Cache the Deno dependencies
# Using || true ensures that if it fails to cache (e.g. native dependency build on alpine), 
# it won't break the build and will instead cache at runtime
RUN cd /app/backend && (deno cache main.ts || true)

# Set environment variables for Deno to safely run
ENV DENO_DIR=/app/.deno

# Set permissions for Deno runtime
# We grant network access and read/write to the app directory
CMD ["deno", "run", "--config", "backend/deno.json", "--unstable-cron", "--allow-net", "--allow-read", "--allow-write", "--allow-env", "backend/main.ts"]
