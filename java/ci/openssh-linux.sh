#!/bin/sh
# Prepares a real OpenSSH server on a one-shot GitHub Linux runner for the Gradle task :portal-ssh:realOpenSshTest (stage 3 design 7.3, decision D3-11).
#
# Why this is a shell script and not Java: creating an operating system account, writing a sudoers rule and starting an sshd are operating system administration.
# The JDK has no API for any of them, and the product has no business doing them, so the job that prepares the test environment does it (the same category as the
# install scripts that register an OS service; see docs/external-programs.en.md). The tests that talk to the server are Java (JUnit, Apache MINA SSHD client).
#
# What it does, as the runner user with sudo:
#   1. a throw-away account (portalci + 6 hex digits) whose password is locked, so only the key can log in;
#   2. an ed25519 client key pair and an ed25519 host key, both in $RUNNER_TEMP/portal-openssh-ci (mode 700 directory, nothing is printed);
#   3. authorized_keys for the account, and a sudoers rule that lets the account run the OpenSSH sftp-server (and true, cat, tee, mv) without a password:
#      this is what the elevate tests need (sudo -n sftp-server over an exec channel, stage 3 design 6.1, pilot P3-4);
#   4. a second sshd on a random loopback port with its own configuration; the system sshd, if any, is not touched;
#   5. a known_hosts file that holds only the host public key of that sshd (host key checking stays on in the tests).
# It then writes the connection values (no secret: the key is named by its path) to $GITHUB_ENV for the next workflow step:
#   PORTAL_OPENSSH_PORT, PORTAL_OPENSSH_USER, PORTAL_OPENSSH_KEY_FILE, PORTAL_OPENSSH_KNOWN_HOSTS
#
# Usage: openssh-linux.sh          prepare (default)
#        openssh-linux.sh stop     stop the sshd and remove the account and the sudoers rule (the workflow calls it with if: always())
# It refuses to run outside a GitHub Linux runner: it creates a user and a sudoers file, which nobody wants on a development machine.
set -eu

if [ "${GITHUB_ACTIONS:-}" != "true" ] || [ "${RUNNER_OS:-}" != "Linux" ]; then
    echo "openssh-linux.sh runs only on a one-shot GitHub Linux runner." >&2
    exit 1
fi

FIX="${RUNNER_TEMP:?RUNNER_TEMP is not set}/portal-openssh-ci"

if [ "${1:-}" = "stop" ]; then
    # Best effort: the runner is thrown away anyway, so a failure here must not hide the result of the tests.
    if [ -f "$FIX/sshd.pid" ]; then sudo kill "$(cat "$FIX/sshd.pid")" 2>/dev/null || true; fi
    if [ -f "$FIX/user" ]; then
        CI_USER="$(cat "$FIX/user")"
        sudo rm -f "/etc/sudoers.d/portal-openssh-ci-$CI_USER"
        sudo userdel -r "$CI_USER" 2>/dev/null || true
    fi
    exit 0
fi

# 1. sshd and sftp-server. The GitHub image has the OpenSSH client; install the server when it is missing.
if [ ! -x /usr/sbin/sshd ]; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server
fi
SFTP_SERVER=""
for candidate in /usr/lib/openssh/sftp-server /usr/libexec/openssh/sftp-server /usr/lib/ssh/sftp-server /usr/libexec/sftp-server; do
    if [ -x "$candidate" ]; then SFTP_SERVER="$candidate"; break; fi
done
if [ -z "$SFTP_SERVER" ]; then
    echo "No sftp-server binary found next to the OpenSSH server." >&2
    exit 1
fi

mkdir -p "$FIX"
chmod 700 "$FIX"

# 2. The account. Password "*" is not a valid hash, so password login is impossible, but the account is not locked and public key login works.
CI_USER="portalci$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
sudo useradd -m -s /bin/bash "$CI_USER"
sudo usermod -p '*' "$CI_USER"
printf '%s\n' "$CI_USER" > "$FIX/user"

# 3. Keys. The client key stays with the runner user (the Java test reads it); the host key belongs to root, as sshd wants.
ssh-keygen -q -t ed25519 -N '' -f "$FIX/client_key"
ssh-keygen -q -t ed25519 -N '' -f "$FIX/host_key"
sudo chown root:root "$FIX/host_key"
sudo chmod 600 "$FIX/host_key"
sudo install -d -m 700 -o "$CI_USER" -g "$CI_USER" "/home/$CI_USER/.ssh"
sudo install -m 600 -o "$CI_USER" -g "$CI_USER" "$FIX/client_key.pub" "/home/$CI_USER/.ssh/authorized_keys"

# 4. sudoers: the OpenSSH sftp-server plus the few fixed commands of the exec fallback for elevated file transfer. Nothing else.
RULE_COMMANDS="$SFTP_SERVER"
for tool in true cat tee mv; do
    # Absolute paths only: sudoers matches a command by its path, and "command -v true" would name the shell builtin.
    tool_path=""
    for dir in /usr/bin /bin; do
        if [ -x "$dir/$tool" ]; then tool_path="$dir/$tool"; break; fi
    done
    if [ -z "$tool_path" ]; then
        echo "No $tool binary found for the sudoers rule." >&2
        exit 1
    fi
    RULE_COMMANDS="$RULE_COMMANDS, $tool_path"
done
printf '%s ALL=(root) NOPASSWD: %s\n' "$CI_USER" "$RULE_COMMANDS" > "$FIX/sudoers"
sudo visudo -cf "$FIX/sudoers" > /dev/null
sudo install -m 440 -o root -g root "$FIX/sudoers" "/etc/sudoers.d/portal-openssh-ci-$CI_USER"

# 5. A random loopback port that nothing listens on yet.
PORT=""
attempt=0
while [ "$attempt" -lt 50 ]; do
    candidate=$((20000 + $(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % 30000))
    if [ -z "$(ss -ltnH "sport = :$candidate")" ]; then PORT="$candidate"; break; fi
    attempt=$((attempt + 1))
done
if [ -z "$PORT" ]; then
    echo "No free loopback port found." >&2
    exit 1
fi

# 6. The sshd of this test: its own configuration, host key and pid file. LogLevel VERBOSE keeps the log useful without command text.
cat > "$FIX/sshd_config" <<EOF
Port $PORT
ListenAddress 127.0.0.1
HostKey $FIX/host_key
PidFile $FIX/sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PermitRootLogin no
AllowUsers $CI_USER
StrictModes yes
UsePAM yes
Subsystem sftp $SFTP_SERVER
LogLevel VERBOSE
EOF
sudo mkdir -p /run/sshd
sudo /usr/sbin/sshd -t -f "$FIX/sshd_config"
sudo /usr/sbin/sshd -f "$FIX/sshd_config" -E "$FIX/sshd.log"

# 7. known_hosts: the two fields of the host public key (without its comment), for exactly this host and port.
awk -v port="$PORT" '{ printf "[127.0.0.1]:%s %s %s\n", port, $1, $2 }' "$FIX/host_key.pub" > "$FIX/known_hosts"

# 8. Wait until a login with the key works, and check that the sudo rule is in force: sudo -n true must succeed for this account.
attempt=0
until ssh -p "$PORT" -i "$FIX/client_key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$FIX/known_hosts" \
        "$CI_USER@127.0.0.1" "sudo -n true" > /dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 30 ]; then
        echo "The prepared sshd does not accept the test account (port $PORT). Last lines of its log:" >&2
        tail -n 20 "$FIX/sshd.log" >&2 || true
        exit 1
    fi
    sleep 1
done

{
    printf 'PORTAL_OPENSSH_PORT=%s\n' "$PORT"
    printf 'PORTAL_OPENSSH_USER=%s\n' "$CI_USER"
    printf 'PORTAL_OPENSSH_KEY_FILE=%s\n' "$FIX/client_key"
    printf 'PORTAL_OPENSSH_KNOWN_HOSTS=%s\n' "$FIX/known_hosts"
} >> "${GITHUB_ENV:?GITHUB_ENV is not set}"
echo "Real OpenSSH server ready on 127.0.0.1:$PORT for account $CI_USER (sftp-server: $SFTP_SERVER)."
