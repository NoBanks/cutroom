FROM node:22-bookworm-slim

# melt (MLT) renders the Shotcut timeline; ffmpeg probes footage and builds contact sheets.
RUN apt-get update && apt-get install -y --no-install-recommends \
      melt ffmpeg python3 python3-venv git ca-certificates fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

# shotcut-mcp: the MCP server the Assistant Editor drives.
ARG SHOTCUT_MCP_REF=fix/stateful-timeline
RUN python3 -m venv /opt/shotcut-venv \
    && /opt/shotcut-venv/bin/pip install --no-cache-dir "git+https://github.com/NoBanks/shotcut-mcp.git@${SHOTCUT_MCP_REF}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .

ENV SHOTCUT_MCP_CMD=/opt/shotcut-venv/bin/shotcut-mcp \
    CUTROOM_DATA=/data/sessions \
    CUTROOM_LEDGER=/data/spend-ledger.json \
    PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "server.js"]
