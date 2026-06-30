FROM denoland/deno:alpine-2.5.0

# The port that your application listens to.
EXPOSE 8000

WORKDIR /app

# Copy source with correct ownership
COPY --chown=deno:deno . .

# Prefer not to run as root.
USER deno

# Cache dependencies (deno.lock is excluded via .dockerignore so Deno creates it fresh)
RUN deno cache main.ts

# Run the app.
CMD ["task", "start"]
