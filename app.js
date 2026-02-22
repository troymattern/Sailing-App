/**
 * Sailboat Polar Builder
 *
 * Flow:
 *   1. GPS started → shows boat speed in knots.
 *   2. App instructs the sailor which True Wind Angle to sail to.
 *   3. Sailor navigates to that angle, then taps "I'm at this angle".
 *   4. App asks for True Wind Speed confirmation.
 *   5. Sailor enters TWS and taps "Record GPS Speed".
 *   6. Data point saved, chart updated, ready for next angle.
 */

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS when inserting
 * untrusted strings into innerHTML.
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Parse a float and clamp it within [min, max].
 * Returns null if the value is NaN or out of range.
 */
function safeFloat(value, min, max) {
  const n = parseFloat(value);
  if (!isFinite(n) || n < min || n > max) return null;
  return n;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'polar_data_points';

// Standard polar measurement angles (degrees)
const TARGET_ANGLES = [30, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180];

const TWS_COLORS = {
  6:  '#06b6d4',
  8:  '#3b82f6',
  10: '#8b5cf6',
  12: '#22c55e',
  16: '#f59e0b',
  20: '#ef4444',
  25: '#ec4899',
};
const DEFAULT_COLOR = '#94a3b8';

function twsBucket(tws) {
  const standards = Object.keys(TWS_COLORS).map(Number);
  return standards.reduce((prev, cur) =>
    Math.abs(cur - tws) < Math.abs(prev - tws) ? cur : prev
  );
}

// ─── State ────────────────────────────────────────────────────────────────────
let gpsWatchId   = null;
let currentSpeed = null;      // knots from GPS
let dataPoints   = [];        // { twa, tws, bsp, time }
let angleIndex   = 4;         // default: 90° (index 5 → 0-based: 4)
let confirmed    = false;     // has the user confirmed they are at the target angle?

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const elSpeed       = document.getElementById('gps-speed');
const elDot         = document.getElementById('gps-dot');
const elLabel       = document.getElementById('gps-label');
const elHeading     = document.getElementById('gps-heading');
const elAccuracy    = document.getElementById('gps-accuracy');
const elBtnGps      = document.getElementById('btn-gps');

const elTargetTwa   = document.getElementById('target-twa-display');
const elAngleDesc   = document.getElementById('angle-desc');
const elAngleIndex  = document.getElementById('angle-index');
const elAngleTotal  = document.getElementById('angle-total');
const elBtnPrev     = document.getElementById('btn-prev-angle');
const elBtnNext     = document.getElementById('btn-next-angle');

const elConfirmSection = document.getElementById('confirm-section');
const elBtnAtAngle     = document.getElementById('btn-at-angle');
const elConfirmLabel   = document.getElementById('confirm-twa-label');

const elTwsSection  = document.getElementById('tws-section');
const elTwsSlider   = document.getElementById('tws-slider');
const elTwsNum      = document.getElementById('tws');
const elBtnRecord   = document.getElementById('btn-record');
const elBtnCancel   = document.getElementById('btn-cancel-confirm');
const elFeedback    = document.getElementById('record-feedback');

const elTableBody   = document.getElementById('table-body');
const elCount       = document.getElementById('point-count');
const elCanvas      = document.getElementById('polar-canvas');
const elLegend      = document.getElementById('chart-legend');
const elToggleLabels = document.getElementById('toggle-labels');
const elTogglePoints = document.getElementById('toggle-points');
const elBtnClear    = document.getElementById('btn-clear-chart');
const elBtnExport   = document.getElementById('btn-export');
const elBtnImport   = document.getElementById('btn-import');
const elBtnImportLabel = document.getElementById('btn-import-label');

// ─── Persistence ──────────────────────────────────────────────────────────────
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    // Validate and sanitize every record loaded from storage
    return parsed.filter(p => {
      const twa = safeFloat(p.twa, 0, 180);
      const tws = safeFloat(p.tws, 0.1, 100);
      const bsp = safeFloat(p.bsp, 0, 50);
      if (twa === null || tws === null || bsp === null) return false;
      p.twa = twa;
      p.tws = tws;
      p.bsp = bsp;
      // Time must be a plain string; strip anything suspicious
      p.time = typeof p.time === 'string'
        ? p.time.replace(/[<>"'&]/g, '').slice(0, 30)
        : '--';
      return true;
    });
  } catch {
    return [];
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dataPoints));
}

// ─── GPS ──────────────────────────────────────────────────────────────────────
function metersPerSecondToKnots(mps) {
  return mps * 1.94384;
}

function setGpsStatus(state, text) {
  elDot.className  = 'status-dot ' + state;
  elLabel.textContent = text;
}

function onGpsSuccess(pos) {
  const speed   = pos.coords.speed;
  const heading = pos.coords.heading;
  const accuracy = pos.coords.accuracy;

  currentSpeed = (speed !== null && speed >= 0)
    ? metersPerSecondToKnots(speed)
    : 0;

  elSpeed.textContent = currentSpeed.toFixed(1);
  setGpsStatus('active', 'GPS active');

  elHeading.textContent  = heading  !== null ? Math.round(heading)  : '---';
  elAccuracy.textContent = accuracy !== null ? Math.round(accuracy) : '---';

  // Enable the confirmation button now that GPS is live
  updateConfirmButton();
}

function onGpsError(err) {
  const msgs = {
    1: 'Permission denied',
    2: 'Position unavailable',
    3: 'GPS timeout',
  };
  setGpsStatus('error', msgs[err.code] || 'GPS error');
  currentSpeed = null;
  updateConfirmButton();
}

elBtnGps.addEventListener('click', () => {
  if (!navigator.geolocation) {
    const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
    setGpsStatus('error', isIOS
      ? 'Location unavailable — ensure the site uses HTTPS and location is enabled in Settings → Safari.'
      : 'Geolocation not supported in this browser.');
    return;
  }

  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    currentSpeed = null;
    elSpeed.textContent    = '--.-';
    elHeading.textContent  = '---';
    elAccuracy.textContent = '---';
    setGpsStatus('inactive', 'GPS stopped');
    elBtnGps.textContent = 'Start GPS';
    elBtnGps.classList.remove('active');
    updateConfirmButton();
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

// ─── Angle navigation ─────────────────────────────────────────────────────────
function angleDescription(twa) {
  if (twa <= 10)  return 'Head-to-Wind (In Irons)';
  if (twa <= 40)  return 'Close-Hauled';
  if (twa <= 60)  return 'Close Reach';
  if (twa <= 100) return 'Beam Reach';
  if (twa <= 140) return 'Broad Reach';
  if (twa <= 170) return 'Deep Broad Reach';
  return 'Dead Downwind (Run)';
}

function renderAngleInstruction() {
  const twa = TARGET_ANGLES[angleIndex];
  elTargetTwa.textContent   = twa;
  elAngleDesc.textContent   = angleDescription(twa);
  elAngleIndex.textContent  = angleIndex + 1;
  elAngleTotal.textContent  = TARGET_ANGLES.length;
  elBtnPrev.disabled        = angleIndex === 0;
  elBtnNext.disabled        = angleIndex === TARGET_ANGLES.length - 1;

  // Update confirm label too
  elConfirmLabel.textContent = twa;

  // Reset confirmation state when angle changes
  if (confirmed) cancelConfirm();
}

function cancelConfirm() {
  confirmed = false;
  elTwsSection.classList.add('hidden');
  elConfirmSection.classList.remove('hidden');
}

elBtnPrev.addEventListener('click', () => {
  if (angleIndex > 0) { angleIndex--; renderAngleInstruction(); }
});

elBtnNext.addEventListener('click', () => {
  if (angleIndex < TARGET_ANGLES.length - 1) { angleIndex++; renderAngleInstruction(); }
});

// ─── Confirm at angle ─────────────────────────────────────────────────────────
function updateConfirmButton() {
  elBtnAtAngle.disabled = currentSpeed === null;
}

elBtnAtAngle.addEventListener('click', () => {
  if (currentSpeed === null) return;
  confirmed = true;
  elConfirmSection.classList.add('hidden');
  elTwsSection.classList.remove('hidden');
});

elBtnCancel.addEventListener('click', cancelConfirm);

// ─── TWS syncing ──────────────────────────────────────────────────────────────
function syncTws(src) {
  const val = Number(src.value);
  if (src === elTwsSlider) {
    elTwsNum.value = val;
  } else {
    elTwsSlider.value = Math.min(val, 40);
  }
  highlightPreset(val);
}

function highlightPreset(tws) {
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.tws) === Number(tws));
  });
}

elTwsSlider.addEventListener('input', () => syncTws(elTwsSlider));
elTwsNum.addEventListener('input',    () => syncTws(elTwsNum));

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = btn.dataset.tws;
    elTwsNum.value    = v;
    elTwsSlider.value = v;
    highlightPreset(v);
  });
});

highlightPreset(Number(elTwsNum.value));

// ─── Record data point ────────────────────────────────────────────────────────
function showFeedback(msg, type) {
  elFeedback.textContent = msg;
  elFeedback.className   = 'record-feedback ' + type;
  clearTimeout(showFeedback._t);
  showFeedback._t = setTimeout(() => {
    elFeedback.className = 'record-feedback hidden';
  }, 3500);
}

elBtnRecord.addEventListener('click', () => {
  if (currentSpeed === null) {
    showFeedback('GPS not active — start GPS first.', 'error');
    return;
  }

  const twa = TARGET_ANGLES[angleIndex];
  const tws = safeFloat(elTwsNum.value, 0.1, 60);

  if (tws === null) {
    showFeedback('Enter a valid wind speed (0.1–60 kts).', 'error');
    return;
  }

  const bsp = parseFloat(currentSpeed.toFixed(2));

  dataPoints.push({
    twa,
    tws,
    bsp,
    time: new Date().toLocaleTimeString(),
  });

  saveData();
  renderTable();
  drawPolar();

  showFeedback(
    `Saved — TWA ${twa}° / TWS ${tws} kts / BSP ${bsp} kts`,
    'success'
  );

  // Return to instruction view, advance to next angle if possible
  cancelConfirm();
  if (angleIndex < TARGET_ANGLES.length - 1) {
    angleIndex++;
    renderAngleInstruction();
  }
});

// ─── Table ────────────────────────────────────────────────────────────────────
function renderTable() {
  elCount.textContent = dataPoints.length;

  if (dataPoints.length === 0) {
    elTableBody.innerHTML =
      '<tr class="empty-row"><td colspan="6">No data yet. Start GPS and follow the sailing instructions.</td></tr>';
    return;
  }

  // Build table using safe values only; all strings are escaped
  const rows = dataPoints.map((p, i) => [
    '<tr>',
    `<td>${i + 1}</td>`,
    `<td>${p.twa}°</td>`,
    `<td>${p.tws}</td>`,
    `<td>${p.bsp}</td>`,
    `<td>${escHtml(p.time)}</td>`,   // ← only user-ish string; escaped
    `<td><button class="delete-btn" data-i="${i}" title="Delete">&#x2715;</button></td>`,
    '</tr>',
  ].join(''));

  elTableBody.innerHTML = rows.join('');

  elTableBody.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.i, 10);
      if (idx >= 0 && idx < dataPoints.length) {
        dataPoints.splice(idx, 1);
        saveData();
        renderTable();
        drawPolar();
      }
    });
  });
}

// ─── Polar chart ──────────────────────────────────────────────────────────────
const ctx = elCanvas.getContext('2d');

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const logical = 520;
  elCanvas.width  = logical * dpr;
  elCanvas.height = logical * dpr;
  elCanvas.style.width  = logical + 'px';
  elCanvas.style.height = logical + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

setupCanvas();
window.addEventListener('resize', () => { setupCanvas(); drawPolar(); });

function drawPolar() {
  const dpr = window.devicePixelRatio || 1;
  const W = elCanvas.width  / dpr;
  const H = elCanvas.height / dpr;
  const cx = W / 2;
  const cy = 30;
  const showLabels = elToggleLabels.checked;
  const showPoints = elTogglePoints.checked;

  ctx.clearRect(0, 0, W, H);

  const maxBsp = Math.max(8, ...dataPoints.map(p => p.bsp)) * 1.15;
  const maxR   = Math.min(W / 2 - 24, H - cy - 24);

  function polarToXY(angleDeg, bsp) {
    const r   = (bsp / maxBsp) * maxR;
    const rad = (angleDeg - 90) * (Math.PI / 180);
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  // Grid rings
  const rings = 4;
  for (let i = 1; i <= rings; i++) {
    const r     = (i / rings) * maxR;
    const label = ((i / rings) * maxBsp).toFixed(1);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth   = 1;
    ctx.stroke();

    if (showLabels) {
      ctx.fillStyle   = '#94a3b8';
      ctx.font        = '11px system-ui';
      ctx.textAlign   = 'center';
      ctx.fillText(label + ' kts', cx, cy + r + 12);
    }
  }

  // Spokes
  const spokes = [0, 30, 45, 60, 90, 120, 135, 150, 180];
  spokes.forEach(a => {
    const end = polarToXY(a, maxBsp);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth   = 1;
    ctx.stroke();

    if (showLabels) {
      const lbl = polarToXY(a, maxBsp * 1.09);
      ctx.fillStyle    = '#64748b';
      ctx.font         = '11px system-ui';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a + '°', lbl.x, lbl.y);
    }
  });

  // Group by TWS bucket
  const groups = {};
  dataPoints.forEach(p => {
    const b = twsBucket(p.tws);
    if (!groups[b]) groups[b] = [];
    groups[b].push(p);
  });

  const twsGroups = Object.keys(groups).map(Number).sort((a, b) => a - b);

  // Legend
  elLegend.innerHTML = twsGroups.map(tws => {
    const color = TWS_COLORS[tws] || DEFAULT_COLOR;
    return `<div class="legend-item">
      <span class="legend-dot" style="background:${color}"></span>
      TWS ~${tws} kts
    </div>`;
  }).join('');

  // Draw polar curves
  twsGroups.forEach(tws => {
    const pts   = groups[tws];
    const color = TWS_COLORS[tws] || DEFAULT_COLOR;

    // Best BSP per 5° bucket
    const bucket = 5;
    const best   = {};
    pts.forEach(p => {
      const b = Math.round(p.twa / bucket) * bucket;
      if (!best[b] || p.bsp > best[b]) best[b] = p.bsp;
    });

    const sorted = Object.keys(best).map(Number).sort((a, b) => a - b);

    if (sorted.length >= 2) {
      ctx.beginPath();
      sorted.forEach((angle, idx) => {
        const { x, y } = polarToXY(angle, best[angle]);
        if (idx === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2.5;
      ctx.lineJoin    = 'round';
      ctx.stroke();
    }

    if (showPoints) {
      pts.forEach(p => {
        const { x, y } = polarToXY(p.twa, p.bsp);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle   = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth   = 1.5;
        ctx.stroke();
      });
    }
  });

  // Highlight the current target angle
  const currentTwa = TARGET_ANGLES[angleIndex];
  const spokeEnd   = polarToXY(currentTwa, maxBsp);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(spokeEnd.x, spokeEnd.y);
  ctx.strokeStyle = '#3b9ae1';
  ctx.lineWidth   = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (showLabels) {
    const l = polarToXY(currentTwa, maxBsp * 1.09);
    ctx.fillStyle    = '#3b9ae1';
    ctx.font         = 'bold 11px system-ui';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▶ ' + currentTwa + '°', l.x, l.y);
  }

  // Wind label
  ctx.fillStyle    = '#94a3b8';
  ctx.font         = 'bold 11px system-ui';
  ctx.textAlign    = 'center';
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
  const rows   = dataPoints
    .map(p => [p.twa, p.tws, p.bsp, p.time.replace(/[,\r\n]/g, ' ')].join(','))
    .join('\n');

  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `polar_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Import CSV ───────────────────────────────────────────────────────────────
elBtnImportLabel.addEventListener('click', () => elBtnImport.click());

elBtnImport.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  // Reject suspiciously large files (>1 MB)
  if (file.size > 1_000_000) {
    alert('File too large (max 1 MB).');
    e.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = ev => {
    const lines    = ev.target.result.split('\n').filter(l => l.trim());
    let   imported = 0;

    lines.slice(1).forEach(line => {
      // Only split on the first 3 commas; treat the rest as the time field
      const parts = line.split(',');
      const twa   = safeFloat(parts[0], 0,   180);
      const tws   = safeFloat(parts[1], 0.1, 60);
      const bsp   = safeFloat(parts[2], 0,   50);

      if (twa === null || tws === null || bsp === null) return;

      // Sanitize the time string: allow only safe characters
      const rawTime = (parts[3] || '').trim();
      const time    = rawTime.replace(/[^0-9:APMapm\s]/g, '').slice(0, 20) || '(imported)';

      dataPoints.push({ twa, tws, bsp, time });
      imported++;
    });

    if (imported > 0) {
      saveData();
      renderTable();
      drawPolar();
      alert(`Imported ${imported} data point(s).`);
    } else {
      alert('No valid data found. Expected columns: TWA_deg, TWS_kts, BSP_kts, Time');
    }
  };

  reader.readAsText(file);
  e.target.value = '';
});

// ─── Boat Background ──────────────────────────────────────────────────────────
const BOAT_STORAGE_KEY = 'polar_boat_bg';

// Only allow images from Wikimedia servers or local data URIs
function isAllowedImageUrl(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith('data:image/')) return true;
  try {
    const u = new URL(url);
    return ['upload.wikimedia.org', 'commons.wikimedia.org'].includes(u.hostname);
  } catch { return false; }
}

// Pick the best (largest) image from a Wikipedia page summary response
function getBestWikiImageUrl(data) {
  const orig  = data.originalimage?.source;
  const thumb = data.thumbnail?.source;
  const candidate = orig || thumb;
  if (!candidate || !isAllowedImageUrl(candidate)) return null;
  return candidate;
}

// Search Wikipedia and Wikimedia Commons for a boat photo.
// Returns the first usable image URL, or null if nothing found.
async function searchBoatImage(boatName) {
  const enc = encodeURIComponent(boatName);

  // 1. Direct Wikipedia page summary (fastest path)
  try {
    const r = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${enc}`
    );
    if (r.ok) {
      const url = getBestWikiImageUrl(await r.json());
      if (url) return url;
    }
  } catch {}

  // 2. Wikipedia search → check top results for an image
  try {
    const r = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${enc}+sailboat&format=json&origin=*&srlimit=5`
    );
    if (r.ok) {
      const results = (await r.json())?.query?.search || [];
      for (const result of results) {
        try {
          const s = await fetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(result.title)}`
          );
          if (s.ok) {
            const url = getBestWikiImageUrl(await s.json());
            if (url) return url;
          }
        } catch {}
      }
    }
  } catch {}

  // 3. Wikimedia Commons image file search
  try {
    const r = await fetch(
      `https://commons.wikimedia.org/w/api.php?action=query` +
      `&generator=search&gsrsearch=${enc}+sailboat&gsrnamespace=6` +
      `&prop=imageinfo&iiprop=url&format=json&origin=*&gsrlimit=5`
    );
    if (r.ok) {
      const pages = (await r.json())?.query?.pages || {};
      for (const page of Object.values(pages)) {
        const url = page.imageinfo?.[0]?.url;
        if (url && isAllowedImageUrl(url) && /\.(jpe?g|png|webp)$/i.test(url)) {
          return url;
        }
      }
    }
  } catch {}

  return null;
}

// Resize an uploaded photo to max 1280px wide and re-encode as JPEG for storage efficiency
function resizeForStorage(dataUrl, callback) {
  const img = new Image();
  img.onload = () => {
    const MAX = 1280;
    const scale = img.width > MAX ? MAX / img.width : 1;
    const c = document.createElement('canvas');
    c.width  = Math.round(img.width  * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    callback(c.toDataURL('image/jpeg', 0.82));
  };
  img.onerror = () => callback(dataUrl); // fall back to original on error
  img.src = dataUrl;
}

// ── Boat bg DOM refs ──────────────────────────────────────────────────────────
const elBoatBg         = document.getElementById('boat-bg');
const elBoatModal      = document.getElementById('boat-modal');
const elBoatNameInput  = document.getElementById('boat-name-input');
const elBoatStatus     = document.getElementById('boat-search-status');
const elBtnBoatOpen    = document.getElementById('btn-boat-setup');
const elBtnBoatSearch  = document.getElementById('btn-boat-search');
const elBtnBoatClear   = document.getElementById('btn-boat-clear');
const elBtnBoatCancel  = document.getElementById('btn-boat-cancel');
const elBoatPhotoInput = document.getElementById('boat-photo-input');
const elBoatBadge      = document.getElementById('boat-name-badge');

function setBoatBackground(imageUrl, boatName) {
  // Escape any double-quotes in the URL before putting it in a CSS url()
  elBoatBg.style.backgroundImage = `url("${imageUrl.replace(/"/g, '%22')}")`;
  elBoatBg.classList.add('active');
  document.body.classList.add('has-boat-bg');

  const label = boatName ? escHtml(boatName) : '';
  elBoatBadge.textContent = label;
  elBoatBadge.classList.toggle('hidden', !label);

  try {
    localStorage.setItem(BOAT_STORAGE_KEY, JSON.stringify({ url: imageUrl, name: boatName || '' }));
  } catch {
    // Storage quota exceeded (common with large data-URL photos) — only keep in-memory
  }
}

function clearBoatBackground() {
  elBoatBg.style.backgroundImage = '';
  elBoatBg.classList.remove('active');
  document.body.classList.remove('has-boat-bg');
  elBoatBadge.textContent = '';
  elBoatBadge.classList.add('hidden');
  localStorage.removeItem(BOAT_STORAGE_KEY);
}

function loadBoatBackground() {
  try {
    const raw = localStorage.getItem(BOAT_STORAGE_KEY);
    if (!raw) return;
    const { url, name } = JSON.parse(raw);
    if (isAllowedImageUrl(url)) setBoatBackground(url, name);
  } catch {}
}

function openBoatModal() {
  elBoatModal.classList.remove('hidden');
  elBoatNameInput.focus();
}

function closeBoatModal() {
  elBoatModal.classList.add('hidden');
  elBoatStatus.textContent = '';
  elBoatStatus.className = 'boat-search-status';
}

elBtnBoatOpen.addEventListener('click', openBoatModal);
elBtnBoatCancel.addEventListener('click', closeBoatModal);
elBoatModal.addEventListener('click', e => { if (e.target === elBoatModal) closeBoatModal(); });

elBoatNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  elBtnBoatSearch.click();
  if (e.key === 'Escape') closeBoatModal();
});

elBtnBoatClear.addEventListener('click', () => {
  clearBoatBackground();
  closeBoatModal();
});

// Online image search
elBtnBoatSearch.addEventListener('click', async () => {
  const raw = elBoatNameInput.value.trim();
  if (!raw) return;
  const boatName = raw.replace(/[<>"'&]/g, '').slice(0, 80);
  if (!boatName) return;

  elBoatStatus.className = 'boat-search-status searching';
  elBoatStatus.textContent = `Searching for "${boatName}"…`;
  elBtnBoatSearch.disabled = true;

  try {
    const url = await searchBoatImage(boatName);
    if (url) {
      setBoatBackground(url, boatName);
      elBoatStatus.className = 'boat-search-status success';
      elBoatStatus.textContent = '✓ Background set!';
      setTimeout(closeBoatModal, 1200);
    } else {
      elBoatStatus.className = 'boat-search-status error';
      elBoatStatus.textContent = 'No image found — try a more specific model name.';
    }
  } catch {
    elBoatStatus.className = 'boat-search-status error';
    elBoatStatus.textContent = 'Search failed. Check your connection and try again.';
  } finally {
    elBtnBoatSearch.disabled = false;
  }
});

// Local photo upload
elBoatPhotoInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    elBoatStatus.className = 'boat-search-status error';
    elBoatStatus.textContent = 'Please select an image file.';
    e.target.value = '';
    return;
  }
  if (file.size > 25_000_000) {
    elBoatStatus.className = 'boat-search-status error';
    elBoatStatus.textContent = 'File too large (max 25 MB).';
    e.target.value = '';
    return;
  }

  elBoatStatus.className = 'boat-search-status searching';
  elBoatStatus.textContent = 'Loading photo…';

  const reader = new FileReader();
  reader.onload = ev => {
    const raw = ev.target.result;
    if (typeof raw !== 'string' || !raw.startsWith('data:image/')) {
      elBoatStatus.className = 'boat-search-status error';
      elBoatStatus.textContent = 'Could not read the image file.';
      return;
    }
    resizeForStorage(raw, dataUrl => {
      const displayName = file.name.replace(/\.[^.]+$/, '');
      setBoatBackground(dataUrl, displayName);
      elBoatStatus.className = 'boat-search-status success';
      elBoatStatus.textContent = '✓ Background set!';
      openBoatModal(); // keep modal visible so status is seen
      setTimeout(closeBoatModal, 1400);
    });
  };
  reader.onerror = () => {
    elBoatStatus.className = 'boat-search-status error';
    elBoatStatus.textContent = 'Failed to read file.';
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// ─── Init ─────────────────────────────────────────────────────────────────────
dataPoints = loadData();
loadBoatBackground();
renderAngleInstruction();
updateConfirmButton();
renderTable();
drawPolar();
