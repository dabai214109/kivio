FROM node:20-alpine
WORKDIR /app
COPY server/package.json ./
RUN npm install --omit=dev
COPY server/relay.mjs ./
COPY server/public ./public
ENV PORT=8787 DATA_FILE=/data/data.json
VOLUME /data
EXPOSE 8787
CMD ["node", "relay.mjs"]
