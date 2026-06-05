# Daisan Agent service — runs the Claude Agent SDK as a web service.
FROM node:20-slim

# Claude Code (the SDK's engine) may shell out to git/bash; include them + CA certs.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching). The agent SDK pulls its linux-x64 binary here.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["node", "server.mjs"]
