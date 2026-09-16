FROM node:24-alpine
ENV NODE_ENV=production TZ=Europe/Warsaw
RUN apk add --no-cache tzdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN rm -f src/*.test.ts && mkdir -p /data && chown node:node /data
USER node
ENV DB_PATH=/data/kalendarz.sqlite PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["npm", "start"]
