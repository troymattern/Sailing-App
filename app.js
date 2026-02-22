/**
 * Sailboat Polar Builder
 * Records GPS speed + wind conditions and renders a polar diagram.
 */

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'polar_data_points';
const TWS_COLORS = {
  6:  '#06b6d4',
  8:  '#3b82f6',
  10: '#8b5cf6',
  12: '#22c55e',
  16: '#f59e0b',
  20: '#ef4444',
  25: '#ec4899',
  other: '#94a3b8',
};

// Bucket TWS to nearest standard value for colour grouping
function twsBucket(tws) {
  const standards = [6, 8, 10, 12, 16, 20, 25];
  return standards.reduce((prev, cur) =>
    Math.abs(cur - tws) < Math.abs(prev - tws) ? cur : prev
  );
}

// ─── State ────────────────────────────────────────────────────────────────────
let gpsWatchId = null;
let currentSpeed = null; // knots (from GPS)
let dataPoints = [];     // { twa, tws, bsp, time }

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const elSpeed      = document.getElementById('gps-speed');
const elDot        = document.getElementById('gps-dot');
const elLabel      = document.getElementById('gps-label');
const elHeading    = document.getElementById('gps-heading');
const elAccuracy   = document.getElementById('gps-accuracy');
const elBtnGps     = document.getElementById('btn-gps');
const elTwaSlider  = document.getElementById('twa-slider');
const elTwaNum     = document.getElementById('twa');
const elTwsSlider  = document.getElementById('tws-slider');
const elTwsNum     = document.getElementById('tws');
const elDesc       = document.getElementById('wind-description');
const elBtnRecord  = document.getElementById('btn-record');
const elFeedback   = document.getElementById('record-feedback');
const elTableBody  = document.getElementById('table-body');
const elCount      = document.getElementById('point-count');
const elCanvas     = document.getElementById('polar-canvas');
const elLegend     = document.getElementById('chart-legend');
const elToggleLabels = document.getElementById('toggle-labels');
const elTogglePoints = document.getElementById('toggle-points');
const elBtnClear   = document.getElementById('btn-clear-chart');
const elBtnExport  = document.getElementById('btn-export');
const elBtnImport  = document.getElementById('btn-import');
const elBtnImportLabel = document.getElementById('btn-import-label');

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dataPoints));
}

// ─── GPS ──────────────────────────────────────────────────────────────────────
function metersPerSecondToKnots(mps) {
  return mps * 1.94384;
}

function setGpsStatus(state, text) {
  elDot.className = 'status-dot ' + state;
  elLabel.textContent = text;
}

function onGpsSuccess(pos) {
  const speed = pos.coords.speed; // m/s or null
  const heading = pos.coords.heading;
  const accuracy = pos.coords.accuracy;

  if (speed !== null && speed >= 0) {
    currentSpeed = metersPerSecondToKnots(speed);
    elSpeed.textContent = currentSpeed.toFixed(1);
    setGpsStatus('active', 'GPS active');
    elBtnRecord.disabled = false;
  } else {
    // GPS fix obtained but no speed yet (common on first fix)
    currentSpeed = 0;
    elSpeed.textContent = '0.0';
    setGpsStatus('active', 'GPS active — moving slowly');
    elBtnRecord.disabled = false;
  }

  elHeading.textContent = heading !== null ? Math.round(heading) : '---';
  elAccuracy.textContent = accuracy !== null ? Math.round(accuracy) : '---';
}

function onGpsError(err) {
  const msgs = {
    1: 'Permission denied',
    2: 'Position unavailable',
    3: 'GPS timeout',
  };
  setGpsStatus('error', msgs[err.code] || 'GPS error');
  currentSpeed = null;
  elBtnRecord.disabled = true;
}

elBtnGps.addEventListener('click', () => {
  if (!navigator.geolocation) {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const msg = isIOS
      ? 'GPS unavailable. Make sure the site is served over HTTPS and location permission is enabled in Settings → Safari.'
      : 'Geolocation not supported by this browser.';
    setGpsStatus('error', msg);
    return;
  }

  if (gpsWatchId !== null) {
    // Stop GPS
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    currentSpeed = null;
    elSpeed.textContent = '--.-';
    elHeading.textContent = '---';
    elAccuracy.textContent = '---';
    setGpsStatus('inactive', 'GPS stopped');
    elBtnGps.textContent = 'Start GPS';
    elBtnGps.classList.remove('active');
    elBtnRecord.disabled = true;
    return;
  }

  setGpsStatus('acquiring', 'Acquiring GPS…');
  elBtnGps.textContent = 'Stop GPS';
  elBtnGps.classList.add('active');

  gpsWatchId = navigator.geolocation.watchPosition(
    onGpsSuccess,
    onGpsError,
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
});

// ─── Wind Inputs ──────────────────────────────────────────────────────────────
function angleDescription(twa) {
  if (twa <= 10)  return 'In irons (head-to-wind)';
  if (twa <= 40)  return 'Close-hauled';
  if (twa <= 60)  return 'Close reach';
  if (twa <= 100) return 'Beam reach';
  if (twa <= 140) return 'Broad reach';
  if (twa <= 170) return 'Deep run / training run';
  return 'Dead downwind (run)';
}

function syncInputs(src) {
  const val = Number(src.value);
  if (src === elTwaSlider) {
    elTwaNum.value = val;
  } else if (src === elTwaNum) {
    elTwaSlider.value = val;
  } else if (src === elTwsSlider) {
    elTwsNum.value = val;
    highlightPreset(val);
  } else if (src === elTwsNum) {
    elTwsSlider.value = val;
    highlightPreset(val);
  }
  elDesc.textContent = angleDescription(Number(elTwaNum.value));
}

function highlightPreset(tws) {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.tws) === Number(tws));
  });
}

[elTwaSlider, elTwaNum, elTwsSlider, elTwsNum].forEach(el =>
  el.addEventListener('input', () => syncInputs(el))
);

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.tws;
    elTwsNum.value = v;
    elTwsSlider.value = v;
    highlightPreset(v);
  });
});

// Init description
elDesc.textContent = angleDescription(Number(elTwaNum.value));
highlightPreset(Number(elTwsNum.value));

// ─── Record Data Point ────────────────────────────────────────────────────────
function showFeedback(msg, type) {
  elFeedback.textContent = msg;
  elFeedback.className = 'record-feedback ' + type;
  clearTimeout(showFeedback._timer);
  showFeedback._timer = setTimeout(() => {
    elFeedback.className = 'record-feedback hidden';
  }, 3000);
}

elBtnRecord.addEventListener('click', () => {
  if (currentSpeed === null) {
    showFeedback('No GPS speed available.', 'error');
    return;
  }

  const twa = Number(elTwaNum.value);
  const tws = Number(elTwsNum.value);
  const bsp = currentSpeed;

  if (twa < 0 || twa > 180) {
    showFeedback('TWA must be between 0° and 180°.', 'error');
    return;
  }
  if (tws <= 0) {
    showFeedback('Wind speed must be greater than 0.', 'error');
    return;
  }

  const point = {
    twa,
    tws,
    bsp: parseFloat(bsp.toFixed(2)),
    time: new Date().toLocaleTimeString(),
  };

  dataPoints.push(point);
  saveData();
  renderTable();
  drawPolar();
  showFeedback(
    `Recorded: TWA ${twa}° / TWS ${tws} kts / BSP ${bsp.toFixed(2)} kts`,
    'success'
  );
});

// ─── Table ────────────────────────────────────────────────────────────────────
function renderTable() {
  elCount.textContent = dataPoints.length;

  if (dataPoints.length === 0) {
    elTableBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No data recorded yet. Start GPS and record your first point.</td>
      </tr>`;
    return;
  }

  elTableBody.innerHTML = dataPoints.map((p, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${p.twa}°</td>
      <td>${p.tws}</td>
      <td>${p.bsp}</td>
      <td>${p.time}</td>
      <td><button class="delete-btn" data-i="${i}" title="Delete">&#x2715;</button></td>
    </tr>
  `).join('');

  elTableBody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      dataPoints.splice(Number(btn.dataset.i), 1);
      saveData();
      renderTable();
      drawPolar();
    });
  });
}

// ─── Polar Chart ──────────────────────────────────────────────────────────────
const ctx = elCanvas.getContext('2d');

// ─── HiDPI / Retina canvas scaling ────────────────────────────────────────────
function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const logicalSize = 520;
  elCanvas.width  = logicalSize * dpr;
  elCanvas.height = logicalSize * dpr;
  elCanvas.style.width  = logicalSize + 'px';
  elCanvas.style.height = logicalSize + 'px';
  ctx.scale(dpr, dpr);
}

setupCanvas();
window.addEventListener('resize', () => { setupCanvas(); drawPolar(); });

function drawPolar() {
  const dpr = window.devicePixelRatio || 1;
  const W = elCanvas.width / dpr;
  const H = elCanvas.height / dpr;
  const cx = W / 2;
  const cy = 30; // top of the chart (0° = top)
  const showLabels = elToggleLabels.checked;
  const showPoints = elTogglePoints.checked;

  ctx.clearRect(0, 0, W, H);

  // Max BSP for scaling
  const maxBsp = Math.max(8, ...dataPoints.map(p => p.bsp)) * 1.15;
  const maxR = Math.min(W / 2 - 20, H - cy - 20); // radius in px

  function polarToXY(angleDeg, bsp) {
    const r = (bsp / maxBsp) * maxR;
    const rad = (angleDeg - 90) * (Math.PI / 180); // 0° = up
    return {
      x: cx + r * Math.cos(rad),
      y: cy + r * Math.sin(rad),
    };
  }

  // ── Grid ──
  const rings = 4;
  for (let i = 1; i <= rings; i++) {
    const r = (i / rings) * maxR;
    const label = ((i / rings) * maxBsp).toFixed(1);

    // Semicircle (0–180°)
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (showLabels) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(label + ' kts', cx, cy + r + 12);
    }
  }

  // ── Angle spokes ──
  const spokeAngles = [0, 30, 45, 60, 90, 120, 135, 150, 180];
  spokeAngles.forEach(a => {
    const end = polarToXY(a, maxBsp);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (showLabels) {
      const lbl = polarToXY(a, maxBsp * 1.08);
      ctx.fillStyle = '#64748b';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a + '°', lbl.x, lbl.y);
    }
  });

  // ── Group data by TWS bucket ──
  const groups = {};
  dataPoints.forEach(p => {
    const b = twsBucket(p.tws);
    if (!groups[b]) groups[b] = [];
    groups[b].push(p);
  });

  // For each TWS group, compute max BSP per TWA bucket and draw a curve
  const twsGroups = Object.keys(groups).map(Number).sort((a, b) => a - b);

  // Update legend
  elLegend.innerHTML = twsGroups.map(tws => {
    const color = TWS_COLORS[tws] || TWS_COLORS.other;
    return `
      <div class="legend-item">
        <span class="legend-dot" style="background:${color}"></span>
        TWS ~${tws} kts
      </div>`;
  }).join('');

  twsGroups.forEach(tws => {
    const pts = groups[tws];
    const color = TWS_COLORS[tws] || TWS_COLORS.other;

    // Build max-BSP polar: for each 5° bucket take best BSP
    const bucketSize = 5;
    const maxPolar = {};
    pts.forEach(p => {
      const bucket = Math.round(p.twa / bucketSize) * bucketSize;
      if (!maxPolar[bucket] || p.bsp > maxPolar[bucket]) {
        maxPolar[bucket] = p.bsp;
      }
    });

    const sortedBuckets = Object.keys(maxPolar).map(Number).sort((a, b) => a - b);

    if (sortedBuckets.length >= 2) {
      // Draw smoothed polar curve
      ctx.beginPath();
      sortedBuckets.forEach((angle, idx) => {
        const { x, y } = polarToXY(angle, maxPolar[angle]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // Draw individual data points
    if (showPoints) {
      pts.forEach(p => {
        const { x, y } = polarToXY(p.twa, p.bsp);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      });
    }
  });

  // ── Center label ──
  ctx.fillStyle = '#94a3b8';
  ctx.font = 'bold 11px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('WIND', cx, cy + 2);
}

// ─── Chart controls ───────────────────────────────────────────────────────────
elToggleLabels.addEventListener('change', drawPolar);
elTogglePoints.addEventListener('change', drawPolar);

elBtnClear.addEventListener('click', () => {
  if (!confirm('Delete all recorded data points?')) return;
  dataPoints = [];
  saveData();
  renderTable();
  drawPolar();
});

// ─── Export CSV ───────────────────────────────────────────────────────────────
elBtnExport.addEventListener('click', () => {
  if (dataPoints.length === 0) { alert('No data to export.'); return; }

  const header = 'TWA_deg,TWS_kts,BSP_kts,Time\n';
  const rows = dataPoints.map(p => `${p.twa},${p.tws},${p.bsp},${p.time}`).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `polar_data_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Import CSV ───────────────────────────────────────────────────────────────
elBtnImportLabel.addEventListener('click', () => elBtnImport.click());

elBtnImport.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const lines = ev.target.result.split('\n').filter(l => l.trim());
    // Skip header
    let imported = 0;
    lines.slice(1).forEach(line => {
      const parts = line.split(',');
      const twa = parseFloat(parts[0]);
      const tws = parseFloat(parts[1]);
      const bsp = parseFloat(parts[2]);
      const time = parts[3] ? parts[3].trim() : '(imported)';
      if (!isNaN(twa) && !isNaN(tws) && !isNaN(bsp)) {
        dataPoints.push({ twa, tws, bsp, time });
        imported++;
      }
    });
    if (imported > 0) {
      saveData();
      renderTable();
      drawPolar();
      alert(`Imported ${imported} data point(s).`);
    } else {
      alert('No valid data found in file.');
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});

// ─── Init ──────────────────────────────────────────────────────────────────────
dataPoints = loadData();
renderTable();
drawPolar();
