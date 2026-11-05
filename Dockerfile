# Build the static React frontend once, then copy only the compiled assets
# into the runtime image. The Express server serves both the UI and API.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci
COPY frontend ./frontend
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}" \
    PYTHON_PATH=/opt/venv/bin/python \
    YTDLP_PATH=/opt/venv/bin/yt-dlp \
    GALLERYDL_PATH=/opt/venv/bin/gallery-dl \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    MAX_CONCURRENT_JOBS=1 \
    MAX_MEDIA_MB=50

WORKDIR /app
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY package.json package-lock.json ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
RUN npm ci --omit=dev --workspace=backend --include-workspace-root=false \
    && npm cache clean --force

COPY --chown=node:node backend ./backend
COPY --from=frontend-build --chown=node:node /app/frontend/dist ./frontend/dist
USER node
EXPOSE 10000
CMD ["node", "backend/src/server.js"]
