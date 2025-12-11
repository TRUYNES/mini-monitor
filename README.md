# Mini Monitor

A lightweight, real-time Docker container monitoring dashboard.

## Features
- Real-time CPU, Memory, and Network usage.
- Beautiful, responsive dark mode UI.
- Built with Node.js, Socket.io, and Chart.js.
- Single container deployment.

## Deployment with Dockge

1. Open your Dockge dashboard.
2. Click **+ Compose** to create a new stack.
3. Name it `mini-monitor`.
4. Paste the contents of `compose.yaml`:

```yaml
services:
  mini-monitor:
    build: https://github.com/TRUYNES/mini-monitor.git#main
    container_name: mini-monitor
    restart: unless-stopped
    ports:
      - "9876:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      - TZ=Europe/Istanbul
```

5. Click **Deploy**.

The image will be built automatically from the repository source code.
Access the dashboard at `http://<your-ip>:9876`.
