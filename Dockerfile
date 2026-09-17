# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# /data haelt die Matter-Fabric-Daten (Kopplung!), die Zaehlerstaende und die
# Liste der von den Quellen angelegten Zaehler, /config die meters.json.
ENV VPM_STORAGE=/data \
    VPM_CONFIG=/config/meters.json \
    VPM_API_HOST=0.0.0.0 \
    VPM_API_PORT=8080
VOLUME ["/data"]

# 5540/udp: Matter. 5353/udp: mDNS. 8080/tcp: HTTP-API.
# Im Host-Netzwerkmodus (Pflicht fuer Matter) ist EXPOSE nur Dokumentation.
EXPOSE 5540/udp 5353/udp 8080/tcp

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.VPM_API_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
