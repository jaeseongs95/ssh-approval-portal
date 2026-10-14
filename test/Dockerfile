ARG UBUNTU_VERSION=24.04
FROM ubuntu:${UBUNTU_VERSION}
ENV container=docker
ENV PATH=/opt/ssh-approval/node/bin:${PATH}
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y systemd systemd-sysv openssh-server sudo curl ca-certificates python3 xz-utils util-linux && rm -rf /var/lib/apt/lists/*
RUN systemctl mask systemd-binfmt.service
COPY dist/ssh-approval-portal-0.3.0.tar.gz /package.tar.gz
RUN mkdir /source && tar -xzf /package.tar.gz -C /source --strip-components=1
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
