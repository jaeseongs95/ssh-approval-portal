FROM hashicorp/vault:2.0.3@sha256:a296a888b118615dc01d5f1a6846e6d4a7277946caaed5b447008fff5fe06b54 AS vault
FROM node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl python3 git && rm -rf /var/lib/apt/lists/*
COPY --from=vault /bin/vault /usr/local/bin/vault
COPY candidate.tar.gz baseline.tar.gz /archives/
RUN mkdir /candidate /baseline && tar -xzf /archives/candidate.tar.gz -C /candidate --strip-components=1 && tar -xzf /archives/baseline.tar.gz -C /baseline --strip-components=1 \
 && cd /candidate && npm ci --omit=dev --ignore-scripts \
 && cd /baseline && npm ci --omit=dev --ignore-scripts
USER node
WORKDIR /candidate
ENV TZ=UTC GOMAXPROCS=2
CMD ["sleep", "infinity"]
