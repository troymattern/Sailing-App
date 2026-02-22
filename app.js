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
 *
 * Features:
 *   - Multiple sail-config sessions with compare mode
 *   - Catmull-Rom smooth polar curves
 *   - Cloud backup via JSON export/import
 *   - Boat background photo (search or upload)
 *   - Offline-capable via Service Worker
 */

// ─── Security helpers ─────────────────────────────────────────────────────────

/** Escape HTML special characters to prevent XSS when inserting into innerHTML. */
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

/** Generate a short random ID. */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Legacy key — kept only for migrating old single-session data
const LEGACY_KEY       = 'polar_data_points';
const SESSIONS_KEY     = 'polar_sessions_v2';
const ACTIVE_KEY       = 'polar_active_session';
const BOAT_STORAGE_KEY = 'polar_boat_bg';

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

const COLOR_PALETTES = {
  ocean: { 6:'#06b6d4', 8:'#3b82f6', 10:'#8b5cf6', 12:'#22c55e', 16:'#f59e0b', 20:'#ef4444', 25:'#ec4899' },
  warm:  { 6:'#f97316', 8:'#ef4444', 10:'#f59e0b', 12:'#dc2626', 16:'#ea580c', 20:'#b45309', 25:'#fbbf24' },
  mono:  { 6:'rgba(255,255,255,0.40)', 8:'rgba(255,255,255,0.55)', 10:'rgba(255,255,255,0.65)', 12:'rgba(255,255,255,0.75)', 16:'rgba(255,255,255,0.83)', 20:'rgba(255,255,255,0.90)', 25:'rgba(255,255,255,0.96)' },
  neon:  { 6:'#00ff88', 8:'#00f5ff', 10:'#f0ff00', 12:'#ff00f5', 16:'#ff8800', 20:'#ff0055', 25:'#8800ff' },
};

function twsBucket(tws) {
  const standards = Object.keys(TWS_COLORS).map(Number);
  return standards.reduce((prev, cur) =>
    Math.abs(cur - tws) < Math.abs(prev - tws) ? cur : prev
  );
}

// ─── State ────────────────────────────────────────────────────────────────────
let sessions        = [];          // array of { id, name, createdAt, dataPoints }
let activeSessionId = null;
let dataPoints      = [];          // always mirrors activeSession.dataPoints
let showCompare     = false;       // overlay all sessions on the chart
let smoothCurves    = true;        // use Catmull-Rom interpolation

let gpsWatchId   = null;
let currentSpeed = null;           // knots from GPS
let angleIndex   = 4;              // default: 90° (0-based index into TARGET_ANGLES)
let confirmed    = false;          // has the user confirmed they are at the target angle?

let curveIntensity  = 1.0;         // multiplier for polar curve line width (0.5–2.0)
let currentPalette  = 'ocean';     // active colour palette key

// ─── Session management ───────────────────────────────────────────────────────

function createSession(name) {
  return {
    id:         generateId(),
    name:       (name || 'Session 1').slice(0, 50),
    createdAt:  new Date().toISOString(),
    dataPoints: [],
  };
}

function getActiveSession() {
  return sessions.find(s => s.id === activeSessionId) || sessions[0];
}

/** Validate and sanitize a single data point. Mutates the object in place. */
function validatePoint(p) {
  const twa = safeFloat(p.twa, 0, 180);
  const tws = safeFloat(p.tws, 0.1, 100);
  const bsp = safeFloat(p.bsp, 0,   50);
  if (twa === null || tws === null || bsp === null) return false;
  p.twa  = twa;
  p.tws  = tws;
  p.bsp  = bsp;
  p.time = typeof p.time === 'string'
    ? p.time.replace(/[<>"'&]/g, '').slice(0, 30)
    : '--';
  return true;
}

function sanitiseSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id   = typeof raw.id   === 'string' ? raw.id.slice(0, 40)   : generateId();
  const name = typeof raw.name === 'string' ? raw.name.replace(/[<>"'&]/g, '').slice(0, 50) : 'Unnamed';
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 30) : new Date().toISOString();
  const dataPoints = Array.isArray(raw.dataPoints)
    ? raw.dataPoints.filter(p => validatePoint(p))
    : [];
  return { id, name, createdAt, dataPoints };
}

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const valid = parsed.map(sanitiseSession).filter(Boolean);
        if (valid.length > 0) {
          sessions = valid;
          return;
        }
      }
    }
  } catch {}

  // Migrate from old single-session format
  try {
    const oldRaw = localStorage.getItem(LEGACY_KEY);
    if (oldRaw) {
      const oldPoints = JSON.parse(oldRaw);
      if (Array.isArray(oldPoints) && oldPoints.length > 0) {
        const migrated = createSession('Main + Genoa');
        migrated.dataPoints = oldPoints.filter(p => validatePoint(p));
        sessions = [migrated];
        return;
      }
    }
  } catch {}

  sessions = [createSession('Main + Genoa')];
}

function saveSessions() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  } catch {
    // Storage quota exceeded — not fatal
  }
}

/** Backward-compat shim used throughout the original code. */
function saveData() { saveSessions(); }

function switchSession(id) {
  const target = sessions.find(s => s.id === id);
  if (!target) return;
  activeSessionId = id;
  dataPoints      = target.dataPoints;
  try { localStorage.setItem(ACTIVE_KEY, id); } catch {}
  renderSessionSelector();
  renderTable();
  drawPolar();
}

function renderSessionSelector() {
  const sel = elSessionSelect;
  sel.innerHTML = '';
  sessions.forEach(s => {
    const opt = document.createElement('option');
    opt.value       = s.id;
    opt.textContent = s.name;
    opt.selected    = s.id === activeSessionId;
    sel.appendChild(opt);
  });
}

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
const elToggleLabels  = document.getElementById('toggle-labels');
const elTogglePoints  = document.getElementById('toggle-points');
const elToggleSmooth  = document.getElementById('toggle-smooth');
const elToggleCompare = document.getElementById('toggle-compare');
const elBtnClear    = document.getElementById('btn-clear-chart');
const elBtnExport   = document.getElementById('btn-export');
const elBtnImport   = document.getElementById('btn-import');
const elBtnImportLabel = document.getElementById('btn-import-label');

// Session bar refs
const elSessionSelect   = document.getElementById('session-select');
const elBtnNewSession   = document.getElementById('btn-new-session');
const elBtnRenameSession = document.getElementById('btn-rename-session');
const elBtnDeleteSession = document.getElementById('btn-delete-session');
const elOnlineDot       = document.getElementById('online-dot');
const elOnlineLabel     = document.getElementById('online-label');

// Session modal refs
const elSessionModal        = document.getElementById('session-modal');
const elSessionModalTitle   = document.getElementById('session-modal-title');
const elSessionNameInput    = document.getElementById('session-name-input');
const elSessionModalStatus  = document.getElementById('session-modal-status');
const elBtnSessionConfirm   = document.getElementById('btn-session-confirm');
const elBtnSessionCancel    = document.getElementById('btn-session-cancel');

// JSON backup refs
const elBtnExportJson      = document.getElementById('btn-export-json');
const elBtnImportJsonLabel = document.getElementById('btn-import-json-label');
const elBtnImportJson      = document.getElementById('btn-import-json');

// Boat background refs
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

// ─── GPS ──────────────────────────────────────────────────────────────────────
function metersPerSecondToKnots(mps) {
  return mps * 1.94384;
}

function setGpsStatus(state, text) {
  elDot.className     = 'status-dot ' + state;
  elLabel.textContent = text;
}

function onGpsSuccess(pos) {
  const { speed, heading, accuracy } = pos.coords;

  currentSpeed = (speed !== null && speed >= 0)
    ? metersPerSecondToKnots(speed)
    : 0;

  elSpeed.textContent    = currentSpeed.toFixed(1);
  elHeading.textContent  = heading  !== null ? Math.round(heading)  : '---';
  elAccuracy.textContent = accuracy !== null ? Math.round(accuracy) : '---';
  setGpsStatus('active', 'GPS active');
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
    gpsWatchId     = null;
    currentSpeed   = null;
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
  elTargetTwa.textContent  = twa;
  elAngleDesc.textContent  = angleDescription(twa);
  elAngleIndex.textContent = angleIndex + 1;
  elAngleTotal.textContent = TARGET_ANGLES.length;
  elBtnPrev.disabled       = angleIndex === 0;
  elBtnNext.disabled       = angleIndex === TARGET_ANGLES.length - 1;
  elConfirmLabel.textContent = twa;
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

  dataPoints.push({ twa, tws, bsp, time: new Date().toLocaleTimeString() });

  saveData();
  renderTable();
  drawPolar();

  showFeedback(`Saved — TWA ${twa}° / TWS ${tws} kts / BSP ${bsp} kts`, 'success');

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

  const rows = dataPoints.map((p, i) => [
    '<tr>',
    `<td>${i + 1}</td>`,
    `<td>${p.twa}°</td>`,
    `<td>${p.tws}</td>`,
    `<td>${p.bsp}</td>`,
    `<td>${escHtml(p.time)}</td>`,
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
  const dpr     = window.devicePixelRatio || 1;
  const logical = 520;
  elCanvas.width  = logical * dpr;
  elCanvas.height = logical * dpr;
  elCanvas.style.width  = logical + 'px';
  elCanvas.style.height = logical + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

setupCanvas();
window.addEventListener('resize', () => { setupCanvas(); drawPolar(); });

/**
 * Draw a Catmull-Rom spline through the given Cartesian points.
 * Converts to cubic Bézier segments — smooth but passes through every point.
 * Tension is fixed at 0.5 (standard Catmull-Rom).
 */
function drawCatmullRom(ctx2d, pts) {
  if (pts.length < 2) return;
  if (pts.length === 2) {
    ctx2d.moveTo(pts[0].x, pts[0].y);
    ctx2d.lineTo(pts[1].x, pts[1].y);
    return;
  }

  ctx2d.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    // Catmull-Rom → Bézier control points
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    ctx2d.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
  }
}

function drawPolar() {
  const dpr = window.devicePixelRatio || 1;
  const W   = elCanvas.width  / dpr;
  const H   = elCanvas.height / dpr;
  const cx  = W / 2;
  const cy  = 30;

  const showLabels = elToggleLabels.checked;
  const showPoints = elTogglePoints.checked;

  ctx.clearRect(0, 0, W, H);

  // Determine which sessions to render
  const sessionsToRender = showCompare ? sessions : [getActiveSession()];

  // Gather all BSP values across rendered sessions for scale
  const allBsp = sessionsToRender.flatMap(s => s.dataPoints.map(p => p.bsp));
  const maxBsp = Math.max(8, ...allBsp) * 1.15;
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
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    if (showLabels) {
      ctx.fillStyle   = 'rgba(255,255,255,0.50)';
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
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    if (showLabels) {
      const lbl = polarToXY(a, maxBsp * 1.09);
      ctx.fillStyle    = 'rgba(255,255,255,0.60)';
      ctx.font         = '11px system-ui';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a + '°', lbl.x, lbl.y);
    }
  });

  // Build legend entries
  const legendParts = [];

  // Draw polar curves for each rendered session
  sessionsToRender.forEach((session, sessionIdx) => {
    const isActive  = session.id === activeSessionId;
    const opacity   = showCompare && !isActive ? 0.45 : 1.0;
    const lineWidth = isActive ? 2.5 : 1.8;
    const useDash   = showCompare && !isActive;

    const groups = {};
    session.dataPoints.forEach(p => {
      const b = twsBucket(p.tws);
      if (!groups[b]) groups[b] = [];
      groups[b].push(p);
    });

    const twsGroups = Object.keys(groups).map(Number).sort((a, b) => a - b);

    twsGroups.forEach(tws => {
      const pts   = groups[tws];
      const color = TWS_COLORS[tws] || DEFAULT_COLOR;

      // Best BSP per 5° angle bucket
      const bucketSize = 5;
      const best       = {};
      pts.forEach(p => {
        const b = Math.round(p.twa / bucketSize) * bucketSize;
        if (!best[b] || p.bsp > best[b]) best[b] = p.bsp;
      });

      const sorted = Object.keys(best).map(Number).sort((a, b) => a - b);

      if (sorted.length >= 2) {
        const cartesian = sorted.map(angle => polarToXY(angle, best[angle]));

        ctx.save();
        ctx.globalAlpha = opacity;
        if (useDash) ctx.setLineDash([5, 3]);
        ctx.beginPath();
        if (smoothCurves && sorted.length >= 3) {
          drawCatmullRom(ctx, cartesian);
        } else {
          ctx.moveTo(cartesian[0].x, cartesian[0].y);
          cartesian.slice(1).forEach(pt => ctx.lineTo(pt.x, pt.y));
        }
        ctx.strokeStyle = color;
        ctx.lineWidth   = lineWidth * Math.max(0.5, curveIntensity);
        ctx.lineJoin    = 'round';
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      if (showPoints) {
        ctx.save();
        ctx.globalAlpha = opacity;
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
        ctx.restore();
      }

      if (!legendParts.find(l => l.tws === tws)) {
        legendParts.push({ tws, color });
      }
    });
  });

  // Legend
  legendParts.sort((a, b) => a.tws - b.tws);
  elLegend.innerHTML = legendParts.map(({ tws, color }) =>
    `<div class="legend-item">
      <span class="legend-dot" style="background:${escHtml(color)}"></span>
      TWS ~${tws} kts
    </div>`
  ).join('');

  if (showCompare && sessions.length > 1) {
    const sessionLabels = sessions.map((s, i) => {
      const dash = s.id !== activeSessionId ? '(dashed)' : '(solid)';
      return `<div class="legend-item legend-session">${escHtml(s.name)} ${dash}</div>`;
    }).join('');
    elLegend.innerHTML += `<div class="legend-session-list">${sessionLabels}</div>`;
  }

  // Highlight current target angle
  const currentTwa = TARGET_ANGLES[angleIndex];
  const spokeEnd   = polarToXY(currentTwa, maxBsp);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(spokeEnd.x, spokeEnd.y);
  ctx.strokeStyle = '#5ac8fa';
  ctx.lineWidth   = 2;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  if (showLabels) {
    const l = polarToXY(currentTwa, maxBsp * 1.09);
    ctx.fillStyle    = '#5ac8fa';
    ctx.font         = 'bold 11px system-ui';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('▶ ' + currentTwa + '°', l.x, l.y);
  }

  // Wind label
  ctx.fillStyle    = 'rgba(255,255,255,0.45)';
  ctx.font         = 'bold 11px system-ui';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText('WIND', cx, cy + 2);
}

// ─── Chart controls ───────────────────────────────────────────────────────────
elToggleLabels.addEventListener('change', drawPolar);
elTogglePoints.addEventListener('change', drawPolar);

elToggleSmooth.addEventListener('change', () => {
  smoothCurves = elToggleSmooth.checked;
  drawPolar();
});

elToggleCompare.addEventListener('change', () => {
  showCompare = elToggleCompare.checked;
  drawPolar();
});

elBtnClear.addEventListener('click', () => {
  if (!confirm('Delete all data points in this sail configuration?')) return;
  const session = getActiveSession();
  session.dataPoints = [];
  dataPoints = session.dataPoints;
  saveData();
  renderTable();
  drawPolar();
});

// ─── Session bar controls ─────────────────────────────────────────────────────
let sessionModalMode = 'new'; // 'new' | 'rename'

function openSessionModal(mode, defaultName = '') {
  sessionModalMode = mode;
  elSessionModalTitle.textContent = mode === 'rename' ? 'Rename Configuration' : 'New Sail Configuration';
  elSessionNameInput.value = defaultName;
  elSessionModalStatus.textContent = '';
  elSessionModalStatus.className = 'boat-search-status';
  elSessionModal.classList.remove('hidden');
  elSessionNameInput.focus();
}

function closeSessionModal() {
  elSessionModal.classList.add('hidden');
}

elSessionSelect.addEventListener('change', () => {
  switchSession(elSessionSelect.value);
});

elBtnNewSession.addEventListener('click', () => openSessionModal('new'));

elBtnRenameSession.addEventListener('click', () => {
  const current = getActiveSession();
  openSessionModal('rename', current ? current.name : '');
});

elBtnDeleteSession.addEventListener('click', () => {
  if (sessions.length <= 1) {
    alert('You need at least one sail configuration.');
    return;
  }
  const session = getActiveSession();
  if (!confirm(`Delete "${session.name}" and all its data points?`)) return;
  sessions = sessions.filter(s => s.id !== activeSessionId);
  saveData();
  switchSession(sessions[0].id);
});

elBtnSessionConfirm.addEventListener('click', () => {
  const raw  = elSessionNameInput.value.trim();
  const name = raw.replace(/[<>"'&]/g, '').slice(0, 50);
  if (!name) {
    elSessionModalStatus.className   = 'boat-search-status error';
    elSessionModalStatus.textContent = 'Please enter a name.';
    return;
  }

  if (sessionModalMode === 'new') {
    const session = createSession(name);
    sessions.push(session);
    saveData();
    switchSession(session.id);
  } else {
    const session = getActiveSession();
    if (session) {
      session.name = name;
      saveData();
      renderSessionSelector();
    }
  }
  closeSessionModal();
});

elBtnSessionCancel.addEventListener('click', closeSessionModal);
elSessionModal.addEventListener('click', e => { if (e.target === elSessionModal) closeSessionModal(); });
elSessionNameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  elBtnSessionConfirm.click();
  if (e.key === 'Escape') closeSessionModal();
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
      const parts = line.split(',');
      const twa   = safeFloat(parts[0], 0,   180);
      const tws   = safeFloat(parts[1], 0.1, 60);
      const bsp   = safeFloat(parts[2], 0,   50);
      if (twa === null || tws === null || bsp === null) return;

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

// ─── Cloud Backup — JSON export (all sessions) ────────────────────────────────
elBtnExportJson.addEventListener('click', () => {
  const payload = {
    version:   2,
    exportedAt: new Date().toISOString(),
    sessions,
  };
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `polar_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ─── Cloud Backup — JSON import (restore all sessions) ────────────────────────
elBtnImportJsonLabel.addEventListener('click', () => elBtnImportJson.click());

elBtnImportJson.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > 5_000_000) {
    alert('File too large (max 5 MB).');
    e.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const data = JSON.parse(ev.target.result);

      // Accept v2 format (sessions array) or a bare sessions array
      const rawSessions = data.version === 2 && Array.isArray(data.sessions)
        ? data.sessions
        : Array.isArray(data) ? data : null;

      if (!rawSessions) throw new Error('Unrecognised backup format');

      const restored = rawSessions.map(sanitiseSession).filter(Boolean);
      if (restored.length === 0) throw new Error('No valid sessions found');

      if (!confirm(`This will replace all ${sessions.length} current configuration(s) with ${restored.length} from the backup. Continue?`)) {
        return;
      }

      sessions = restored;
      saveData();
      switchSession(sessions[0].id);
      alert(`Restored ${sessions.length} sail configuration(s).`);
    } catch (err) {
      alert(`Restore failed: ${err.message}`);
    }
  };

  reader.readAsText(file);
  e.target.value = '';
});

// ─── Online / offline indicator ───────────────────────────────────────────────
function updateOnlineStatus() {
  const online = navigator.onLine;
  elOnlineDot.classList.toggle('offline', !online);
  elOnlineLabel.textContent = online ? 'Online' : 'Offline';
}
window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ─── Background Transparency Control ─────────────────────────────────────────
const elBgOpacityCtrl   = document.getElementById('bg-opacity-ctrl');
const elBtnOpacityToggle = document.getElementById('btn-opacity-toggle');
const elOpacitySliderWrap = document.getElementById('opacity-slider-wrap');
const elBgOpacitySlider  = document.getElementById('bg-opacity-slider');
const elBtnOpacityClose  = document.getElementById('btn-opacity-close');

const BG_OPACITY_KEY = 'polar_bg_opacity';

/** Apply the current slider value (10–100) as CSS brightness + opacity on #boat-bg. */
function applyBgOpacity(value) {
  // value 10 → very dark/transparent; 100 → fullest brightness we allow (0.90)
  const brightness = (value / 100) * 0.90;
  elBoatBg.style.filter = `brightness(${brightness.toFixed(2)})`;
  try { localStorage.setItem(BG_OPACITY_KEY, String(value)); } catch {}
}

function loadBgOpacity() {
  try {
    const saved = localStorage.getItem(BG_OPACITY_KEY);
    if (saved !== null) {
      const v = parseInt(saved, 10);
      if (v >= 10 && v <= 100) {
        elBgOpacitySlider.value = v;
        applyBgOpacity(v);
        return;
      }
    }
  } catch {}
  // Default: 55 (≈ brightness 0.495, close to the original hardcoded 0.55)
  elBgOpacitySlider.value = 55;
  applyBgOpacity(55);
}

function showOpacityControl(visible) {
  elBgOpacityCtrl.classList.toggle('hidden', !visible);
}

elBtnOpacityToggle.addEventListener('click', () => {
  const sliderHidden = elOpacitySliderWrap.classList.contains('hidden');
  elOpacitySliderWrap.classList.toggle('hidden', !sliderHidden);
});

elBtnOpacityClose.addEventListener('click', () => {
  elOpacitySliderWrap.classList.add('hidden');
});

elBgOpacitySlider.addEventListener('input', () => {
  applyBgOpacity(Number(elBgOpacitySlider.value));
});

// ─── Boat Background ──────────────────────────────────────────────────────────

const ALLOWED_IMAGE_HOSTS = ['upload.wikimedia.org', 'commons.wikimedia.org'];

function isAllowedImageUrl(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith('data:image/')) return true;
  try {
    const u = new URL(url);
    return ALLOWED_IMAGE_HOSTS.includes(u.hostname);
  } catch { return false; }
}

function getBestWikiImageUrl(data) {
  const orig  = data.originalimage?.source;
  const thumb = data.thumbnail?.source;
  const url   = orig || thumb;
  return (url && isAllowedImageUrl(url)) ? url : null;
}

async function searchBoatImage(boatName) {
  const enc = encodeURIComponent(boatName);

  // 1. Direct Wikipedia page summary
  try {
    const r = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${enc}`);
    if (r.ok) {
      const url = getBestWikiImageUrl(await r.json());
      if (url) return url;
    }
  } catch {}

  // 2. Wikipedia text search → check each result's summary
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

/** Resize an uploaded image to ≤1280 px wide and re-encode as JPEG for storage efficiency. */
function resizeForStorage(dataUrl, callback) {
  const img = new Image();
  img.onload = () => {
    const MAX   = 1280;
    const scale = img.width > MAX ? MAX / img.width : 1;
    const c     = document.createElement('canvas');
    c.width  = Math.round(img.width  * scale);
    c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    callback(c.toDataURL('image/jpeg', 0.82));
  };
  img.onerror = () => callback(dataUrl); // fall back to original on error
  img.src = dataUrl;
}

function setBoatBackground(imageUrl, boatName) {
  elBoatBg.style.backgroundImage = `url("${imageUrl.replace(/"/g, '%22')}")`;
  elBoatBg.classList.add('active');
  document.body.classList.add('has-boat-bg');
  showOpacityControl(true);
  loadBgOpacity();

  const label = boatName ? escHtml(boatName) : '';
  elBoatBadge.textContent = label;
  elBoatBadge.classList.toggle('hidden', !label);

  try {
    localStorage.setItem(BOAT_STORAGE_KEY, JSON.stringify({ url: imageUrl, name: boatName || '' }));
  } catch {}
}

function clearBoatBackground() {
  elBoatBg.style.backgroundImage = '';
  elBoatBg.style.filter          = '';
  elBoatBg.classList.remove('active');
  document.body.classList.remove('has-boat-bg');
  elBoatBadge.textContent = '';
  elBoatBadge.classList.add('hidden');
  showOpacityControl(false);
  elOpacitySliderWrap.classList.add('hidden');
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
  elBoatStatus.className   = 'boat-search-status';
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

elBtnBoatSearch.addEventListener('click', async () => {
  const raw      = elBoatNameInput.value.trim();
  const boatName = raw.replace(/[<>"'&]/g, '').slice(0, 80);
  if (!boatName) return;

  elBoatStatus.className   = 'boat-search-status searching';
  elBoatStatus.textContent = `Searching for "${boatName}"…`;
  elBtnBoatSearch.disabled = true;

  try {
    const url = await searchBoatImage(boatName);
    if (url) {
      setBoatBackground(url, boatName);
      elBoatStatus.className   = 'boat-search-status success';
      elBoatStatus.textContent = '✓ Background set!';
      setTimeout(closeBoatModal, 1200);
    } else {
      elBoatStatus.className   = 'boat-search-status error';
      elBoatStatus.textContent = 'No image found — try a more specific model name.';
    }
  } catch {
    elBoatStatus.className   = 'boat-search-status error';
    elBoatStatus.textContent = 'Search failed. Check your connection and try again.';
  } finally {
    elBtnBoatSearch.disabled = false;
  }
});

elBoatPhotoInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;

  if (!file.type.startsWith('image/')) {
    elBoatStatus.className   = 'boat-search-status error';
    elBoatStatus.textContent = 'Please select an image file.';
    e.target.value = '';
    return;
  }
  if (file.size > 25_000_000) {
    elBoatStatus.className   = 'boat-search-status error';
    elBoatStatus.textContent = 'File too large (max 25 MB).';
    e.target.value = '';
    return;
  }

  elBoatStatus.className   = 'boat-search-status searching';
  elBoatStatus.textContent = 'Loading photo…';

  const reader = new FileReader();
  reader.onload = ev => {
    const raw = ev.target.result;
    if (typeof raw !== 'string' || !raw.startsWith('data:image/')) {
      elBoatStatus.className   = 'boat-search-status error';
      elBoatStatus.textContent = 'Could not read the image file.';
      return;
    }
    resizeForStorage(raw, dataUrl => {
      const displayName = file.name.replace(/\.[^.]+$/, '');
      setBoatBackground(dataUrl, displayName);
      elBoatStatus.className   = 'boat-search-status success';
      elBoatStatus.textContent = '✓ Background set!';
      openBoatModal(); // keep modal visible so the status message is seen
      setTimeout(closeBoatModal, 1400);
    });
  };
  reader.onerror = () => {
    elBoatStatus.className   = 'boat-search-status error';
    elBoatStatus.textContent = 'Failed to read file.';
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

// ─── Service Worker registration ──────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // SW registration failure is non-fatal; app works online without it
    });
  });
}

// ─── Color Settings ───────────────────────────────────────────────────────────
const COLOR_SETTINGS_KEY = 'polar_color_settings';

const elColorModal       = document.getElementById('color-modal');
const elBtnColorSettings = document.getElementById('btn-color-settings');
const elBtnColorClose    = document.getElementById('btn-color-close');
const elBtnColorReset    = document.getElementById('btn-color-reset');
const elTextBrightness   = document.getElementById('text-brightness-slider');
const elPanelOpacity     = document.getElementById('panel-opacity-slider');
const elCurveIntensity   = document.getElementById('curve-intensity-slider');

function applyColorSettings({ textBrightness, panelOpacity, curveIntensity: ci, palette } = {}) {
  if (textBrightness !== undefined) {
    // Slider 0 (Dim) → 0.55 alpha, Slider 100 (Bright) → 0.95 alpha
    const alpha = 0.55 + (textBrightness / 100) * 0.40;
    document.documentElement.style.setProperty('--text', `rgba(255,255,255,${alpha.toFixed(2)})`);
    elTextBrightness.value = textBrightness;
  }
  if (panelOpacity !== undefined) {
    // Slider 20 (See-through) → alpha 0.04, Slider 100 (Solid) → alpha 0.26
    const alpha = 0.04 + ((panelOpacity - 20) / 80) * 0.22;
    document.documentElement.style.setProperty('--panel-bg', `rgba(255,255,255,${alpha.toFixed(3)})`);
    elPanelOpacity.value = panelOpacity;
  }
  if (ci !== undefined) {
    curveIntensity = 0.5 + (ci / 200);
    elCurveIntensity.value = ci;
  }
  if (palette && COLOR_PALETTES[palette]) {
    currentPalette = palette;
    Object.assign(TWS_COLORS, COLOR_PALETTES[palette]);
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === palette);
    });
  }
}

function saveColorSettings() {
  const settings = {
    textBrightness: parseInt(elTextBrightness.value, 10),
    panelOpacity:   parseInt(elPanelOpacity.value,   10),
    curveIntensity: parseInt(elCurveIntensity.value,  10),
    palette:        currentPalette,
  };
  try { localStorage.setItem(COLOR_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function loadColorSettings() {
  try {
    const raw = localStorage.getItem(COLOR_SETTINGS_KEY);
    if (raw) applyColorSettings(JSON.parse(raw));
  } catch {}
}

elBtnColorSettings.addEventListener('click', () => {
  elColorModal.classList.remove('hidden');
});

function closeColorModal() {
  elColorModal.classList.add('hidden');
  saveColorSettings();
  drawPolar();
}

elBtnColorClose.addEventListener('click', closeColorModal);
elColorModal.addEventListener('click', e => { if (e.target === elColorModal) closeColorModal(); });

elBtnColorReset.addEventListener('click', () => {
  document.documentElement.style.removeProperty('--text');
  document.documentElement.style.removeProperty('--panel-bg');
  curveIntensity = 1.0;
  currentPalette = 'ocean';
  Object.assign(TWS_COLORS, COLOR_PALETTES.ocean);
  elTextBrightness.value  = 0;
  elPanelOpacity.value    = 100;
  elCurveIntensity.value  = 100;
  document.querySelectorAll('.theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === 'ocean');
  });
  drawPolar();
  try { localStorage.removeItem(COLOR_SETTINGS_KEY); } catch {}
});

elTextBrightness.addEventListener('input', () => {
  const alpha = 0.55 + (parseInt(elTextBrightness.value, 10) / 100) * 0.40;
  document.documentElement.style.setProperty('--text', `rgba(255,255,255,${alpha.toFixed(2)})`);
});

elPanelOpacity.addEventListener('input', () => {
  const alpha = 0.04 + ((parseInt(elPanelOpacity.value, 10) - 20) / 80) * 0.22;
  document.documentElement.style.setProperty('--panel-bg', `rgba(255,255,255,${alpha.toFixed(3)})`);
});

elCurveIntensity.addEventListener('input', () => {
  curveIntensity = 0.5 + (parseInt(elCurveIntensity.value, 10) / 200);
  drawPolar();
});

document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const theme = btn.dataset.theme;
    if (!COLOR_PALETTES[theme]) return;
    currentPalette = theme;
    Object.assign(TWS_COLORS, COLOR_PALETTES[theme]);
    document.querySelectorAll('.theme-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === theme);
    });
    drawPolar();
  });
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadSessions();

// Restore previously active session (or default to first)
const savedActiveId = (() => {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
})();
activeSessionId = sessions.find(s => s.id === savedActiveId) ? savedActiveId : sessions[0].id;
dataPoints      = getActiveSession().dataPoints;

loadBoatBackground();
loadColorSettings();
updateOnlineStatus();
renderSessionSelector();
renderAngleInstruction();
updateConfirmButton();
renderTable();
drawPolar();
