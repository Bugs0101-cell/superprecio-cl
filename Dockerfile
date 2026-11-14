FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=3456
ENV DATA_DIR=/data

EXPOSE 3456

CMD ["node", "src/server.mjs"]
