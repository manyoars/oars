# The pack seller. Build from the repository root:
#   docker build -f packages/pack-seller/Dockerfile -t oars-pack-seller .
# Run with OARS_SELLER_API_URL, OARS_SELLER_PORT, and OARS_SELLER_SDK_KEY_FILE (mount the key file) set.
FROM node:24-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/client/package.json packages/client/
COPY packages/pack-seller/package.json packages/pack-seller/
RUN npm ci --workspace packages/client --workspace packages/pack-seller --include-workspace-root --ignore-scripts
COPY packages/client packages/client
COPY packages/pack-seller packages/pack-seller
RUN npm run build -w packages/client && npm run build -w packages/pack-seller \
 && npm prune --omit=dev --workspace packages/client --workspace packages/pack-seller

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo/node_modules node_modules
COPY --from=build /repo/packages/client/package.json packages/client/package.json
COPY --from=build /repo/packages/client/dist packages/client/dist
COPY --from=build /repo/packages/pack-seller/package.json packages/pack-seller/package.json
COPY --from=build /repo/packages/pack-seller/dist packages/pack-seller/dist
USER node
CMD ["node", "packages/pack-seller/dist/bin.js"]
