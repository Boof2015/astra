# -----------------------------------------------
FROM node:25 AS deps

RUN dpkg --add-architecture i386 \
    && apt update \
    && apt install -y --no-install-recommends \
        p7zip-full fuse wine wine32 build-essential \
    && apt clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./

RUN --mount=type=cache,target=/root/.npm \
    npm config set loglevel info \
    && npm install

# -----------------------------------------------
FROM deps AS builder

COPY --from=deps /app /app
COPY . .

ENV DEBUG=electron-builder
ENV ELECTRON_CACHE=/root/.cache/electron
ENV ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder
RUN --mount=type=cache,target=/root/.npm \
    npm run build
