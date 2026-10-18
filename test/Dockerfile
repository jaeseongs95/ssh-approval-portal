ARG UBUNTU_VERSION=24.04
FROM ubuntu:${UBUNTU_VERSION}
ENV container=docker
ENV PATH=/opt/ssh-approval/node/bin:${PATH}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y systemd systemd-sysv openssh-server sudo curl ca-certificates python3 xz-utils util-linux git && rm -rf /var/lib/apt/lists/*
RUN systemctl mask systemd-binfmt.service
ARG HAS_BASELINE=0
ENV TEST_HAS_BASELINE=${HAS_BASELINE}
COPY candidate.tar.gz /package.tar.gz
COPY baseline.tar.gz /baseline.tar.gz
RUN mkdir /source /baseline && tar -xzf /package.tar.gz -C /source --strip-components=1 && tar -xzf /baseline.tar.gz -C /baseline --strip-components=1
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
