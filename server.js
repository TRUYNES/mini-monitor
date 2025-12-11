const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Docker = require('dockerode');
const path = require('path');
const si = require('systeminformation');

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

function calculateBlockIO(blkioStats) {
  if (!blkioStats) return { read: 0, write: 0 };

  let read = 0;
  let write = 0;

  // cgroup v1 often uses io_service_bytes_recursive
  if (blkioStats.io_service_bytes_recursive && Array.isArray(blkioStats.io_service_bytes_recursive)) {
    blkioStats.io_service_bytes_recursive.forEach(entry => {
      if (entry.op === 'Read') read += entry.value;
      if (entry.op === 'Write') write += entry.value;
    });
    return { read, write };
  }

  // Backup for other descriptors or cgroup v2 flattened stats if available in the raw object
  // Note: Docker API varies wildly here. Sometimes it's buried in 'io_service_bytes_recursive'
  // but sometimes that array is empty. 

  // If we can't find it, we return 0. 
  // TODO: For robust production monitoring, reading /proc/$pid/io inside the container namespace is better,
  // but that requires root and nsenter. Sticking to Docker API for "mini" monitor.
  return { read, write };
}

async function monitorContainers() {
  try {
    const containers = await docker.listContainers({ all: true });

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

// History Buffer (Last 8 hours)
// Poll every 2 seconds = 30/min * 60 * 8 = 14,400 points max. 
// To save bandwidth, we might want to emit history only on connect, and then live updates.
const MAX_HISTORY = 14400;
let systemHistory = [];

async function monitorSystem() {
  try {
    // Note: cpuTemperature might require specific privileges on some systems
    const [cpu, mem, osInfo, currentLoad, temp, netStats] = await Promise.all([
      si.cpu(),
      si.mem(),
      si.osInfo(),
      si.currentLoad(),
      si.cpuTemperature(),
      si.networkStats()
    ]);

    // Aggregate network stats (all interfaces)
    let netRx = 0;
    let netTx = 0;
    if (netStats && netStats.length) {
      netStats.forEach(iface => {
        netRx += iface.rx_sec; // bytes per second
        netTx += iface.tx_sec;
      });
    }

    const stats = {
      timestamp: Date.now(),
      cpu: {
        manufacturer: cpu.manufacturer,
        brand: cpu.brand,
        cores: cpu.cores,
        usage: currentLoad.currentLoad.toFixed(1),
        temp: temp.main || 0 // Default to 0 if not available
      },
      mem: {
        total: mem.total,
        free: mem.free,
        used: mem.active, // "Active" memory is usually what users mean (excluding cache)
        active: mem.active,
        available: mem.available,
        percent: (mem.active / mem.total) * 100 // Pre-calculate percent based on active
      },
      net: {
        rx: netRx,
        tx: netTx
      },
      os: {
        platform: osInfo.platform,
        distro: osInfo.distro,
        release: osInfo.release,
        uptime: si.time().uptime
      }
    };

    // Add to history
    systemHistory.push(stats);
    if (systemHistory.length > MAX_HISTORY) {
      systemHistory.shift();
    }

    io.emit('systemStats', stats);
  } catch (e) {
    console.error('Error getting system stats:', e);
  }
}

// Update loop
const POLL_INTERVAL = 2000;
setInterval(() => {
  monitorContainers();
  monitorSystem();
}, POLL_INTERVAL);

io.on('connection', (socket) => {
  console.log('Client connected');

  // Send full history on connection
  socket.emit('initHistory', systemHistory);

  monitorContainers(); // Send immediate update
  monitorSystem();

  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Mini Monitor running on port ${PORT}`);
});
