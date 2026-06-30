FROM denoland/deno:alpine-2.5.0

# The port that your application listens to.
EXPOSE 8000

WORKDIR /app

# Copy source with correct ownership
COPY --chown=deno:deno . .

# Prefer not to run as root.
USER deno

# Remove the committed lockfile so Deno 2.x can regenerate it cleanly
# (Deno 2 updates the lockfile format; the committed v5 lock causes permission errors)
RUN rm -f deno.lock && deno cache main.ts

# Run the app.
CMD ["task", "start"]
