# Build from the monorepo root, which holds the client library this template depends on:
#   docker build -f templates/paid-api/Dockerfile -t paid-api .
FROM node:24-slim AS build
WORKDIR /repo
COPY . .
RUN npm ci --workspace packages/client --workspace templates/paid-api
RUN npm run build --workspace packages/client
RUN npm run build --workspace templates/paid-api

# The bundle carries every dependency, so the runtime image needs nothing from npm.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/templates/paid-api/dist/main.js dist/main.js
# GET /recover serves this page, read from public/ next to dist/.
COPY --from=build /repo/templates/paid-api/public public
# The bundle is an ES module and no package.json says so here.
RUN printf '{"type":"module"}\n' > package.json
USER node
EXPOSE 8080
# Node itself is PID 1 so SIGTERM from the platform reaches the server.
CMD ["node", "dist/main.js"]
