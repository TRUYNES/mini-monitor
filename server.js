const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Initialize Docker connection
// Default socket path for Linux/Mac
const docker = new Docker({ socketPath: '/var/run/docker.sock' });

app.use(express.static(path.join(__dirname, 'public')));

let streams = {}; // Keep track of stat streams to clean them up

async function getContainerStats(container) {
  return new Promise((resolve, reject) => {
    container.stats({ stream: false }, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

function calculateCPUPercent(stats) {
  if (!stats?.cpu_stats?.cpu_usage?.total_usage || !stats?.precpu_stats?.cpu_usage?.total_usage) {
    return 0;
  }

  const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
  const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
  const numberCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;

  if (systemDelta > 0 && cpuDelta > 0) {
    return (cpuDelta / systemDelta) * numberCpus * 100;
  }
  return 0;
}

function calculateMemoryUsage(stats) {
  if (!stats?.memory_stats?.usage) return { start: 0, limit: 0, percent: 0 };

  // Prioritize usage - cache if available, falling back to just usage
  const used_memory = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
  const available_memory = stats.memory_stats.limit;
  const memory_percent = (used_memory / available_memory) * 100;

  return {
    usage: used_memory,
    limit: available_memory,
    percent: memory_percent
  };
}

async function monitorContainers() {
  try {
    const containers = await docker.listContainers({ all: true });

    // We will fetch full list + basic stats in a polling manner for simplicity and robustness
    // For a production 'top' like feel, polling every 2-3 seconds is efficient enough compared to keeping open streams for N containers.

    const enrichedContainers = await Promise.all(containers.map(async (containerInfo) => {
      const container = docker.getContainer(containerInfo.Id);

      let state = containerInfo.State;
      let stats = null;

      if (state === 'running') {
        try {
          const rawStats = await getContainerStats(container);
          const cpuPercent = calculateCPUPercent(rawStats);
          const memStats = calculateMemoryUsage(rawStats);

          stats = {
            cpu: cpuPercent.toFixed(2),
            memory: memStats.usage,
            memoryLimit: memStats.limit,
            memoryPercent: memStats.percent.toFixed(2),
            netIO: rawStats.networks,
            blockIO: calculateBlockIO(rawStats.blkio_stats),
            pids: rawStats.pids_stats?.current || 0
          };
        } catch (e) {
          console.error(`Error getting stats for ${containerInfo.Names[0]}:`, e.message);
        }
      }

      return {
        id: containerInfo.Id.substring(0, 12),
        name: containerInfo.Names[0].replace('/', ''),
        image: containerInfo.Image,
        state: state,
        status: containerInfo.Status,
        stats: stats
      };
    }));

    io.emit('containers', enrichedContainers);

  } catch (error) {
    console.error('Error listing containers:', error);
  }
}

function calculateBlockIO(blkioStats) {
  if (!blkioStats || !blkioStats.io_service_bytes_recursive) return { read: 0, write: 0 };

  let read = 0;
  let write = 0;

  blkioStats.io_service_bytes_recursive.forEach(entry => {
    if (entry.op === 'Read') read += entry.value;
    if (entry.op === 'Write') write += entry.value;
  });

  return { read, write };
}



// Update loop
const POLL_INTERVAL = 2000;
setInterval(monitorContainers, POLL_INTERVAL);

io.on('connection', (socket) => {
  console.log('Client connected');
  monitorContainers(); // Send immediate update

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mini Monitor running on port ${PORT}`);
});
