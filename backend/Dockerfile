FROM denoland/deno:alpine-1.42.1

# The port that your application listens to.
EXPOSE 8000

WORKDIR /app

# Prefer not to run as root.
USER deno

# Cache dependencies first (requires copying the source code)
COPY . .
RUN deno cache main.ts

# Run the app.
CMD ["task", "start"]
