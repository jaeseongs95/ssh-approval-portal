FROM ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY dist/ssh-approval-portal-0.3.0.tar.gz /package.tar.gz
RUN mkdir /source && tar -xzf /package.tar.gz -C /source --strip-components=1
WORKDIR /source
CMD ["bash", "test/compose-driver.sh"]
