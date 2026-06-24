#!/bin/bash

# Start Deno server in the background
echo "Starting BolifyAI Deno API..."
cd backend
deno task start &
DENO_PID=$!

echo "Deno API is running with PID: $DENO_PID"
echo "Starting localtunnel on port 8000..."

# Start localtunnel (no account required)
npx localtunnel --port 8000

# Cleanup on exit
trap "kill $DENO_PID; exit" INT TERM
