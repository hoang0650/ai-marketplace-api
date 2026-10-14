# Base image for per-buyer SSH sandboxes. Non-root, no sudo, no docker CLI.
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git less nano vim-tiny procps openssh-sftp-server \
      python3 python3-pip python3-venv nodejs npm jq unzip \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1000 buyer && useradd -u 1000 -g 1000 -d /workspace -s /bin/bash buyer \
 && mkdir -p /workspace && chown 1000:1000 /workspace \
 && find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true
COPY motd /etc/motd
RUN printf '[ -f /etc/motd ] && cat /etc/motd\nexport PATH="$HOME/.local/bin:$PATH"\nexport npm_config_prefix="$HOME/.npm-global"\nexport PATH="$HOME/.npm-global/bin:$PATH"\n' >> /etc/bash.bashrc
USER 1000:1000
WORKDIR /workspace
CMD ["sleep", "infinity"]
