const canvas = document.getElementById('game');
// The play area's HEIGHT adapts to the phone's actual screen — width stays
// fixed at 360 (every lane/desk/keyboard coordinate below is tuned for
// that width), but on a tall Android screen we now use the extra vertical
// room instead of leaving empty space above and below a fixed 480px box.
// This also means more fall distance = more reaction time on tall phones.
(function sizeCanvasToScreen() {
  const RESERVED_CHROME = 180; // header + HUD + hint text + laptop bezel padding
  const availableH = window.innerHeight - RESERVED_CHROME;
  const targetH = Math.round(Math.max(480, Math.min(760, availableH)));
  canvas.width = 360;
  canvas.height = targetH;
})();
const ctx = canvas.getContext('2d');
const W = canvas.width, H = canvas.height;
const LANE_W = W / 2;
const SCREEN_BOTTOM = H - 110;   // where the laptop "screen" content ends
const ZONE_Y = SCREEN_BOTTOM - 60; // crash line, raised up for more reaction room
const SPAWN_Y = 30;
const BUG_R = 15; // bigger hit target for direct tapping

const RANKS = [
  { min: 0, name: 'Junior Debugger' },
  { min: 15, name: 'Mid-level Fixer' },
  { min: 35, name: 'Senior Bug Hunter' },
  { min: 60, name: 'Principal Exterminator' },
  { min: 100, name: 'Legendary 10x Engineer' },
];

const CODE_SNIPPETS = [
  'const x = fetch(url)', 'if (user.isValid) {', 'return data.map(i =>',
  'let sum = a + b;', 'export default App', 'try { await run() }',
  'for (let i=0;i<n;i++)', 'class Bug extends Err', 'console.log(state)',
  'npm install lodash', 'git commit -m "fix"', '// TODO: refactor this',
];

let bugs, particles, score, combo, bestCombo, highScore;
let menuShownOnce = false; // after the first visit, skip the staggered entrance animation
let baseSpeed, spawnTimer, spawnInterval, running, lastTime;
let playerName = '';
let codeOffset = 0;
let bugIdCounter = 0;
let typeWobble = 0;
let spidersSeen = false;
let trapsSeen = false;

// Smooth difficulty curve tuning — pure functions of score, no step jumps.
const SPEED_PER_POINT = 0.028;
const MAX_SPEED = 3.4;
const START_SPAWN_INTERVAL = 1400;
const MIN_SPAWN_INTERVAL = 420;
const INTERVAL_PER_POINT = 8;
let rescueCharged = false;
const RESCUE_THRESHOLD = 8;
// Counts squashes toward the NEXT Ctrl+Z charge. Kept separate from the
// on-screen combo counter so the "every 8 hits" rule repeats identically
// every time — it resets to 0 the moment a charge is granted (and again
// when it's spent, and when a trap hit breaks the combo) instead of
// depending on the ever-growing combo number, which only lined up with
// the threshold the first time it was reached.
let rescueProgress = 0;

/* ---------------- AUDIO (synthesized, no files needed) ---------------- */
let audioCtx = null;
let muted = false;
let hapticsEnabled = true;

/* ---------------- HAPTICS ----------------
   navigator.vibrate() is the standard web API and already works inside
   an Android WebView (Capacitor's default webview included). When this
   project moves to Capacitor, swap the body of vibrate() for
   Haptics.impact({ style: ... }) from @capacitor/haptics — every call
   site below stays the same. */
function vibrate(pattern) {
  if (!hapticsEnabled) return;
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch (e) { /* unsupported device/browser — fail silently */ }
}
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function playSquash() {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(700, t);
  osc.frequency.exponentialRampToValueAtTime(180, t + 0.09);
  gain.gain.setValueAtTime(0.15, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.11);
}
function playTrapHit() {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(160, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.18);
  gain.gain.setValueAtTime(0.18, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.2);
}
function playRescue() {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(900, t + 0.25);
  gain.gain.setValueAtTime(0.001, t);
  gain.gain.linearRampToValueAtTime(0.18, t + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.3);
}
function playCrash() {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(40, t + 0.45);
  gain.gain.setValueAtTime(0.22, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.5);

  const osc2 = audioCtx.createOscillator();
  const gain2 = audioCtx.createGain();
  osc2.type = 'square';
  osc2.frequency.setValueAtTime(90, t);
  gain2.gain.setValueAtTime(0.12, t);
  gain2.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
  osc2.connect(gain2); gain2.connect(audioCtx.destination);
  osc2.start(t); osc2.stop(t + 0.25);
}
function playCombo() {
  if (!audioCtx || muted) return;
  const t = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(1400, t + 0.08);
  gain.gain.setValueAtTime(0.1, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(t); osc.stop(t + 0.13);
}

/* ---------------- SUPABASE (shared leaderboard) ----------------
   This is the only part of the game that needs to work across every
   visitor's browser, so it can't use localStorage (that's per-device).
   Fill SUPABASE_URL and SUPABASE_ANON_KEY in with your own free
   Supabase project's values — see README.md for the setup steps.
   Until they're filled in, the leaderboard screen shows a setup
   notice instead of crashing, and the rest of the game is unaffected. */
const SUPABASE_URL = "https://gdvqfbvpsoaytydxecrj.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkdnFmYnZwc29heXR5ZHhlY3JqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4ODQ3MzcsImV4cCI6MjEwMTQ2MDczN30.ajXc1w4QVIvTnEaT_La9p4oNAEaLr5Iuq0QiR8vrPms";
const supabaseIsConfigured = SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';
let db = null;
let dbInitError = null; // TEMP DIAGNOSTIC: surfaced on the leaderboard screen so we
                         // can see the real failure reason on devices without devtools.
if (supabaseIsConfigured) {
  try {
    if (typeof supabase === 'undefined') {
      throw new Error('supabase-js library did not load (window.supabase is undefined)');
    }
    const { createClient } = supabase;
    db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (e) {
    db = null;
    dbInitError = (e && e.message) ? e.message : String(e);
  }
}

/* ---------------- RANK / STORAGE ---------------- */
function currentRank(s) {
  let r = RANKS[0].name;
  for (const rk of RANKS) if (s >= rk.min) r = rk.name;
  return r;
}
function updateRankUI() { document.getElementById('rank').textContent = currentRank(score); }

// Fills the three profile-style stat cards at the top of the main menu
// (name / best score / rank). Called every time the menu screen is
// shown — including right after a run ends and the player backs out —
// so a new high score or a name typed for the first time shows up
// immediately without needing a page reload.
function updateMenuHUD() {
  const nameEl = document.getElementById('menuPlayerName');
  const highScoreEl = document.getElementById('menuHighScore');
  const rankEl = document.getElementById('menuRank');
  if (nameEl) {
    if (playerName) {
      nameEl.textContent = playerName;
      nameEl.classList.remove('empty');
    } else {
      nameEl.textContent = 'بدون نام';
      nameEl.classList.add('empty');
    }
  }
  if (highScoreEl) highScoreEl.textContent = highScore || 0;
  if (rankEl) rankEl.textContent = currentRank(highScore || 0);
}

/* High score is per-device only, so it lives in localStorage — a
   standard browser API that works the same on every static host. */
async function loadHighScore() {
  try { highScore = parseInt(localStorage.getItem('bug-squasher-highscore'), 10) || 0; }
  catch (e) { highScore = 0; }
  document.getElementById('highscore').textContent = highScore;
}
async function saveHighScoreIfNeeded() {
  if (score > highScore) {
    highScore = score;
    document.getElementById('highscore').textContent = highScore;
    try { localStorage.setItem('bug-squasher-highscore', String(highScore)); } catch (e) {}
  }
}

/* ---------------- PLAYER NAME (per-device) ---------------- */
async function loadPlayerName() {
  try { playerName = localStorage.getItem('player-name') || ''; }
  catch (e) { playerName = ''; }
  document.getElementById('nameInput').value = playerName;
}
async function savePlayerName(name) {
  playerName = name;
  try { localStorage.setItem('player-name', name); } catch (e) {}
}

/* ---------------- LEADERBOARD (shared, via Supabase) ----------------
   Each player's best score lives in one row keyed by their normalized
   name, so re-submitting only overwrites the score column when it's a
   new personal best. total_bugs, however, is a running lifetime sum —
   every session adds to it regardless of whether it beat the record.
   NOTE: requires a `total_bugs` integer column (default 0) on the
   `leaderboard` table — see README.md for the migration SQL. */
function leaderboardKeyFor(name) {
  return name.trim().toLowerCase();
}
async function syncPlayerStats(name, sessionScore) {
  if (!db || !name) return null;
  try {
    // Score submission goes through the `submit_score` Postgres function
    // (SECURITY DEFINER) instead of writing to the `leaderboard` table
    // directly. The table's RLS policy only allows SELECT for anon/public,
    // so this RPC call is the only way to write a score — and the function
    // itself re-validates the name and score range server-side. This closes
    // off direct-write score injection via the exposed anon key.
    const { data, error } = await db.rpc('submit_score', {
      p_name: name.trim(),
      p_score: sessionScore
    });
    if (error) throw error;
    return data; // new total_bugs, returned by the function
  } catch (e) {
    return null; // best-effort, never blocks the game
  }
}

async function fetchLeaderboardEntries() {
  if (!db) throw new Error('Supabase is not configured yet');
  const { data, error } = await db
    .from('leaderboard')
    .select('name, score')
    .order('score', { ascending: false })
    .limit(50);
  if (error) throw error;
  return data || [];
}

/* Converts Latin digits to Persian digits for display — used only in
   user-facing leaderboard text, not the monospace/LTR gameplay HUD,
   which intentionally keeps its terminal-style Latin digits. */
function toFaDigits(input) {
  const fa = ['۰','۱','۲','۳','۴','۵','۶','۷','۸','۹'];
  return String(input).replace(/[0-9]/g, (d) => fa[d]);
}

/* Exact rank/score for the current player, independent of the top-50
   list — fixes the previous bug where a player ranked outside the
   fetched top 50 was incorrectly told "no score yet". Also returns the
   nearest entry above them, so the UI can show "N points to pass X". */
async function fetchMyStanding(name) {
  if (!db || !name) return null;
  const key = leaderboardKeyFor(name);
  try {
    const { data: mine } = await db
      .from('leaderboard')
      .select('score')
      .eq('name_key', key)
      .maybeSingle();
    if (!mine) return null;
    const { count } = await db
      .from('leaderboard')
      .select('*', { count: 'exact', head: true })
      .gt('score', mine.score);
    const rank = (count || 0) + 1;
    let next = null;
    if (rank > 1) {
      const { data: above } = await db
        .from('leaderboard')
        .select('name, score')
        .gt('score', mine.score)
        .order('score', { ascending: true })
        .limit(1);
      next = (above && above[0]) || null;
    }
    return { rank, score: mine.score, next };
  } catch (e) {
    return null;
  }
}

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
function renderLeaderboardRow(entry, rank, isMe) {
  const row = document.createElement('div');
  row.className = 'lb-row' + (isMe ? ' me' : '') + (rank <= 3 ? ' top' + rank : '');
  const rankLabel = MEDALS[rank] || ('#' + toFaDigits(rank));
  row.innerHTML =
    '<span class="rk">' + rankLabel + '</span>' +
    '<span class="nm"></span>' +
    '<span class="sc">' + toFaDigits(entry.score) + '</span>';
  row.querySelector('.nm').textContent = entry.name;
  return row;
}

async function openLeaderboard() {
  showScreen('leaderboard');
  const listEl = document.getElementById('lbList');
  const youEl = document.getElementById('lbYou');
  youEl.style.display = 'none';

  if (!db) {
    const reason = dbInitError ? ('<br><span style="font-size:10px;opacity:.7;direction:ltr;display:inline-block;margin-top:6px">' + dbInitError + '</span>') : '';
    listEl.innerHTML = '<div class="lb-empty">اتصال به سرور جدول امتیازات برقرار نشد.' + reason + '</div>';
    return;
  }

  listEl.innerHTML = '<div class="lb-empty">در حال بارگذاری...</div>';

  let entries = [];
  try {
    entries = await fetchLeaderboardEntries();
  } catch (e) {
    const detail = (e && (e.message || e.error_description || e.details)) || String(e);
    console.error('Leaderboard fetch failed:', e);
    listEl.innerHTML =
      '<div class="lb-empty">مشکلی در بارگذاری جدول پیش اومد.<br>' +
      '<span style="font-family:\'JetBrains Mono\',monospace; font-size:11px; color:#e06c6c; word-break:break-word;">' +
      detail.replace(/[<>]/g, '') + '</span></div>';
    return;
  }

  if (entries.length === 0) {
    listEl.innerHTML = '<div class="lb-empty">هنوز کسی امتیازی ثبت نکرده. اولین نفر باش!</div>';
    return;
  }

  const myKey = playerName ? leaderboardKeyFor(playerName) : null;
  listEl.innerHTML = '';
  let myRank = null;
  entries.forEach((entry, i) => {
    const rank = i + 1;
    const isMe = myKey && leaderboardKeyFor(entry.name) === myKey;
    if (isMe) myRank = rank;
    listEl.appendChild(renderLeaderboardRow(entry, rank, isMe));
  });

  if (!playerName) return;

  const standing = await fetchMyStanding(playerName);
  if (!standing) {
    youEl.textContent = 'هنوز امتیازی برای «' + playerName + '» ثبت نشده. یه دور بازی کن!';
    youEl.style.display = 'block';
    return;
  }

  const rankLabel = MEDALS[standing.rank] || ('#' + toFaDigits(standing.rank));
  let html = '<div class="lb-you-row"><span class="rk">' + rankLabel + '</span>' +
    '<span class="nm">تو</span><span class="sc">' + toFaDigits(standing.score) + '</span></div>';
  if (standing.next) {
    const gap = standing.next.score - standing.score;
    html += '<div class="lb-you-gap">«' + toFaDigits(gap) + '» امتیاز تا عبور از ' + standing.next.name + '</div>';
  } else {
    html += '<div class="lb-you-gap">🔥 صدر جدولی، همینطور ادامه بده!</div>';
  }
  youEl.innerHTML = html;
  youEl.style.display = 'block';
}

/* ---------------- GAME LOGIC ---------------- */
function makeBug(side, y) {
  // Smooth, continuous ramp instead of a hard on/off switch — spiders start
  // appearing rarely from score 40 and become common by score ~90.
  const spiderChance = Math.min(0.3, Math.max(0, (score - 40) / 150));
  const isSpider = Math.random() < spiderChance;
  const isTrap = !isSpider && score >= 5 && Math.random() < 0.2;
  return {
    id: bugIdCounter++,
    side,
    y,
    squashed: false,
    wobble: Math.random() * 6.28,
    type: isTrap ? 'trap' : (isSpider ? 'spider' : 'ladybug'),
    r: isTrap ? 16 : (isSpider ? 19 : 15),
    speedMult: isTrap ? 0.85 : (isSpider ? 1.35 : 1),
    points: isSpider ? 3 : 1,
  };
}

function spawnBug() {
  const side = Math.random() < 0.5 ? 'left' : 'right';
  const bug = makeBug(side, SPAWN_Y);
  bugs.push(bug);
  if (bug.type === 'spider' && !spidersSeen) {
    spidersSeen = true;
    showToast('🕷️ عنکبوت سفید وارد شد!');
  }
  if (bug.type === 'trap' && !trapsSeen) {
    trapsSeen = true;
    showToast('✅ به تیک‌های سبز دست نزن — کد سالمه!');
  }
  if (score > 50 && Math.random() < 0.25) {
    const otherSide = side === 'left' ? 'right' : 'left';
    const bug2 = makeBug(otherSide, SPAWN_Y - 30);
    bugs.push(bug2);
    if (bug2.type === 'spider' && !spidersSeen) {
      spidersSeen = true;
      showToast('🕷️ عنکبوت سفید وارد شد!');
    }
    if (bug2.type === 'trap' && !trapsSeen) {
      trapsSeen = true;
      showToast('✅ به تیک‌های سبز دست نزن — کد سالمه!');
    }
  }
}

function bugPos(b) {
  const x = b.side === 'left' ? LANE_W / 2 : LANE_W + LANE_W / 2;
  return { x: x + Math.sin(b.wobble) * 6, y: b.y };
}

function addParticles(x, y, color, n = 10) {
  for (let i = 0; i < n; i++) {
    particles.push({ x, y, vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 1) * 4, life: 1, color });
  }
}

let toastTimeout;
function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 1600);
}

function updateComboDisplay(pulse, isReset) {
  const el = document.getElementById('combo');
  el.textContent = 'Combo x' + combo;
  if (pulse) {
    el.classList.add('pulse');
    clearTimeout(updateComboDisplay._pulseT);
    updateComboDisplay._pulseT = setTimeout(() => el.classList.remove('pulse'), 150);
  }
  if (isReset) {
    el.classList.add('reset');
    clearTimeout(updateComboDisplay._resetT);
    updateComboDisplay._resetT = setTimeout(() => el.classList.remove('reset'), 400);
  }
  if (combo >= 3) playCombo();
}

function squashBugAt(px, py) {
  if (!running) return;
  let target = null, bestDist = Infinity;
  for (const b of bugs) {
    if (b.squashed || b.y > SCREEN_BOTTOM) continue;
    const p = bugPos(b);
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < b.r + 10 && d < bestDist) { bestDist = d; target = b; }
  }
  if (!target) return;
  target.squashed = true;

  if (target.type === 'trap') {
    // Hitting a passing test / healthy code: punish, don't reward.
    combo = 0;
    rescueProgress = 0;
    if (rescueCharged) { rescueCharged = false; document.getElementById('rescueBtn').classList.remove('show'); }
    updateComboDisplay(false, true);
    const p = bugPos(target);
    addParticles(p.x, p.y, '#c0392b', 10);
    playTrapHit();
    vibrate(40);
    showToast('⚠️ این کد سالم بود! کامبو از دست رفت');
    flashDanger();
    return;
  }

  score += target.points;
  combo++; bestCombo = Math.max(bestCombo, combo);
  rescueProgress++;
  document.getElementById('score').textContent = score;
  updateRankUI();
  updateComboDisplay(true, false);
  vibrate(10);
  if (!rescueCharged && rescueProgress >= RESCUE_THRESHOLD) {
    rescueCharged = true;
    rescueProgress = 0;
    document.getElementById('rescueBtn').classList.add('show');
    showToast('🧹 Ctrl+Z آماده‌ست — صفحه رو پاک کن!');
    vibrate([0, 15, 60, 15]);
  }
  const p = bugPos(target);
  addParticles(p.x, p.y, target.type === 'spider' ? '#eeeeee' : '#4ec9b0', target.type === 'spider' ? 16 : 10);
  playSquash();

  // Smooth, continuous difficulty ramp — no sudden jumps, just a steady
  // linear increase in speed and spawn rate as score climbs.
  baseSpeed = Math.min(MAX_SPEED, score * SPEED_PER_POINT);
  spawnInterval = Math.max(MIN_SPAWN_INTERVAL, START_SPAWN_INTERVAL - score * INTERVAL_PER_POINT);
}

function flashDanger() {
  const flashEl = document.getElementById('flash');
  flashEl.classList.add('warn', 'on');
  setTimeout(() => flashEl.classList.remove('warn', 'on'), 300);
}

function flashRescue() {
  const flashEl = document.getElementById('flash');
  flashEl.classList.add('rescue', 'on');
  setTimeout(() => flashEl.classList.remove('rescue', 'on'), 350);
}

function performRescue() {
  if (!running || !rescueCharged) return;
  for (const b of bugs) {
    if (b.squashed) continue;
    const p = bugPos(b);
    addParticles(p.x, p.y, '#9cdcfe', 6);
  }
  bugs = [];
  rescueCharged = false;
  rescueProgress = 0;
  document.getElementById('rescueBtn').classList.remove('show');
  playRescue();
  vibrate([0, 20, 40, 20]);
  flashRescue();
  showToast('🧹 صفحه پاک شد!');
}

function crash() {
  running = false;
  saveHighScoreIfNeeded();
  playCrash();
  vibrate([0, 50, 40, 80]);
  const flashEl = document.getElementById('flash');
  flashEl.classList.add('on');
  setTimeout(() => flashEl.classList.remove('on'), 260);
  const laptop = document.getElementById('laptop');
  laptop.classList.add('shake');
  setTimeout(() => laptop.classList.remove('shake'), 300);

  const messages = [
    'Uncaught Bug: undefined is not a function',
    'Segmentation fault (core dumped)',
    'FATAL: ladybug injected into production',
    'RangeError: too many bugs to handle'
  ];
  document.getElementById('crashTitle').textContent = messages[Math.floor(Math.random()*messages.length)];
  document.getElementById('finalScoreDisplay').textContent = score;
  document.getElementById('bestScoreDisplay').textContent = highScore;
  document.getElementById('statBugs').textContent = score;
  document.getElementById('statCombo').textContent = bestCombo;
  document.getElementById('statRank').textContent = currentRank(score);

  // Total-bugs is a network round-trip, so it starts as a placeholder and
  // fills in a moment later — everything else on this screen is instant.
  const totalEl = document.getElementById('statTotalBugs');
  totalEl.textContent = db ? '…' : '—';
  syncPlayerStats(playerName, score).then(total => {
    totalEl.textContent = (total !== null) ? total : '—';
  });
  showScreen('result');
}

/* ---------------- DRAWING ---------------- */
function drawScreenContent() {
  // laptop screen area
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, W, SCREEN_BOTTOM);

  ctx.strokeStyle = '#333';
  ctx.beginPath(); ctx.moveTo(LANE_W, 0); ctx.lineTo(LANE_W, SCREEN_BOTTOM); ctx.stroke();

  ctx.font = '12px "JetBrains Mono", monospace';
  ctx.textBaseline = 'middle';
  const lineHeight = 26;
  const scrollSpeed = 0.6 + baseSpeed * 0.15;
  codeOffset = (codeOffset + scrollSpeed) % lineHeight;

  for (let lane = 0; lane < 2; lane++) {
    ctx.fillStyle = lane === 0 ? 'rgba(78,201,176,0.55)' : 'rgba(156,220,254,0.55)';
    const startX = lane === 0 ? 10 : LANE_W + 10;
    let idx = 0;
    for (let y = -lineHeight + codeOffset; y < SCREEN_BOTTOM; y += lineHeight) {
      ctx.fillText(CODE_SNIPPETS[(idx + lane * 3) % CODE_SNIPPETS.length], startX, y);
      idx++;
    }
  }

  ctx.strokeStyle = 'rgba(255,204,0,0.6)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(0, ZONE_Y); ctx.lineTo(W, ZONE_Y); ctx.stroke();
  ctx.setLineDash([]);
}

function drawBug(b) {
  if (b.type === 'spider') { drawSpider(b); return; }
  if (b.type === 'trap') { drawTrap(b); return; }
  const p = bugPos(b);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.fillStyle = '#c0392b';
  ctx.beginPath(); ctx.ellipse(0, 0, b.r * 0.8, b.r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#222';
  ctx.beginPath(); ctx.ellipse(0, -b.r * 0.7, b.r * 0.45, b.r * 0.4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, -b.r * 0.25); ctx.lineTo(0, b.r * 0.65); ctx.stroke();
  ctx.fillStyle = '#111';
  [[-3,-1],[3,-1],[-2.5,3],[2.5,3]].forEach(([sx,sy]) => {
    ctx.beginPath(); ctx.arc(sx, sy, 1.6, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();
}

function drawSpider(b) {
  const p = bugPos(b);
  const legPhase = Math.sin(b.wobble * 3) * 4;
  ctx.save();
  ctx.translate(p.x, p.y);

  // legs (4 per side), white with faint gray outline
  ctx.strokeStyle = '#f1f1f1';
  ctx.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    const angle = -0.9 + i * 0.6;
    const wob = (i % 2 === 0 ? legPhase : -legPhase);
    [-1, 1].forEach(dir => {
      ctx.beginPath();
      ctx.moveTo(0, -2);
      const kx = dir * (b.r * 0.5) * Math.cos(angle);
      const ky = -2 + b.r * 0.35 * Math.sin(angle) + wob * 0.3;
      const ex = dir * (b.r * 0.95) * Math.cos(angle);
      const ey = -2 + b.r * 0.75 * Math.sin(angle) + wob;
      ctx.quadraticCurveTo(kx, ky, ex, ey);
      ctx.stroke();
    });
  }

  // abdomen
  ctx.fillStyle = '#f5f5f5';
  ctx.beginPath(); ctx.ellipse(0, 4, b.r * 0.55, b.r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  // head/cephalothorax
  ctx.beginPath(); ctx.ellipse(0, -b.r * 0.35, b.r * 0.38, b.r * 0.32, 0, 0, Math.PI * 2); ctx.fill();
  // outline for visibility on light body
  ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1;
  ctx.stroke();
  // eyes (red, small)
  ctx.fillStyle = '#e74c3c';
  ctx.beginPath(); ctx.arc(-3, -b.r * 0.35, 1.6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(3, -b.r * 0.35, 1.6, 0, Math.PI * 2); ctx.fill();

  ctx.restore();
}

function drawTrap(b) {
  const p = bugPos(b);
  const pulse = 1 + Math.sin(b.wobble * 2) * 0.06;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.scale(pulse, pulse);

  const s = b.r * 1.05;
  ctx.shadowColor = 'rgba(78,201,176,0.65)';
  ctx.shadowBlur = 10;
  ctx.fillStyle = '#123b30';
  ctx.strokeStyle = '#4ec9b0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-s, -s, s * 2, s * 2, 6);
  else ctx.rect(-s, -s, s * 2, s * 2);
  ctx.fill();
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = '#4ec9b0';
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-s * 0.45, 0.05 * s);
  ctx.lineTo(-s * 0.1, s * 0.4);
  ctx.lineTo(s * 0.5, -s * 0.4);
  ctx.stroke();

  ctx.restore();
}

function drawParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.life -= dt / 400;
    if (p.life <= 0) { particles.splice(i, 1); continue; }
    ctx.globalAlpha = Math.max(p.life, 0);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    ctx.globalAlpha = 1;
  }
}

/* ---------------- RETRO PIXEL-ART PROGRAMMER SPRITE ---------------- */
// Built procedurally — rounded ellipse/trapezoid regions with 3-tone
// shading (base/shadow/highlight from a fixed light direction) plus edge
// dithering — instead of hand-placed flat rectangles. This is what gives
// a rounded, polished pixel-art look instead of a blocky silhouette,
// while still rendering at tiny native resolution and scaling up with
// smoothing OFF for the classic chunky 8-bit pop.
const SPR_W = 32, SPR_H = 40;
const spriteCanvas = document.createElement('canvas');
spriteCanvas.width = SPR_W; spriteCanvas.height = SPR_H;
const spriteCtx = spriteCanvas.getContext('2d');
spriteCtx.imageSmoothingEnabled = false;

const SPR_LIGHT = { x: 0.72, y: -0.68 }; // light source: upper-right
function sprHex(h) { const v = parseInt(h.slice(1), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
function sprShade(base, shadow, hi, nx, ny, x, y, hiT = 0.35, loT = -0.25, band = 0.07) {
  const f = nx * SPR_LIGHT.x + ny * SPR_LIGHT.y;
  if (f > hiT + band) return sprHex(hi);
  if (f > hiT - band) return ((x + y) % 2 === 0) ? sprHex(hi) : sprHex(base);
  if (f < loT - band) return sprHex(shadow);
  if (f < loT + band) return ((x + y) % 2 === 0) ? sprHex(shadow) : sprHex(base);
  return sprHex(base);
}

function drawProgrammerSprite(handStep) {
  const img = spriteCtx.createImageData(SPR_W, SPR_H);
  const d = img.data;
  function put(x, y, rgb) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || x >= SPR_W || y < 0 || y >= SPR_H) return;
    const i = (y * SPR_W + x) * 4;
    d[i] = rgb[0]; d[i + 1] = rgb[1]; d[i + 2] = rgb[2]; d[i + 3] = 255;
  }

  const hoodieBase = '#3b3b58', hoodieShadow = '#23233a', hoodieHi = '#57578c';
  const hairBase = '#2b1d14', hairShadow = '#1c130d', hairHi = '#4a331f';
  const skinBase = '#eab676', skinShadow = '#c98f56', skinHi = '#ffd9a0';
  const cupBase = '#e63946', cupShadow = '#b32635', cupHi = '#ff8a94';

  // hair — rounded ellipse, back of the head (no face = no facing ambiguity)
  const cx0 = 16, cy0 = 9, rx = 10, ry = 9;
  for (let y = 0; y <= 18; y++) {
    for (let x = 0; x < SPR_W; x++) {
      const nx = (x - cx0) / rx, ny = (y - cy0) / ry;
      if (nx * nx + ny * ny <= 1) put(x, y, sprShade(hairBase, hairShadow, hairHi, nx, ny, x, y));
    }
  }
  // headphone band arching over the top of the head
  for (let x = 6; x <= 26; x++) {
    const nx = (x - cx0) / (rx + 1);
    const yArc = cy0 - Math.sqrt(Math.max(0, 1 - nx * nx)) * (ry + 1);
    put(x, yArc, [21, 21, 21]);
    put(x, yArc + 1, [15, 15, 15]);
  }
  // ear cups
  [[7, 12], [25, 12]].forEach(([ccx, ccy]) => {
    for (let y = ccy - 4; y <= ccy + 4; y++) {
      for (let x = ccx - 3; x <= ccx + 3; x++) {
        const nx = (x - ccx) / 3, ny = (y - ccy) / 4;
        if (nx * nx + ny * ny <= 1) put(x, y, sprShade(cupBase, cupShadow, cupHi, nx, ny, x, y, 0.3, -0.2, 0.08));
      }
    }
  });

  // neck
  for (let y = 16; y <= 19; y++) {
    const hw = 3 - (y - 16) * 0.2;
    for (let x = 16 - hw; x <= 16 + hw; x++) {
      put(x, y, sprShade(skinBase, skinShadow, skinHi, (x - 16) / Math.max(hw, 0.6), 0.2, x, y));
    }
  }

  // hood collar (flares outward like real fabric)
  for (let y = 17; y <= 21; y++) {
    const hw = 9 + (y - 17) * 1.3;
    for (let x = 16 - hw; x <= 16 + hw; x++) {
      put(x, y, sprShade(hoodieBase, hoodieShadow, hoodieHi, (x - 16) / hw, (y - 19) / 4, x, y));
    }
  }

  // torso + center back seam
  for (let y = 21; y <= 34; y++) {
    const hw = 14 - Math.max(0, y - 29) * 0.55;
    for (let x = 16 - hw; x <= 16 + hw; x++) {
      const rgb = sprShade(hoodieBase, hoodieShadow, hoodieHi, (x - 16) / hw, (y - 27) / 7, x, y);
      put(x, y, Math.abs(x - 16) < 0.6 ? [rgb[0] - 22, rgb[1] - 22, rgb[2] - 22] : rgb);
    }
  }
  // hood drawstrings hanging down the back
  for (let y = 20; y <= 27; y++) {
    put(15, y, [16, 16, 26]);
    put(17.5, y, [16, 16, 26]);
  }

  // arms — angled inward toward the keyboard, connected to the torso —
  // plus hands that alternate up/down for the typing animation
  for (const side of [-1, 1]) {
    for (let y = 21; y <= 32; y++) {
      const t = (y - 21) / 11;
      const cxAtY = (16 + side * 15) + ((16 + side * 12.5) - (16 + side * 15)) * t;
      for (let dx = -2; dx <= 2; dx++) {
        const rel = dx * side;
        const rgb = rel < -1 ? sprHex(hoodieShadow) : rel > 1 ? sprHex(hoodieHi) : sprHex(hoodieBase);
        put(cxAtY + dx, y, rgb);
      }
    }
    const handX = 16 + side * 12.5;
    const handY = 34 + (side === -1 ? -handStep : handStep);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy <= 5.2) {
          const rgb = (dx + dy < -1) ? sprHex(skinHi) : (dx + dy > 1) ? sprHex(skinShadow) : sprHex(skinBase);
          put(handX + dx, handY + dy, rgb);
        }
      }
    }
  }

  spriteCtx.putImageData(img, 0, 0);
}

function drawDeskAndProgrammer() {
  // desk area below the screen
  const deskY = SCREEN_BOTTOM;
  const grad = ctx.createLinearGradient(0, deskY, 0, H);
  grad.addColorStop(0, '#3a2b20');
  grad.addColorStop(1, '#241a13');
  ctx.fillStyle = grad;
  ctx.fillRect(0, deskY, W, H - deskY);

  // keyboard hint (rows of keys)
  const kbX = W / 2 - 70, kbY = deskY + 14, kw = 140, kh = 34;
  ctx.fillStyle = '#111';
  ctx.fillRect(kbX, kbY, kw, kh);
  ctx.fillStyle = '#2a2a2a';
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 9; c++) {
      ctx.fillRect(kbX + 4 + c * 15, kbY + 4 + r * 10, 12, 7);
    }
  }

  // programmer character peeking from bottom
  const cx = W / 2;
  const bobStep = Math.round(Math.sin(typeWobble)) * 5; // discrete jump, retro-style idle bob
  const handStep = Math.floor(Math.abs(Math.sin(typeWobble * 2)) * 2); // 0,1,2 chunky steps

  // soft blue glow cast by the screen onto the character
  const glow = ctx.createRadialGradient(cx, deskY - 6, 4, cx, deskY - 6, 70);
  glow.addColorStop(0, 'rgba(120,180,255,0.28)');
  glow.addColorStop(1, 'rgba(120,180,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - 80, deskY - 40, 160, 110);

  drawProgrammerSprite(handStep);
  // SCALE + vertical offset are tuned so the sprite's hand-row lands
  // inside the keyboard's vertical band (kbY .. kbY+kh) instead of below
  // it — that gap below the keyboard was the "floating hands" problem.
  const SCALE = 3.75;
  const destW = SPR_W * SCALE, destH = SPR_H * SCALE;
  const destX = cx - destW / 2;
  const destY = deskY - 85 + bobStep;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(spriteCanvas, 0, 0, SPR_W, SPR_H, destX, destY, destW, destH);
  ctx.imageSmoothingEnabled = true;
}

/* ---------------- MAIN LOOP ---------------- */
function update(time = 0) {
  if (!running) return;
  const dt = Math.min(time - lastTime, 50);
  lastTime = time;
  typeWobble += dt / 250;

  spawnTimer += dt;
  if (spawnTimer > spawnInterval) { spawnTimer = 0; spawnBug(); }

  const speed = (0.9 + baseSpeed) * (dt / 16.6);
  for (const b of bugs) {
    if (b.squashed) continue;
    b.y += speed * b.speedMult;
    b.wobble += 0.15;
    if (b.y > SCREEN_BOTTOM - 6) {
      if (b.type === 'trap') { b.squashed = true; continue; } // safely avoided
      crash(); return;
    }
  }
  bugs = bugs.filter(b => !b.squashed);

  drawScreenContent();
  bugs.forEach(drawBug);
  drawParticles(dt);
  drawDeskAndProgrammer();

  requestAnimationFrame(update);
}

function getCanvasPos(evt) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = W / rect.width, scaleY = H / rect.height;
  const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
  const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

canvas.addEventListener('pointerdown', (e) => {
  ensureAudio();
  const pos = getCanvasPos(e);
  squashBugAt(pos.x, pos.y);
});

async function startGame() {
  bugs = []; particles = [];
  score = 0; combo = 0; bestCombo = 0;
  baseSpeed = 0; spawnTimer = 0; spawnInterval = 1400;
  lastTime = 0; typeWobble = 0;
  spidersSeen = false;
  trapsSeen = false;
  rescueCharged = false;
  rescueProgress = 0;
  document.getElementById('rescueBtn').classList.remove('show');
  document.getElementById('score').textContent = '0';
  updateComboDisplay(false, false);
  updateRankUI();
  await loadHighScore();
  running = true;
  requestAnimationFrame(update);
}

/* ---------------- PAUSE ----------------
   `running` already gates both the update() loop and the squash/rescue
   input handlers, so setting it to false is enough to freeze gameplay —
   we just also need to *not* run crash()'s game-over path. Because
   Math.min(time - lastTime, 50) already clamps elapsed time in update(),
   resuming after any pause length produces one normal-sized frame, no
   catch-up jump, no lastTime bookkeeping needed. */
function freezeGame() {
  if (running) running = false;
}
function resumeGame() {
  running = true;
  requestAnimationFrame(update);
}

/* ---------------- SCREEN STATE MACHINE ---------------- */
function showScreen(name) {
  document.getElementById('splashScreen').classList.remove('show');
  document.getElementById('menuScreen').classList.remove('show');
  document.getElementById('howtoScreen').classList.remove('show');
  document.getElementById('leaderboardScreen').classList.remove('show');
  document.getElementById('settingsScreen').classList.remove('show');
  document.getElementById('overlay').classList.remove('show');
  document.getElementById('gameplayUI').classList.remove('active');

  if (name === 'splash') document.getElementById('splashScreen').classList.add('show');
  if (name === 'menu') {
    const menuScreen = document.getElementById('menuScreen');
    // Only the very first time the menu appears (right after the splash)
    // should the buttons stagger in one by one — every later visit (e.g.
    // backing out of a run) should just show instantly, no replay of the
    // entrance animation.
    if (menuShownOnce) menuScreen.classList.add('no-stagger');
    menuShownOnce = true;
    updateMenuHUD();
    menuScreen.classList.add('show');
  }
  if (name === 'howto') document.getElementById('howtoScreen').classList.add('show');
  if (name === 'leaderboard') document.getElementById('leaderboardScreen').classList.add('show');
  if (name === 'settings') document.getElementById('settingsScreen').classList.add('show');
  if (name === 'playing') document.getElementById('gameplayUI').classList.add('active');
  if (name === 'result') {
    document.getElementById('gameplayUI').classList.add('active');
    document.getElementById('overlay').classList.add('show');
  }
}

async function beginPlaying() {
  ensureAudio();
  const nameField = document.getElementById('nameField');
  const nameVal = document.getElementById('nameInput').value.trim();
  if (!nameVal) {
    nameField.classList.add('error');
    document.getElementById('nameInput').focus();
    showScreen('menu');
    return;
  }
  nameField.classList.remove('error');
  await savePlayerName(nameVal);
  showScreen('playing');
  startGame();
}

/* ---------------- GAMEPLAY BOTTOM CONTROL BAR ---------------- */
document.getElementById('pauseBtn').addEventListener('click', () => {
  if (!running) return; // already paused/frozen via another dialog
  freezeGame();
  document.getElementById('pauseScreen').classList.add('show');
});
document.getElementById('resumeBtn').addEventListener('click', () => {
  document.getElementById('pauseScreen').classList.remove('show');
  resumeGame();
});
document.getElementById('pauseToMenuBtn').addEventListener('click', () => {
  document.getElementById('pauseScreen').classList.remove('show');
  showScreen('menu');
});

document.getElementById('backToMenuGameBtn').addEventListener('click', () => {
  freezeGame();
  document.getElementById('backConfirmScreen').classList.add('show');
});
document.getElementById('backConfirmCancelBtn').addEventListener('click', () => {
  document.getElementById('backConfirmScreen').classList.remove('show');
  resumeGame();
});
document.getElementById('backConfirmOkBtn').addEventListener('click', () => {
  document.getElementById('backConfirmScreen').classList.remove('show');
  showScreen('menu');
});

document.getElementById('ctrlExitBtn').addEventListener('click', () => {
  freezeGame();
  document.getElementById('exitHint').style.display = 'none';
  document.getElementById('exitScreen').classList.add('show');
});

// Every bottom-bar icon flashes its Persian label for a moment on tap,
// in addition to whatever action it performs.
document.querySelectorAll('.ctrl-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.classList.add('show-caption');
    clearTimeout(btn._capTimeout);
    btn._capTimeout = setTimeout(() => btn.classList.remove('show-caption'), 1500);
  });
});

document.getElementById('startBtn').addEventListener('click', beginPlaying);
document.getElementById('howToBtn').addEventListener('click', () => showScreen('howto'));
document.getElementById('howtoStartBtn').addEventListener('click', beginPlaying);
document.getElementById('howtoBackBtn').addEventListener('click', () => showScreen('menu'));
document.getElementById('replayBtn').addEventListener('click', beginPlaying);
document.getElementById('backToMenuBtn').addEventListener('click', () => showScreen('menu'));
document.getElementById('leaderboardBtn').addEventListener('click', openLeaderboard);
document.getElementById('resultLeaderboardBtn').addEventListener('click', openLeaderboard);
document.getElementById('lbBackBtn').addEventListener('click', () => showScreen('menu'));
document.getElementById('settingsBtn').addEventListener('click', () => showScreen('settings'));
document.getElementById('settingsBackBtn').addEventListener('click', () => showScreen('menu'));
document.getElementById('rescueBtn').addEventListener('click', performRescue);
const ICON_SOUND_ON = '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v4h3l4 3V4L6 7H3z"/><path d="M12.3 6a4 4 0 0 1 0 6"/><path d="M14.3 4a7 7 0 0 1 0 10" opacity="0.55"/></svg>';
const ICON_SOUND_OFF = '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v4h3l4 3V4L6 7H3z"/><line x1="12" y1="7" x2="16" y2="11"/><line x1="16" y1="7" x2="12" y2="11"/></svg>';
const ICON_VIB_ON = '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="6" height="12" rx="1.4"/><line x1="2.6" y1="6" x2="2.6" y2="12"/><line x1="15.4" y1="6" x2="15.4" y2="12"/></svg>';
const ICON_VIB_OFF = '<svg viewBox="0 0 18 18" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="3" width="6" height="12" rx="1.4"/><line x1="3.5" y1="15" x2="14.5" y2="3"/></svg>';

document.getElementById('soundBtn').addEventListener('click', () => {
  muted = !muted;
  document.getElementById('soundIcon').innerHTML = muted ? ICON_SOUND_OFF : ICON_SOUND_ON;
  document.getElementById('soundLabel').textContent = muted ? 'صدا: خاموش' : 'صدا: روشن';
  if (!muted) ensureAudio();
});
document.getElementById('hapticsBtn').addEventListener('click', () => {
  hapticsEnabled = !hapticsEnabled;
  document.getElementById('hapticsIcon').innerHTML = hapticsEnabled ? ICON_VIB_ON : ICON_VIB_OFF;
  document.getElementById('hapticsLabel').textContent = hapticsEnabled ? 'ویبره: روشن' : 'ویبره: خاموش';
  if (hapticsEnabled) vibrate(10); // quick confirmation buzz so it's obvious it's on
});
document.getElementById('nameInput').addEventListener('input', () => {
  document.getElementById('nameField').classList.remove('error');
});

/* ---------------- EXIT GAME ---------------- */
// Shown as its own overlay on top of the menu (not routed through
// showScreen, since that hides every other screen — this one should
// layer over whatever's already open).
document.getElementById('exitBtn').addEventListener('click', () => {
  document.getElementById('exitHint').style.display = 'none';
  document.getElementById('exitScreen').classList.add('show');
});
document.getElementById('exitCancelBtn').addEventListener('click', () => {
  document.getElementById('exitScreen').classList.remove('show');
  // If this was opened from the in-game control bar (gameplay still
  // "active" behind it, and frozen via freezeGame), resume on cancel.
  // Opened from the main menu, gameplayUI isn't active, so this no-ops.
  if (document.getElementById('gameplayUI').classList.contains('active') && !running) {
    resumeGame();
  }
});
document.getElementById('exitConfirmBtn').addEventListener('click', () => {
  // A web page can't force-quit itself — the exact hook depends on how
  // this build is packaged. Try the common Android WebView bridge
  // patterns first, then fall back to window.close() (works for a
  // window opened by script, e.g. a wrapper that opened this as a tab).
  try {
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
      window.Capacitor.Plugins.App.exitApp();
      return;
    }
    if (window.Android && typeof window.Android.exitApp === 'function') {
      window.Android.exitApp();
      return;
    }
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.exitApp) {
      window.webkit.messageHandlers.exitApp.postMessage('exit');
      return;
    }
  } catch (e) { /* no native bridge available — fall through */ }
  window.close();
  // Still here after a beat means neither the bridge nor window.close()
  // actually closed anything (most browsers block script-initiated close
  // on a tab they didn't open) — let the player know instead of silently
  // doing nothing. Shown inline in the card itself, since the toast
  // element lives inside the gameplay screen and isn't visible from the
  // menu.
  setTimeout(() => {
    document.getElementById('exitHint').style.display = 'block';
  }, 200);
});

// Splash: always shown for at least MIN_SPLASH_MS so the brand moment
// never flashes by instantly, but it hands off to the menu the moment
// real boot work (reading saved name + high score from localStorage)
// actually finishes — not a fixed delay disconnected from real work.
const MIN_SPLASH_MS = 500;
const splashStart = performance.now();
Promise.all([loadPlayerName(), loadHighScore()]).then(() => {
  const remaining = Math.max(0, MIN_SPLASH_MS - (performance.now() - splashStart));
  setTimeout(() => showScreen('menu'), remaining);
});
