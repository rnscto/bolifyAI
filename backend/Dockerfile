FROM denoland/deno:alpine-2.5.0

# The port that your application listens to.
EXPOSE 8000

WORKDIR /app

# Copy source files
COPY --chown=deno:deno . .

# Fix ownership of /app directory itself (WORKDIR creates it as root)
RUN chown -R deno:deno /app

# Prefer not to run as root.
USER deno

# Cache dependencies — use --no-lock to avoid permission issues writing deno.lock
RUN deno cache --no-lock main.ts

# Run the app.
CMD ["task", "start"]
