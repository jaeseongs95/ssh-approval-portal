FROM ssh-approval-portal:docker-local-20261019-v5-amd64
USER root
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server python3 sudo && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /run/sshd && useradd --uid 10002 --create-home --shell /bin/bash mcpfixture && passwd -d mcpfixture && printf 'mcpfixture ALL=(root) NOPASSWD: ALL\n' > /etc/sudoers.d/source-linux-fixture && chmod 0440 /etc/sudoers.d/source-linux-fixture && visudo -cf /etc/sudoers.d/source-linux-fixture
COPY source/ /source/
RUN cmp /opt/portal/package-lock.json /source/package-lock.json && cp -a /opt/portal/node_modules /source/node_modules
WORKDIR /source
ENV SOURCE_LINUX_FIXTURE=synthetic-only
HEALTHCHECK NONE
CMD ["node", "--test", "--test-reporter=tap", "test/source-linux-runtime.mjs", "test/python-source.test.mjs", "test/python-source-ssh.test.mjs"]
