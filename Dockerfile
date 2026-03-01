# -----------------------------------------------
FROM node:25 AS os_deps

RUN dpkg --add-architecture i386 \
    && apt update \
    && apt install -y --no-install-recommends \
        p7zip-full fuse wine wine32 build-essential \
    && apt clean \
    && rm -rf /var/lib/apt/lists/*

# -----------------------------------------------
FROM os_deps AS deps

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

# Rebuild native addon now that the native/ dir is present
RUN --mount=type=cache,target=/root/.cache/electron \
    --mount=type=cache,target=/root/.cache/electron-builder \
    npm run rebuild:native

RUN --mount=type=cache,target=/root/.npm \
    --mount=type=cache,target=/root/.cache/electron \
    --mount=type=cache,target=/root/.cache/electron-builder \
    npm run build
