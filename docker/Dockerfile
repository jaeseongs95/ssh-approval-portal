FROM ubuntu:24.04 AS build
ARG TARGETARCH
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl xz-utils libstdc++6 && rm -rf /var/lib/apt/lists/*
RUN architecture="$TARGETARCH"; [ "$architecture" != amd64 ] || architecture=x64; \
    curl -fsS --proto '=https' "https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-$architecture.tar.xz" -o /node.tar.xz && \
    curl -fsS --proto '=https' https://nodejs.org/dist/v24.21.0/SHASUMS256.txt -o /SHASUMS256.txt && \
    cd / && grep "  node-v24.21.0-linux-$architecture.tar.xz\$" SHASUMS256.txt | sed 's|  node-.*|  node.tar.xz|' | sha256sum -c - && \
    mkdir /runtime && tar -xJf /node.tar.xz -C /runtime --strip-components=1
ENV PATH=/runtime/bin:${PATH}
COPY dist/ssh-approval-portal-0.3.0.tar.gz /package.tar.gz
RUN mkdir /app && tar -xzf /package.tar.gz -C /app --strip-components=1 && cd /app && node scripts/verify.mjs . && npm ci --omit=dev --ignore-scripts

FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=build /runtime/bin/node /usr/local/bin/node
COPY --from=build /runtime/LICENSE /usr/share/licenses/node/LICENSE
COPY --from=build /app /opt/portal
WORKDIR /opt/portal
ENV HOME=/var/lib/ssh-mcp
USER 10001:10001
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:39124/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "bridge.mjs"]
