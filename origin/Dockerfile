FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false \
    && npm cache clean --force

COPY --chown=node:node src ./src

USER node
EXPOSE 8086

CMD ["node", "src/index.js"]
