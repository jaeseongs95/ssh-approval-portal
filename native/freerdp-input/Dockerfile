# TEST/Cloud only; no host installation. Keep this digest in the build manifest.
FROM ubuntu@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    build-essential cmake ninja-build pkg-config python3 ca-certificates curl git \
    libssl-dev zlib1g-dev libx11-dev libxext-dev libxinerama-dev libxcursor-dev \
    libxi-dev libxrender-dev libxrandr-dev libxfixes-dev libxkbfile-dev libjpeg-dev \
    libkrb5-dev libicu-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
ENTRYPOINT ["python3", "/repo/scripts/build-freerdp-input.py"]
