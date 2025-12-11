const socket = io();
const tableBody = document.getElementById('container-list');
const rowTemplate = document.getElementById('row-template');
const totalCountEl = document.getElementById('total-containers');
const runningCountEl = document.getElementById('running-containers');
const headers = document.querySelectorAll('th.sortable');

// Sorting State
let sortState = {
    column: 'name',
    direction: 'asc' // or 'desc'
};

// Event Listeners for Sorting
headers.forEach(th => {
    th.addEventListener('click', () => {
        const column = th.dataset.sort;
        if (sortState.column === column) {
            sortState.direction = sortState.direction === 'asc' ? 'desc' : 'asc';
        } else {
            sortState.column = column;
            sortState.direction = 'desc'; // Default to desc for metrics usually
            if (column === 'name' || column === 'id' || column === 'state') {
                sortState.direction = 'asc'; // Default asc for text
            }
        }
        updateHeaderStyles();
        // Trigger re-render if we have cached data, but for now we wait for next socket emit or just re-sort current?
        // Ideally we wait for next update, but we can force re-render if we stored data.
        // Let's rely on the fast polling for simplicity, or we store the last received data.
        if (lastContainersData) {
            updateTable(lastContainersData);
        }
    });
});

function updateHeaderStyles() {
    headers.forEach(th => {
        th.classList.remove('asc', 'desc');
        if (th.dataset.sort === sortState.column) {
            th.classList.add(sortState.direction);
        }
    });
}

let lastContainersData = [];

socket.on('containers', (containers) => {
    lastContainersData = containers;
    updateSummary(containers);
    updateTable(containers);
});

// History Data Storage
let systemHistory = []; // Array of {timestamp, cpu, mem, net}

socket.on('initHistory', (history) => {
    systemHistory = history;
    renderAllCharts();
});

socket.on('systemStats', (stats) => {
    // Add new stat
    systemHistory.push(stats);
    // Keep last 8 hours approx (assuming 2s interval, max 14400)
    if (systemHistory.length > 14400) systemHistory.shift();

    updateSystemStats(stats);
    renderAllCharts(); // Optimized: could verify dirty flag, but JS is fast enough for <10k pts roughly
});

function updateSystemStats(stats) {
    // CPU
    document.getElementById('sys-cpu-val').textContent = `${stats.cpu.usage}%`;
    document.getElementById('sys-cpu-model').textContent = `${stats.cpu.manufacturer} ${stats.cpu.brand}`;

    // Memory
    const memPercent = stats.mem.percent || ((stats.mem.used / stats.mem.total) * 100);
    document.getElementById('sys-mem-val').textContent = `${memPercent.toFixed(1)}%`;
    document.getElementById('sys-mem-detail').textContent = `${formatBytes(stats.mem.used)} / ${formatBytes(stats.mem.total)}`;

    // Temp
    const tempVal = stats.cpu.temp;
    const tempEl = document.getElementById('sys-temp-val');

    if (tempVal && tempVal > 0) {
        tempEl.textContent = `${tempVal.toFixed(1)}°C`;
    } else {
        tempEl.textContent = 'N/A';
    }

    // Network
    if (stats.net) {
        document.getElementById('sys-net-rx').textContent = formatBytes(stats.net.rx);
        document.getElementById('sys-net-tx').textContent = formatBytes(stats.net.tx);
    }

    // System
    document.getElementById('sys-os-distro').textContent = `${stats.os.distro} ${stats.os.release}`;
    document.getElementById('sys-uptime').textContent = `Uptime: ${formatUptime(stats.os.uptime)}`;
}

class MiniChart {
    constructor(elementId, dataKey, color) {
        this.container = document.getElementById(elementId);
        this.dataKey = dataKey; // 'cpu.usage', 'mem.percent', 'net.rx', etc.
        this.color = color; // Store the color

        if (!this.container) return;

        this.setup();
    }

    defineGradient(id) {
        const gradient = document.createElementNS('http://www.w3.org/2000/svg', 'linearGradient');
        gradient.id = `gradient-${id}`;
        gradient.setAttribute('x1', '0%');
        gradient.setAttribute('y1', '0%');
        gradient.setAttribute('x2', '0%');
        gradient.setAttribute('y2', '100%');

        // Modern Fade: Color (0.3) -> Color (0.0)
        // Avoid black mud at bottom
        gradient.innerHTML = `
            <stop offset="0%" stop-color="${this.color}" stop-opacity="0.3" />
            <stop offset="100%" stop-color="${this.color}" stop-opacity="0" />
        `;

        this.defs.appendChild(gradient);
    }

    setup() {
        this.container.innerHTML = `
            <svg class="chart-svg" preserveAspectRatio="none">
                <defs>
                </defs>
                <path class="chart-fill" d="" style="stroke:none"></path>
                <path class="chart-line" d=""></path>
                <line class="chart-hover-line" x1="0" y1="0" x2="0" y2="100%"></line>
            </svg>
            <div class="chart-labels">
                <span class="lbl-start"></span>
                <span class="lbl-end"></span>
            </div>
            <div class="peak-badge"></div>
            <div class="chart-tooltip"></div>
            <div class="hover-overlay" style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;"></div>
        `;

        this.svg = this.container.querySelector('svg');
        this.pathLine = this.container.querySelector('.chart-line');
        this.pathFill = this.container.querySelector('.chart-fill');
        this.tooltip = this.container.querySelector('.chart-tooltip');
        this.hoverLine = this.container.querySelector('.chart-hover-line');
        this.badge = this.container.querySelector('.peak-badge');
        this.overlay = this.container.querySelector('.hover-overlay');

        this.lblStart = this.container.querySelector('.lbl-start');
        this.lblEnd = this.container.querySelector('.lbl-end');

        this.overlay.addEventListener('mousemove', (e) => this.onHover(e));
        this.overlay.addEventListener('mouseleave', () => this.onLeave());
    }

    getValue(obj, keyPath) {
        return keyPath.split('.').reduce((o, k) => (o || {})[k], obj) || 0;
    }

    render(data) {
        if (!data || data.length === 0) {
            this.lblStart.textContent = '--:--';
            this.lblEnd.textContent = '--:--';
            return;
        }

        // Update Time Labels
        const startTime = new Date(data[0].timestamp);
        const endTime = new Date(data[data.length - 1].timestamp);
        this.lblStart.textContent = startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.lblEnd.textContent = endTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Generate points
        // If only 1 point, create a fake second point to draw a flat line
        let renderData = [...data];
        if (renderData.length === 1) {
            renderData.push({ ...renderData[0] });
        }

        // Downsample for rendering performance if too many points (render max 200 pts)
        const sampleRate = Math.ceil(renderData.length / 200);
        const points = [];
        let maxVal = 0;
        let pMax = { val: 0, time: 0 };

        for (let i = 0; i < renderData.length; i++) {
            const val = parseFloat(this.getValue(renderData[i], this.dataKey));
            if (val > maxVal) maxVal = val;

            // Track absolute peak for badge
            if (val >= pMax.val) {
                pMax = { val: val, time: renderData[i].timestamp };
            }

            if (i % sampleRate === 0 || i === renderData.length - 1) {
                points.push({ x: i, y: val, time: renderData[i].timestamp, raw: val });
            }
        }

        if (maxVal === 0) maxVal = 1; // Prevent divide by zero

        // Update Badge
        this.badge.textContent = `Peak: ${this.formatValue(pMax.val)}`;

        // Draw SVG
        const width = 100; // viewBox width %
        const height = 100; // viewBox height %

        this.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

        let pathD = points.map((p, i) => {
            const x = (i / (points.length - 1)) * width;
            const y = height - ((p.y / maxVal) * height); // Invert Y
            return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
        }).join(' ');

        this.pathLine.setAttribute('d', pathD);
        this.pathFill.setAttribute('d', `${pathD} L ${width} ${height} L 0 ${height} Z`);

        // Store data for interactions
        this.renderData = { points, maxVal, width, height };
    }

    onHover(e) {
        if (!this.renderData) return;

        const rect = this.container.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const relX = Math.max(0, Math.min(1, x / rect.width));

        // Find closest point
        const index = Math.round(relX * (this.renderData.points.length - 1));
        const point = this.renderData.points[index];

        if (!point) return;

        // Show Tooltip
        const timeStr = new Date(point.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        this.tooltip.textContent = `${timeStr} - ${this.formatValue(point.raw)}`;
        this.tooltip.style.display = 'block';
        this.tooltip.style.left = `${x}px`;
        this.tooltip.style.top = '10%'; // Top of chart

        // Show line
        const lineX = (index / (this.renderData.points.length - 1)) * 100; // % position
        this.hoverLine.setAttribute('x1', `${lineX}%`);
        this.hoverLine.setAttribute('x2', `${lineX}%`);
        this.hoverLine.style.opacity = 1;
    }

    onLeave() {
        this.tooltip.style.display = 'none';
        this.hoverLine.style.opacity = 0;
    }

    formatValue(val) {
        if (this.dataKey.includes('net')) return formatBytes(val) + '/s';
        if (this.dataKey.includes('temp')) return val.toFixed(1) + '°C';
        return val.toFixed(1) + '%';
    }
}

// Initialize Charts
let charts = {};
document.addEventListener('DOMContentLoaded', () => {
    // Init Charts
    charts.cpu = new MiniChart('chart-cpu', 'cpu.usage', '#3b82f6');
    charts.mem = new MiniChart('chart-mem', 'mem.percent', '#8b5cf6');
    charts.temp = new MiniChart('chart-temp', 'cpu.temp', '#f43f5e');
    charts.rx = new MiniChart('chart-rx', 'net.rx', '#10b981'); // Green for Down
    charts.tx = new MiniChart('chart-tx', 'net.tx', '#f97316'); // Orange for Up

    socket.on('connect', () => {
        statusIndicator.classList.add('online');
    });

    socket.on('disconnect', () => {
        statusIndicator.classList.remove('online');
    });

    socket.on('initHistory', (history) => {
        systemHistory = history;
        // Render all
        charts.cpu.render(systemHistory);
        charts.mem.render(systemHistory);
        charts.temp.render(systemHistory);
        charts.rx.render(systemHistory);
        charts.tx.render(systemHistory);
    });

    socket.on('systemStats', (stats) => {
        updateSystemStats(stats);

        systemHistory.push(stats);
        if (systemHistory.length > 5760) systemHistory.shift(); // Sync with backend limit

        if (document.visibilityState === 'visible') {
            charts.cpu.render(systemHistory);
            charts.mem.render(systemHistory);
            charts.temp.render(systemHistory);
            charts.rx.render(systemHistory);
            charts.tx.render(systemHistory);
        }
    });
});

function renderAllCharts() {
    Object.values(charts).forEach(chart => chart.render(systemHistory));
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600 * 24));
    const h = Math.floor(seconds % (3600 * 24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function updateSummary(containers) {
    totalCountEl.textContent = containers.length;
    const running = containers.filter(c => c.state === 'running').length;
    runningCountEl.textContent = running;
}

function updateTable(containers) {
    // Sort containers
    const sorted = [...containers].sort((a, b) => {
        const valA = getSortValue(a, sortState.column);
        const valB = getSortValue(b, sortState.column);

        if (valA < valB) return sortState.direction === 'asc' ? -1 : 1;
        if (valA > valB) return sortState.direction === 'asc' ? 1 : -1;
        return 0;
    });

    // We reconcile rows to avoid total redraws if possible, 
    // but for sorting, re-ordering DOM nodes or simple clear-and-fill is easiest.
    // Given the small number of containers usually, clearing is fine, but let's try to match by ID for updates?
    // Actually, if we sort, the order changes. 
    // Let's do a smart update: find existing tr for id, update it, then append in order.

    // Clear the body and re-append in correct order
    // But we reuse elements to keep references

    const existingRows = {};
    document.querySelectorAll('.container-row').forEach(row => {
        existingRows[row.dataset.id] = row;
    });

    tableBody.innerHTML = '';

    sorted.forEach(container => {
        let row = existingRows[container.id];

        if (!row) {
            const clone = rowTemplate.content.cloneNode(true);
            row = clone.querySelector('tr');
            row.dataset.id = container.id;
        }

        updateRowContent(row, container);
        tableBody.appendChild(row);
    });
}

function getSortValue(container, column) {
    if (!container.stats && column !== 'name' && column !== 'id' && column !== 'state') return -1;

    switch (column) {
        case 'name': return container.name.toLowerCase();
        case 'id': return container.id;
        case 'state': return container.state;
        case 'cpu': return parseFloat(container.stats?.cpu || 0);
        case 'memory': return parseFloat(container.stats?.memoryPercent || 0);
        case 'memusage': return container.stats?.memory || 0;
        case 'net':
            // approximate sort by total IO
            if (!container.stats?.netIO) return 0;
            let total = 0;
            Object.values(container.stats.netIO).forEach(io => total += (io.rx_bytes + io.tx_bytes));
            return total;
        case 'block':
            if (!container.stats?.blockIO) return 0;
            return (container.stats.blockIO.read || 0) + (container.stats.blockIO.write || 0);
        case 'pids': return container.stats?.pids || 0;
        default: return 0;
    }
}

function updateRowContent(row, container) {
    const isRunning = container.state === 'running';
    const stats = container.stats;

    // Helper for safe text
    const setText = (selector, text) => row.querySelector(selector).textContent = text;

    setText('.c-name', container.name);
    setText('.c-image-sub', container.image);
    setText('.c-id', container.id);
    setText('.c-state', container.state);

    const statusDot = row.querySelector('.status-dot');
    statusDot.className = 'status-dot';
    statusDot.classList.add(`status-${container.state}`);

    if (isRunning && stats) {
        // CPU
        const cpuP = parseFloat(stats.cpu);
        setText('.c-cpu-val', `${cpuP}%`);
        const cpuBar = row.querySelector('.c-cpu-bar');
        cpuBar.style.width = `${Math.min(cpuP, 100)}%`;

        // Colorize CPU
        if (cpuP > 80) cpuBar.style.background = 'var(--accent-danger)';
        else if (cpuP > 50) cpuBar.style.background = 'var(--accent-warning)';
        else cpuBar.style.background = ''; // use CSS gradient

        // Memory
        const memP = parseFloat(stats.memoryPercent);
        setText('.c-mem-percent-val', `${memP}%`);
        row.querySelector('.c-mem-bar').style.width = `${Math.min(memP, 100)}%`;

        setText('.c-mem-usage', `${formatBytes(stats.memory)} / ${formatBytes(stats.memoryLimit)}`);

        // Net I/O
        if (stats.netIO) {
            let rx = 0;
            let tx = 0;
            for (const key in stats.netIO) {
                rx += stats.netIO[key].rx_bytes;
                tx += stats.netIO[key].tx_bytes;
            }
            setText('.c-net', `${formatBytes(rx)} / ${formatBytes(tx)}`);
        } else {
            setText('.c-net', '-- / --');
        }

        // Block I/O
        if (stats.blockIO) {
            setText('.c-block', `${formatBytes(stats.blockIO.read)} / ${formatBytes(stats.blockIO.write)}`);
        } else {
            setText('.c-block', '-- / --');
        }

        // PIDs
        setText('.c-pids', stats.pids);

    } else {
        setText('.c-cpu-val', '0%');
        row.querySelector('.c-cpu-bar').style.width = '0%';
        setText('.c-mem-percent-val', '0%');
        row.querySelector('.c-mem-bar').style.width = '0%';
        setText('.c-mem-usage', '- / -');
        setText('.c-net', '- / -');
        setText('.c-block', '- / -');
        setText('.c-pids', '-');
    }
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))}${sizes[i]}`;
}

