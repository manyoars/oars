# The pack seller. Build from the repository root:
#   docker build -f packages/pack-seller/Dockerfile -t oars-pack-seller .
# The server is bundled from sources in packages/cli and packages/pool, so the build stage copies them; the run stage holds only the bundle, the production
# node_modules, and the vocabulary snapshots the pack build reads. Nothing secret is baked in: mount the SDK key file and every path folder, then run with
# OARS_SELLER_API_URL, OARS_SELLER_PORT, OARS_SELLER_SDK_KEY_FILE, and the path variables set (docs/pack-selling.md).
FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/client/package.json packages/client/
COPY packages/cli/package.json packages/cli/
COPY packages/pool/package.json packages/pool/
COPY packages/pack-seller/package.json packages/pack-seller/
RUN npm ci --workspace packages/client --workspace packages/cli --workspace packages/pack-seller --include-workspace-root --ignore-scripts
COPY packages/client packages/client
COPY packages/cli/src packages/cli/src
COPY packages/cli/vocab packages/cli/vocab
COPY packages/pool/src packages/pool/src
COPY packages/pool/scripts packages/pool/scripts
COPY packages/pack-seller packages/pack-seller
RUN npm run build -w packages/client && npm run build -w packages/pack-seller \
 && npm prune --omit=dev --ignore-scripts --workspace packages/client --workspace packages/cli --workspace packages/pack-seller

FROM node:24-slim
ENV NODE_ENV=production
ENV OARS_SELLER_HOST=0.0.0.0
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/client/package.json packages/client/package.json
COPY --from=build /repo/packages/client/dist packages/client/dist
COPY --from=build /repo/packages/cli/vocab packages/cli/vocab
COPY --from=build /repo/packages/pack-seller/package.json packages/pack-seller/package.json
COPY --from=build /repo/packages/pack-seller/dist packages/pack-seller/dist
USER node
CMD ["node", "packages/pack-seller/dist/bin.js"]
