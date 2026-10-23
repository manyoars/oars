# Build from the monorepo root, which holds the client library this template depends on:
#   docker build -f templates/per-task-agent/Dockerfile -t per-task-agent .
FROM node:24-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci --workspace templates/per-task-agent
RUN npm run build --workspace templates/per-task-agent

# The bundle carries every dependency, so the runtime image needs nothing from npm.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/templates/per-task-agent/dist/main.js dist/main.js
# The bundle is an ES module and no package.json says so here.
RUN printf '{"type":"module"}\n' > package.json
USER node
EXPOSE 8080
# Node itself is PID 1 so SIGTERM from the platform reaches the server.
CMD ["node", "dist/main.js"]
