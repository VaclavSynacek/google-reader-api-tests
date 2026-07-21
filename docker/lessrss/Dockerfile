FROM node:latest

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --depth=1 https://github.com/VaclavSynacek/lessRss.git /app

WORKDIR /app
RUN npm ci

ENV LESSRSS_STORAGE=fs \
    HOST=0.0.0.0 \
    GREADER_USER=alice \
    GREADER_PASSWORD=aliceapi \
    LESSRSS_AUTH_SECRET=contract-test-secret

EXPOSE 3000
CMD ["node", "src/local-server.js"]
