FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_FILE=/data/support-translator.json
COPY package*.json ./
RUN npm ci --omit=dev
COPY bin ./bin
COPY src ./src
COPY examples ./examples
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health || exit 1
# Webhook mode. For long polling (no public URL) use: CMD ["node", "bin/support-translator.js", "serve", "--poll"]
CMD ["node", "bin/support-translator.js", "serve"]
