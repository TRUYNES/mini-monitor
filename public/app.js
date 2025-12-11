const socket = io();
const containerGrid = document.getElementById('container-grid');
const cardTemplate = document.getElementById('card-template');
const totalCountEl = document.getElementById('total-containers');
const runningCountEl = document.getElementById('running-containers');

// Store charts and previous data to avoid flickering/re-renders
const CHARTS = {};
const PREV_DATA = {};

socket.on('containers', (containers) => {
    updateSummary(containers);
    updateGrid(containers);
});

function updateSummary(containers) {
    totalCountEl.textContent = containers.length;
    const running = containers.filter(c => c.state === 'running').length;
    runningCountEl.textContent = running;
}

function updateGrid(containers) {
    // Current IDs for cleanup
    const currentIds = new Set(containers.map(c => c.id));

    // Remove old cards
    document.querySelectorAll('.container-card').forEach(card => {
        const id = card.id.replace('card-', '');
        if (!currentIds.has(id)) {
            if (CHARTS[id]) {
                CHARTS[id].destroy();
                delete CHARTS[id];
            }
            card.remove();
        }
    });

    containers.forEach(container => {
        let card = document.getElementById(`card-${container.id}`);

        if (!card) {
            // Create new card
            const clone = cardTemplate.content.cloneNode(true);
            card = clone.querySelector('.container-card');
            card.id = `card-${container.id}`;
            containerGrid.appendChild(card);

            // Init Chart
            initChart(container.id, card);
        }

        // Update Content
        updateCardContent(card, container);
    });
}

function updateCardContent(card, container) {
    const isRunning = container.state === 'running';

    // Header
    card.querySelector('.container-name').textContent = container.name;
    card.querySelector('.container-id').textContent = container.id;
    card.querySelector('.container-image-badge').textContent = container.image; // optional
    const statusDiv = card.querySelector('.status-indicator');

    // Reset classes
    statusDiv.className = 'status-indicator';
    statusDiv.classList.add(`status-${container.state}`);

    // Footer
    card.querySelector('.state-text').textContent = container.status;

    // Stats
    const stats = container.stats;
    const cpuBar = card.querySelector('.cpu-fill');
    const cpuVal = card.querySelector('.cpu-value');
    const memBar = card.querySelector('.mem-fill');
    const memVal = card.querySelector('.mem-percent');
    const memUsage = card.querySelector('.mem-usage');
    const netIo = card.querySelector('.net-io');

    if (isRunning && stats) {
        // CPU
        const cpuP = parseFloat(stats.cpu);
        cpuBar.style.width = `${Math.min(cpuP, 100)}%`;
        cpuVal.textContent = `${cpuP}%`;

        // Colorize CPU high usage
        if (cpuP > 80) cpuBar.style.backgroundColor = 'var(--accent-danger)';
        else if (cpuP > 50) cpuBar.style.backgroundColor = 'var(--accent-warning)';
        else cpuBar.style.background = ''; // reset to css gradient

        // Memory
        const memP = parseFloat(stats.memoryPercent);
        memBar.style.width = `${Math.min(memP, 100)}%`;
        memVal.textContent = `${memP}%`;
        memUsage.textContent = `${formatBytes(stats.memory)} / ${formatBytes(stats.memoryLimit)}`;

        // Network
        if (stats.netIO) {
            // Simple sum of all interfaces for display
            let rx = 0;
            let tx = 0;
            for (const key in stats.netIO) {
                rx += stats.netIO[key].rx_bytes;
                tx += stats.netIO[key].tx_bytes;
            }
            netIo.textContent = `↓${formatBytes(rx)} ↑${formatBytes(tx)}`;
        }

        // Update Chart
        updateChart(container.id, stats.cpu);

    } else {
        // Zero out if not running
        cpuBar.style.width = '0%';
        cpuVal.textContent = '0%';
        memBar.style.width = '0%';
        memVal.textContent = '0%';
        memUsage.textContent = '- / -';
        netIo.textContent = '--';
    }
}

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function initChart(id, cardElement) {
    const ctx = cardElement.querySelector('.usage-chart').getContext('2d');

    CHARTS[id] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: Array(20).fill(''),
            datasets: [{
                label: 'CPU',
                data: Array(20).fill(0),
                borderColor: '#38bdf8',
                borderWidth: 1.5,
                tension: 0.4,
                pointRadius: 0,
                fill: true,
                backgroundColor: (context) => {
                    const ctx = context.chart.ctx;
                    const gradient = ctx.createLinearGradient(0, 0, 0, 60);
                    gradient.addColorStop(0, 'rgba(56, 189, 248, 0.2)');
                    gradient.addColorStop(1, 'rgba(56, 189, 248, 0)');
                    return gradient;
                }
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { enabled: false }
            },
            scales: {
                x: { display: false },
                y: {
                    display: false,
                    min: 0,
                    suggestedMax: 10
                }
            },
            animation: { duration: 0 }
        }
    });
}

function updateChart(id, cpuValue) {
    if (!CHARTS[id]) return;

    const chart = CHARTS[id];
    const data = chart.data.datasets[0].data;

    data.push(cpuValue);
    data.shift();

    // Dynamic Y axis if CPU spikes
    if (cpuValue > chart.options.scales.y.suggestedMax) {
        chart.options.scales.y.suggestedMax = cpuValue;
    }

    chart.update();
}
