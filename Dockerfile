FROM node:24-slim

RUN npm install -g pnpm@12.11.2
WORKDIR /app

# Install dependencies first so this layer is cached until the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

COPY packages ./packages
RUN pnpm build

# Votes and cached lookups live in a SQLite file. Mount a volume at /data to keep them across restarts.
ENV HOST=0.0.0.0 PORT=8787 DB_PATH=/data/aid.sqlite TRUST_PROXY=1 NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["pnpm", "--filter", "@aid/server", "start"]
