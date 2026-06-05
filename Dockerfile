# Daisan Agent service — runs the Claude Agent SDK as a web service.
# Full node:20 (not slim) for maximum compatibility with the bundled Claude Code binary;
# it also already includes git, which the agent may shell out to.
FROM node:20

WORKDIR /app

# Install deps with a FRESH, platform-correct resolution so Linux pulls the right
# @anthropic-ai/claude-agent-sdk-linux-x64 binary (not the Windows one a committed
# package-lock.json would pin).
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# No `ENV PORT` — Render injects PORT at runtime and the server reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 8787

CMD ["node", "server.mjs"]
