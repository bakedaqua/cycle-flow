/* ============================================
   CycleFlow — Application Logic
   ============================================ */
;(function () {
  'use strict';

  // ---- Supabase Init ----
  const SUPABASE_URL = 'https://grtrfpiwvasncmxlpzyd.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_VM2XAuVUBpEgkdDNv0BnHQ_DmigRWSo';
  const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // ---- Auth & Sync State ----
  let currentUser = null;
  let partnerModeId = null;

  // ---- Constants ----
  const STORAGE_KEY = 'cycleflow_periods';
  const DEFAULT_CYCLE = 28;
  const DEFAULT_DURATION = 5;
  const OVULATION_OFFSET = 14; // days before next predicted period
  const FERTILE_WINDOW = 3;   // days before and after ovulation
  const ANOMALY_SHORT = 15;   // cycle < 15 days = abnormally short
  const ANOMALY_LONG  = 50;   // cycle > 50 days = abnormally long

  // ---- DOM Elements ----
  const $ = (sel) => document.querySelector(sel);
  const calendarDays = $('#calendarDays');
  const currentMonthLabel = $('#currentMonth');
  const prevMonthBtn = $('#prevMonth');
  const nextMonthBtn = $('#nextMonth');
  const historyList = $('#historyList');
  const todayBadgeText = $('#todayBadgeText');
  const avgCycleLengthEl = $('#avgCycleLength');
  const avgDurationEl = $('#avgDuration');
  const daysUntilNextEl = $('#daysUntilNext');
  const modalOverlay = $('#modalOverlay');
  const modalTitle = $('#modalTitle');
  const modalDate = $('#modalDate');
  const durationValue = $('#durationValue');
  const durationMinus = $('#durationMinus');
  const durationPlus = $('#durationPlus');
  const modalCancel = $('#modalCancel');
  const modalSave = $('#modalSave');
  const modalDelete = $('#modalDelete');
  const alertOverlay = $('#alertOverlay');
  const alertBox = $('#alertBox');
  const alertIcon = $('#alertIcon');
  const alertTitle = $('#alertTitle');
  const alertInterval = $('#alertInterval');
  const alertMessage = $('#alertMessage');
  const alertDismiss = $('#alertDismiss');

  // ---- Auth Elements ----
  const authEmail = $('#authEmail');
  const authPassword = $('#authPassword');
  const authError = $('#authError');
  const btnLogin = $('#btnLogin');
  const btnRegister = $('#btnRegister');
  const btnLogout = $('#btnLogout');
  const btnPartnerMode = $('#btnPartnerMode');

  // ---- State ----
  let viewYear, viewMonth; // currently displayed calendar month
  let selectedDate = null; // date string 'YYYY-MM-DD' for modal
  let editingIndex = -1;   // index in periods array if editing
  let currentDuration = DEFAULT_DURATION;

  // ---- Helpers ----
  function dateStr(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  }

  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  function diffDays(a, b) {
    return Math.round((a - b) / 86400000);
  }

  function formatDate(s) {
    const d = parseDate(s);
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  }

  function todayStr() {
    return dateStr(new Date());
  }

  // ---- Data Layer (LocalStorage & Sync) ----
  function getStorageKey() {
    return currentUser ? `cycleflow_periods_${currentUser.id}` : STORAGE_KEY;
  }

  function load() {
    try {
      const raw = localStorage.getItem(getStorageKey());
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  function save(periods) {
    if (partnerModeId) return; // Do not save partner data locally
    localStorage.setItem(getStorageKey(), JSON.stringify(periods));
  }

  function getPeriods() {
    if (partnerModeId) {
      const p = window._partnerPeriods || [];
      return p.slice().sort((a, b) => a.start.localeCompare(b.start));
    }
    const periods = load().filter(p => !p.deleted);
    periods.sort((a, b) => a.start.localeCompare(b.start));
    return periods;
  }

  async function syncPending() {
    if (!navigator.onLine || !currentUser) return;
    const local = load();
    for (let p of local) {
      if (p.deleted) {
        if (p.id) await supabase.from('cycles').delete().eq('id', p.id);
      } else if (p.pending) {
        if (p.id) {
          await supabase.from('cycles').update({ duration: p.duration }).eq('id', p.id);
        } else {
          await supabase.from('cycles').insert({ user_id: currentUser.id, start_date: p.start, duration: p.duration });
        }
      }
    }
  }

  async function syncFromCloud() {
    if (!navigator.onLine || !currentUser) return;
    if (!partnerModeId) {
      await syncPending();
    }
    const targetUserId = partnerModeId || currentUser.id;
    const { data, error } = await supabase.from('cycles').select('id, start_date, duration').eq('user_id', targetUserId);
    if (!error) {
      const mapped = data.map(c => ({ id: c.id, start: c.start_date, duration: c.duration }));
      if (partnerModeId) {
        window._partnerPeriods = mapped;
      } else {
        save(mapped); // Overwrites local with truth, clearing pending/deleted flags safely
      }
      refresh();
    }
  }

  // ---- Prediction Engine ----
  function computeStats(periods) {
    const stats = {
      avgCycle: DEFAULT_CYCLE,
      avgDuration: DEFAULT_DURATION,
      nextPredicted: null,
      ovulationDate: null,
      fertileStart: null,
      fertileEnd: null,
      daysUntilNext: null,
      predictedPeriodDays: [],  // set of 'YYYY-MM-DD' strings
      ovulationDays: [],
      fertileDays: [],
    };

    if (periods.length === 0) return stats;

    // Average duration
    const durations = periods.map(p => p.duration);
    stats.avgDuration = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

    // Cycle lengths (gaps between consecutive starts)
    const cycleLengths = [];
    for (let i = 1; i < periods.length; i++) {
      const gap = diffDays(parseDate(periods[i].start), parseDate(periods[i - 1].start));
      if (gap > 0) cycleLengths.push(gap);
    }

    // Average cycle: use last 3 (or fewer) cycle lengths
    if (cycleLengths.length > 0) {
      const recent = cycleLengths.slice(-3);
      stats.avgCycle = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length);
    }

    // Next predicted start
    const lastPeriod = periods[periods.length - 1];
    const lastStart = parseDate(lastPeriod.start);
    const nextStart = addDays(lastStart, stats.avgCycle);
    stats.nextPredicted = dateStr(nextStart);

    // Days until next
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    stats.daysUntilNext = diffDays(nextStart, today);

    // Predicted period days (start through start + avgDuration - 1)
    for (let i = 0; i < stats.avgDuration; i++) {
      stats.predictedPeriodDays.push(dateStr(addDays(nextStart, i)));
    }

    // Ovulation: nextStart - 14 days
    const ovDate = addDays(nextStart, -OVULATION_OFFSET);
    stats.ovulationDate = dateStr(ovDate);
    stats.ovulationDays.push(stats.ovulationDate);

    // Fertile window: ovulation ± 3 days
    stats.fertileStart = dateStr(addDays(ovDate, -FERTILE_WINDOW));
    stats.fertileEnd = dateStr(addDays(ovDate, FERTILE_WINDOW));
    for (let i = -FERTILE_WINDOW; i <= FERTILE_WINDOW; i++) {
      const fd = dateStr(addDays(ovDate, i));
      if (fd !== stats.ovulationDate) {
        stats.fertileDays.push(fd);
      }
    }

    return stats;
  }

  // Build a Set of all actual period day strings for quick lookup
  function buildPeriodDaySet(periods) {
    const set = new Set();
    periods.forEach(p => {
      const start = parseDate(p.start);
      for (let i = 0; i < p.duration; i++) {
        set.add(dateStr(addDays(start, i)));
      }
    });
    return set;
  }

  // ---- Rendering ----
  function renderSummary(stats) {
    avgCycleLengthEl.textContent = stats.avgCycle;
    avgDurationEl.textContent = stats.avgDuration;
    if (stats.daysUntilNext !== null) {
      daysUntilNextEl.textContent = stats.daysUntilNext >= 0 ? stats.daysUntilNext : '已到';
    } else {
      daysUntilNextEl.textContent = '--';
    }
  }

  function renderTodayBadge(stats, periods) {
    const today = new Date();
    const opts = { year: 'numeric', month: 'long', day: 'numeric' };
    const dateText = today.toLocaleDateString('zh-TW', opts);

    if (periods.length === 0) {
      todayBadgeText.textContent = `${dateText}`;
      return;
    }

    if (stats.daysUntilNext !== null && stats.daysUntilNext > 0) {
      todayBadgeText.textContent = `距下次經期還有 ${stats.daysUntilNext} 天`;
    } else if (stats.daysUntilNext !== null && stats.daysUntilNext <= 0) {
      todayBadgeText.textContent = `預測經期已到或進行中`;
    } else {
      todayBadgeText.textContent = dateText;
    }
  }

  function renderCalendar() {
    const periods = getPeriods();
    const stats = computeStats(periods);
    const periodDaySet = buildPeriodDaySet(periods);
    const predictedSet = new Set(stats.predictedPeriodDays);
    const ovulationSet = new Set(stats.ovulationDays);
    const fertileSet = new Set(stats.fertileDays);

    // Month label
    const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    currentMonthLabel.textContent = `${viewYear} 年 ${monthNames[viewMonth]}`;

    // First day of month & total days
    const firstDay = new Date(viewYear, viewMonth, 1).getDay(); // 0=Sun
    const totalDays = new Date(viewYear, viewMonth + 1, 0).getDate();
    const todayString = todayStr();

    calendarDays.innerHTML = '';

    // Empty cells before first day
    for (let i = 0; i < firstDay; i++) {
      const cell = document.createElement('div');
      cell.className = 'day-cell day-cell--empty';
      calendarDays.appendChild(cell);
    }

    // Day cells
    for (let d = 1; d <= totalDays; d++) {
      const cell = document.createElement('div');
      cell.className = 'day-cell';
      cell.textContent = d;

      const ds = dateStr(new Date(viewYear, viewMonth, d));

      // Today
      if (ds === todayString) cell.classList.add('day-cell--today');

      // Actual period
      if (periodDaySet.has(ds)) {
        cell.classList.add('day-cell--period');
      }
      // Ovulation
      else if (ovulationSet.has(ds)) {
        cell.classList.add('day-cell--ovulation');
      }
      // Fertile
      else if (fertileSet.has(ds)) {
        cell.classList.add('day-cell--fertile');
      }
      // Predicted period
      else if (predictedSet.has(ds)) {
        cell.classList.add('day-cell--predicted');
      }

      cell.addEventListener('click', () => onDayClick(ds, periods));
      calendarDays.appendChild(cell);
    }

    // Summary & badge
    renderSummary(stats);
    renderTodayBadge(stats, periods);
  }

  function renderHistory() {
    const periods = getPeriods();
    const stats = computeStats(periods);
    historyList.innerHTML = '';

    if (periods.length === 0) {
      historyList.innerHTML = '<li class="history-empty">尚無紀錄，點擊行事曆日期來新增 🌸</li>';
      return;
    }

    // Show in reverse chronological order
    const reversed = [...periods].reverse();
    const cycleLengths = [];
    for (let i = 1; i < periods.length; i++) {
      const gap = diffDays(parseDate(periods[i].start), parseDate(periods[i - 1].start));
      cycleLengths.push(gap);
    }
    // cycleLengths[i] = gap between period i and period i+1 (in original order)

    reversed.forEach((p, ri) => {
      const origIdx = periods.length - 1 - ri;
      const li = document.createElement('li');
      li.className = 'history-item';

      // Compute interval for anomaly detection
      let gap = null;
      if (origIdx > 0) {
        gap = diffDays(parseDate(periods[origIdx].start), parseDate(periods[origIdx - 1].start));
      }
      const isShort = gap !== null && gap < ANOMALY_SHORT;
      const isLong  = gap !== null && gap > ANOMALY_LONG;

      if (isShort) li.classList.add('history-item--anomaly-short');
      if (isLong)  li.classList.add('history-item--anomaly-long');

      // Left side: optional anomaly badge + date
      const leftWrap = document.createElement('span');
      leftWrap.style.display = 'flex';
      leftWrap.style.alignItems = 'center';

      if (isShort || isLong) {
        const badge = document.createElement('span');
        badge.className = 'history-item__badge ' + (isShort ? 'history-item__badge--short' : 'history-item__badge--long');
        badge.textContent = '!';
        badge.title = isShort
          ? '週期過短（< 15 天），建議諮詢醫師'
          : '週期過長（> 50 天），請保持觀察';
        leftWrap.appendChild(badge);
      }

      const dateSpan = document.createElement('span');
      dateSpan.className = 'history-item__date';
      dateSpan.textContent = `${formatDate(p.start)}（${p.duration} 天）`;
      leftWrap.appendChild(dateSpan);

      const cycleSpan = document.createElement('span');
      cycleSpan.className = 'history-item__cycle';
      if (gap !== null) {
        cycleSpan.textContent = `週期 ${gap} 天`;
      } else {
        cycleSpan.textContent = '';
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'history-item__delete';
      deleteBtn.textContent = '✕';
      deleteBtn.title = '刪除此紀錄';
      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deletePeriod(origIdx);
      });

      li.appendChild(leftWrap);
      li.appendChild(cycleSpan);
      li.appendChild(deleteBtn);

      // Click to edit
      li.addEventListener('click', () => {
        openModal(p.start, origIdx, p.duration);
      });

      historyList.appendChild(li);
    });
  }

  // ---- Day Click Handler ----
  function onDayClick(ds, periods) {
    // Check if this date is the start of an existing period
    const idx = periods.findIndex(p => p.start === ds);
    if (idx !== -1) {
      openModal(ds, idx, periods[idx].duration);
    } else {
      openModal(ds, -1, DEFAULT_DURATION);
    }
  }

  // ---- Modal ----
  function openModal(ds, index, duration) {
    selectedDate = ds;
    editingIndex = index;
    currentDuration = duration;

    modalDate.textContent = formatDate(ds);
    durationValue.textContent = currentDuration;

    if (index >= 0) {
      modalTitle.textContent = '編輯經期紀錄';
      modalDelete.style.display = '';
    } else {
      modalTitle.textContent = '標記經期開始';
      modalDelete.style.display = 'none';
    }

    modalOverlay.classList.add('active');
  }

  function closeModal() {
    modalOverlay.classList.remove('active');
    selectedDate = null;
    editingIndex = -1;
  }

  // ---- Anomaly Alert ----
  function showAnomalyAlert(type, intervalDays) {
    if (type === 'short') {
      alertBox.className = 'alert-box alert-box--danger';
      alertIcon.textContent = '🚨';
      alertTitle.textContent = '週期異常過短';
      alertMessage.textContent = '週期異常過短，建議諮詢醫師了解排卵狀況。';
    } else {
      alertBox.className = 'alert-box alert-box--warning';
      alertIcon.textContent = '⚠️';
      alertTitle.textContent = '週期過長';
      alertMessage.textContent = '週期過長，可能受壓力、作息或多囊卵巢症候群影響，請保持觀察。';
    }
    alertInterval.textContent = `本次週期間隔：${intervalDays} 天`;
    alertOverlay.classList.add('active');
  }

  function closeAlert() {
    alertOverlay.classList.remove('active');
  }

  function savePeriod() {
    if (partnerModeId) {
      alert('伴侶模式下無法編輯紀錄');
      closeModal();
      return;
    }
    if (!selectedDate) return;
    
    const periods = load(); // Load raw to modify true state
    const isNew = editingIndex < 0;
    const savedDate = selectedDate;

    if (editingIndex >= 0) {
      const sortedActive = getPeriods();
      const actualStart = sortedActive[editingIndex].start;
      const actualP = periods.find(p => p.start === actualStart && !p.deleted);
      if (actualP) {
        actualP.duration = currentDuration;
        actualP.pending = true;
      }
    } else {
      if (periods.some(p => p.start === savedDate && !p.deleted)) {
        closeModal();
        return;
      }
      periods.push({ start: savedDate, duration: currentDuration, pending: true });
    }

    save(periods);
    closeModal();
    refresh();

    if (navigator.onLine) {
       syncFromCloud();
    }

    if (isNew) {
      const sorted = getPeriods();
      const idx = sorted.findIndex(p => p.start === savedDate);
      if (idx > 0) {
        const gap = diffDays(parseDate(sorted[idx].start), parseDate(sorted[idx - 1].start));
        if (gap < ANOMALY_SHORT) {
          showAnomalyAlert('short', gap);
        } else if (gap > ANOMALY_LONG) {
          showAnomalyAlert('long', gap);
        }
      }
    }
  }

  function deletePeriod(index) {
    if (partnerModeId) {
      alert('伴侶模式下無法刪除紀錄');
      return;
    }
    const sortedActive = getPeriods();
    if (index < 0 || index >= sortedActive.length) return;
    const targetStart = sortedActive[index].start;
    
    const periods = load();
    const actualP = periods.find(p => p.start === targetStart && !p.deleted);
    if (actualP) {
      actualP.deleted = true;
      save(periods);
      closeModal();
      refresh();
      if (navigator.onLine) syncFromCloud();
    }
  }

  // ---- Navigation ----
  function goToPrevMonth() {
    viewMonth--;
    if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderCalendar();
  }

  function goToNextMonth() {
    viewMonth++;
    if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderCalendar();
  }

  // ---- Refresh All ----
  function refresh() {
    renderCalendar();
    renderHistory();
  }

  // ---- Swipe Support ----
  let touchStartX = 0;
  function onTouchStart(e) {
    touchStartX = e.changedTouches[0].screenX;
  }
  function onTouchEnd(e) {
    const dx = e.changedTouches[0].screenX - touchStartX;
    if (Math.abs(dx) > 60) {
      if (dx > 0) goToPrevMonth();
      else goToNextMonth();
    }
  }

  // ---- Init ----
  function init() {
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();

    // ---- Auth Listeners ----
    supabase.auth.onAuthStateChange((event, session) => {
      currentUser = session ? session.user : null;
      if (currentUser) {
        $('#authScreen').style.display = 'none';
        $('#mainApp').style.display = 'block';
        $('#headerActions').style.display = 'flex';
        $('#currentUserDisplay').textContent = `我的 ID: ${currentUser.id}`;
        partnerModeId = null;
        btnPartnerMode.textContent = '伴侶模式: 關閉';
        syncFromCloud();
      } else {
        $('#authScreen').style.display = 'block';
        $('#mainApp').style.display = 'none';
        $('#headerActions').style.display = 'none';
        $('#currentUserDisplay').textContent = '';
      }
    });

    btnLogin.addEventListener('click', async () => {
      authError.style.display = 'none';
      const { error } = await supabase.auth.signInWithPassword({ email: authEmail.value, password: authPassword.value });
      if (error) { authError.textContent = '登入失敗: ' + error.message; authError.style.display = 'block'; }
    });

    btnRegister.addEventListener('click', async () => {
      authError.style.display = 'none';
      const { error } = await supabase.auth.signUp({ email: authEmail.value, password: authPassword.value });
      if (error) { authError.textContent = '註冊失敗: ' + error.message; authError.style.display = 'block'; }
      else { alert('註冊成功！若需要驗證信請至信箱收取，或直接登入。'); }
    });

    btnLogout.addEventListener('click', async () => {
      await supabase.auth.signOut();
    });

    btnPartnerMode.addEventListener('click', () => {
      if (partnerModeId) {
         partnerModeId = null;
         btnPartnerMode.textContent = '伴侶模式: 關閉';
         refresh();
      } else {
         const pId = prompt('請輸入伴侶的 User ID (UUID格式):');
         if (pId) {
            partnerModeId = pId.trim();
            btnPartnerMode.textContent = '伴侶模式: 開啟中';
            syncFromCloud();
         }
      }
    });

    window.addEventListener('online', () => {
       if (currentUser) syncFromCloud();
    });

    // Event listeners
    prevMonthBtn.addEventListener('click', goToPrevMonth);
    nextMonthBtn.addEventListener('click', goToNextMonth);
    modalCancel.addEventListener('click', closeModal);
    modalSave.addEventListener('click', savePeriod);
    modalDelete.addEventListener('click', () => deletePeriod(editingIndex));
    alertDismiss.addEventListener('click', closeAlert);
    alertOverlay.addEventListener('click', (e) => {
      if (e.target === alertOverlay) closeAlert();
    });

    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });

    durationMinus.addEventListener('click', () => {
      if (currentDuration > 1) {
        currentDuration--;
        durationValue.textContent = currentDuration;
      }
    });
    durationPlus.addEventListener('click', () => {
      if (currentDuration < 14) {
        currentDuration++;
        durationValue.textContent = currentDuration;
      }
    });

    // Swipe support for calendar
    const calendarCard = document.getElementById('calendarCard');
    calendarCard.addEventListener('touchstart', onTouchStart, { passive: true });
    calendarCard.addEventListener('touchend', onTouchEnd, { passive: true });

    // Keyboard support
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeModal(); closeAlert(); }
      if (e.key === 'ArrowLeft') goToPrevMonth();
      if (e.key === 'ArrowRight') goToNextMonth();
    });

    refresh();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
