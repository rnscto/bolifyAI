FROM denoland/deno:alpine-2.5.0

# The port that your application listens to.
EXPOSE 8000

WORKDIR /app

# Copy source with correct ownership so the deno user can write the lockfile
COPY --chown=deno:deno . .

# Prefer not to run as root.
USER deno

# Cache dependencies (also regenerates deno.lock if needed)
RUN deno cache main.ts

# Run the app.
CMD ["task", "start"]
