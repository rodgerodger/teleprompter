(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ============================================================ settings */

  const SETTINGS_KEY = 'teleprompter.settings.v1';
  const SCRIPT_KEY = 'teleprompter.script.v1';

  const DEFAULTS = {
    speed: 4,
    speedStep: 0.5,
    countdown: 3,
    jumpLines: 3,
    fontSize: 72,
    lineHeight: 1.4,
    margin: 8,
    align: 'left',
    fontFamily: 'sans',
    fontWeight: '600',
    uppercase: false,
    theme: 'dark',
    mirrorX: false,
    mirrorY: false,
    showMarker: true,
    markerPos: 30,
    edgeFade: true,
    autoHide: true,
    clickerMode: 'speed',
  };

  const FONTS = {
    sans: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif',
    serif: 'Georgia, "Times New Roman", "New York", serif',
    rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", -apple-system, sans-serif',
    mono: 'ui-monospace, Menlo, Consolas, "Courier New", monospace',
  };

  let S = loadSettings();

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
    } catch (_) {
      return { ...DEFAULTS };
    }
  }
  let saveTimer;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S)); } catch (_) { /* private mode */ }
    }, 250);
  }

  /* ============================================================ elements */

  const el = {
    editor: $('#editor'),
    prompter: $('#prompter'),
    script: $('#script'),
    fileInput: $('#fileInput'),
    stats: $('#stats'),
    importStatus: $('#importStatus'),
    stage: $('#stage'),
    mirror: $('#mirror'),
    scroller: $('#scroller'),
    text: $('#text'),
    marker: $('#marker'),
    countdown: $('#countdown'),
    toast: $('#toast'),
    progressFill: $('#progressFill'),
    controls: $('#controls'),
    playBtn: $('#playBtn'),
    speedVal: $('#speedVal'),
    sizeVal: $('#sizeVal'),
    timeLeft: $('#timeLeft'),
    metaTheme: document.querySelector('meta[name="theme-color"]'),
  };

  /* ============================================================ state */

  let offset = 0; // px scrolled from the top of the script
  let maxOffset = 0;
  let lineH = 100; // px height of one line
  let playing = false;
  let dragging = false;
  let jumpRemaining = 0; // px of animated jump still to apply
  let countdownTimer = null;
  let textDirty = true;
  let settingsOpen = false;

  const isPrompter = () => el.prompter.classList.contains('active');
  const pxPerSec = () => (S.speed * lineH) / 8;

  /* ============================================================ theme */

  const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
  const resolvedTheme = () => (S.theme === 'auto' ? (darkMQ.matches ? 'dark' : 'light') : S.theme);

  function applyTheme() {
    const t = resolvedTheme();
    document.documentElement.dataset.theme = t;
    if (el.metaTheme) el.metaTheme.content = t === 'dark' ? '#000000' : '#ffffff';
  }
  if (darkMQ.addEventListener) darkMQ.addEventListener('change', () => S.theme === 'auto' && applyTheme());

  function toggleTheme() {
    S.theme = resolvedTheme() === 'dark' ? 'light' : 'dark';
    applySettings();
    saveSettings();
    toast(S.theme === 'dark' ? 'Dark mode' : 'Light mode');
  }

  /* ============================================================ apply settings */

  const fmt = {
    speed: (v) => String(+v.toFixed(2)),
    countdown: (v) => (v ? `${v}s` : 'Off'),
    jumpLines: (v) => `${v} line${v === 1 ? '' : 's'}`,
    fontSize: (v) => `${v}px`,
    lineHeight: (v) => v.toFixed(2),
    margin: (v) => `${v}%`,
    markerPos: (v) => `${v}%`,
  };

  function syncInputs() {
    $$('[data-setting]').forEach((input) => {
      const v = S[input.dataset.setting];
      if (input.type === 'checkbox') input.checked = !!v;
      else if (document.activeElement !== input) input.value = String(v);
    });
    $$('[data-out]').forEach((o) => {
      const k = o.dataset.out;
      o.textContent = fmt[k] ? fmt[k](S[k]) : S[k];
    });
  }

  function applySettings() {
    const frac = maxOffset > 0 ? offset / maxOffset : 0;
    applyTheme();

    const st = el.prompter.style;
    st.setProperty('--fs', `${S.fontSize}px`);
    st.setProperty('--lh', S.lineHeight);
    st.setProperty('--margin', `${S.margin}%`);
    st.setProperty('--align', S.align);
    st.setProperty('--ff', FONTS[S.fontFamily] || FONTS.sans);
    st.setProperty('--fw', S.fontWeight);
    st.setProperty('--marker', `${S.markerPos}%`);
    el.text.style.textTransform = S.uppercase ? 'uppercase' : 'none';
    el.mirror.style.transform = `scale(${S.mirrorX ? -1 : 1}, ${S.mirrorY ? -1 : 1})`;
    el.marker.hidden = !S.showMarker;
    el.prompter.classList.toggle('fade-on', S.edgeFade);

    $$('[data-action="mirrorX"]').forEach((b) => b.classList.toggle('on', S.mirrorX));
    $$('[data-action="mirrorY"]').forEach((b) => b.classList.toggle('on', S.mirrorY));
    el.speedVal.textContent = fmt.speed(S.speed);
    el.sizeVal.textContent = S.fontSize;

    syncInputs();
    relayout(frac);
  }

  function bindSettings() {
    $$('[data-setting]').forEach((input) => {
      const key = input.dataset.setting;
      const evt = input.type === 'range' ? 'input' : 'change';
      input.addEventListener(evt, () => {
        let v;
        if (input.type === 'checkbox') v = input.checked;
        else if (typeof DEFAULTS[key] === 'number') v = parseFloat(input.value);
        else v = input.value;
        S[key] = v;
        applySettings();
        saveSettings();
      });
    });
  }

  /* ============================================================ layout & render */

  function renderText() {
    const frag = document.createDocumentFragment();
    const lines = el.script.value.replace(/\r\n?/g, '\n').split('\n');
    for (const line of lines) {
      const p = document.createElement('p');
      if (!line.trim()) {
        p.className = 'blank';
        p.textContent = '\u00A0';
      } else {
        p.textContent = line;
      }
      frag.appendChild(p);
    }
    el.text.replaceChildren(frag);
    textDirty = false;
  }

  function relayout(frac) {
    if (!isPrompter()) return;
    lineH = S.fontSize * S.lineHeight;
    maxOffset = Math.max(0, el.text.offsetHeight - lineH);
    if (frac != null) offset = frac * maxOffset;
    offset = clamp(offset, 0, maxOffset);
    render();
    updateTime();
  }

  function render() {
    // Center of the current line sits on the reading marker.
    el.scroller.style.transform = `translate3d(0, ${(-offset - lineH / 2).toFixed(2)}px, 0)`;
    el.progressFill.style.transform = `scaleX(${maxOffset ? offset / maxOffset : 0})`;
  }

  function updateTime() {
    const secs = Math.max(0, Math.round((maxOffset - offset) / pxPerSec()));
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    el.timeLeft.textContent = `${m}:${s}`;
  }

  /* ============================================================ animation loop */

  let lastTs = 0;
  let lastUi = 0;
  function frame(ts) {
    const dt = lastTs ? Math.min(0.1, (ts - lastTs) / 1000) : 0;
    lastTs = ts;
    const manualVel = pollGamepad(ts);

    if (isPrompter()) {
      const prev = offset;
      if (playing && !dragging) offset += pxPerSec() * dt;
      if (manualVel) offset += manualVel * dt;
      if (jumpRemaining) {
        const step = Math.abs(jumpRemaining) < 0.5 ? jumpRemaining : jumpRemaining * Math.min(1, dt * 12);
        offset += step;
        jumpRemaining -= step;
      }
      offset = clamp(offset, 0, maxOffset);
      if (offset === 0 || offset === maxOffset) jumpRemaining = 0;
      if (offset !== prev) render();

      if (playing && maxOffset > 0 && offset >= maxOffset) {
        pause();
        toast('End of script');
      }
      if (ts - lastUi > 250) {
        lastUi = ts;
        updateTime();
      }
    }
    requestAnimationFrame(frame);
  }

  /* ============================================================ transport */

  function play() {
    if (playing || countdownTimer) return;
    if (offset >= maxOffset - 1) { offset = 0; render(); }
    if (S.countdown > 0 && offset < 1) runCountdown(startPlaying);
    else startPlaying();
  }

  function startPlaying() {
    playing = true;
    updatePlayUI();
    scheduleHide();
  }

  function pause() {
    cancelCountdown();
    playing = false;
    updatePlayUI();
    showControls();
  }

  function togglePlay() {
    if (playing || countdownTimer) pause();
    else play();
  }

  function runCountdown(done) {
    let n = S.countdown;
    el.countdown.textContent = n;
    el.countdown.classList.add('show');
    updatePlayUI();
    scheduleHide();
    countdownTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        cancelCountdown();
        done();
      } else {
        el.countdown.textContent = n;
      }
    }, 1000);
  }

  function cancelCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    el.countdown.classList.remove('show');
  }

  function updatePlayUI() {
    const active = playing || !!countdownTimer;
    el.playBtn.textContent = active ? '❚❚ Pause' : '▶ Play';
  }

  function changeSpeed(dir) {
    const step = S.speedStep || 0.5;
    S.speed = clamp(Math.round((S.speed + dir * step) * 100) / 100, 0.25, 20);
    el.speedVal.textContent = fmt.speed(S.speed);
    syncInputs();
    updateTime();
    saveSettings();
    toast(`Speed ${fmt.speed(S.speed)}`);
  }

  function changeFont(dir) {
    S.fontSize = clamp(S.fontSize + dir * 4, 24, 240);
    applySettings();
    saveSettings();
    toast(`Size ${S.fontSize}`);
  }

  function jump(lines) {
    jumpRemaining += lines * lineH;
  }

  function goTop() {
    pause();
    jumpRemaining = 0;
    offset = 0;
    render();
    updateTime();
    toast('Top');
  }

  function goEnd() {
    pause();
    jumpRemaining = 0;
    offset = maxOffset;
    render();
    updateTime();
  }

  function toggleSetting(key, label) {
    S[key] = !S[key];
    applySettings();
    saveSettings();
    toast(`${label} ${S[key] ? 'on' : 'off'}`);
  }

  /* ============================================================ UI helpers */

  let toastTimer;
  function toast(msg) {
    if (!isPrompter()) return;
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1200);
  }

  let hideTimer;
  function showControls() {
    el.controls.classList.remove('hidden');
    el.prompter.classList.remove('idle');
    clearTimeout(hideTimer);
    if (playing || countdownTimer) scheduleHide();
  }
  function scheduleHide() {
    clearTimeout(hideTimer);
    if (!S.autoHide) return;
    hideTimer = setTimeout(() => {
      if ((playing || countdownTimer) && !settingsOpen) {
        el.controls.classList.add('hidden');
        el.prompter.classList.add('idle');
      }
    }, 2500);
  }

  function setStatus(msg, kind) {
    el.importStatus.textContent = msg;
    el.importStatus.className = kind || '';
  }

  function updateStats() {
    const words = (el.script.value.match(/\S+/g) || []).length;
    const mins = words / 150;
    const read = mins < 1 ? `${Math.round(mins * 60)}s` : `${Math.floor(mins)}m ${Math.round((mins % 1) * 60)}s`;
    el.stats.textContent = `${words.toLocaleString()} words · ~${read} at 150 wpm`;
  }

  function openSettings() {
    settingsOpen = true;
    document.body.classList.add('settings-open');
    showControls();
  }
  function closeSettings() {
    settingsOpen = false;
    document.body.classList.remove('settings-open');
    if (playing) scheduleHide();
  }

  /* ============================================================ views */

  function openPrompter() {
    if (!el.script.value.trim()) {
      setStatus('Add or import some text first', 'error');
      el.script.focus();
      return;
    }
    if (textDirty) {
      renderText();
      offset = 0;
    }
    if (document.activeElement) document.activeElement.blur();
    el.editor.classList.remove('active');
    el.prompter.classList.add('active');
    applySettings();
    showControls();
    requestWakeLock();
  }

  function closePrompter() {
    pause();
    el.prompter.classList.remove('active');
    el.editor.classList.add('active');
    releaseWakeLock();
  }

  /* ============================================================ fullscreen & wake lock */

  function toggleFullscreen() {
    const d = document;
    const root = d.documentElement;
    const fsEl = d.fullscreenElement || d.webkitFullscreenElement;
    try {
      if (fsEl) {
        const r = (d.exitFullscreen || d.webkitExitFullscreen).call(d);
        if (r && r.catch) r.catch(() => {});
      } else {
        const req = root.requestFullscreen || root.webkitRequestFullscreen;
        if (!req) {
          toast('Use Share → Add to Home Screen for full screen');
          return;
        }
        const r = req.call(root);
        if (r && r.catch) r.catch(() => toast('Fullscreen not available'));
      }
    } catch (_) {
      toast('Fullscreen not available');
    }
  }

  let wakeLock = null;
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (_) { /* not supported / not allowed */ }
  }
  function releaseWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isPrompter()) requestWakeLock();
    if (document.visibilityState === 'hidden' && playing) pause();
  });

  /* ============================================================ actions (buttons) */

  const actions = {
    import: () => el.fileInput.click(),
    clear: () => {
      if (!el.script.value || confirm('Clear the whole script?')) {
        el.script.value = '';
        onScriptInput();
        setStatus('');
      }
    },
    start: openPrompter,
    edit: closePrompter,
    play: togglePlay,
    top: goTop,
    back: () => jump(-S.jumpLines),
    fwd: () => jump(S.jumpLines),
    speedDown: () => changeSpeed(-1),
    speedUp: () => changeSpeed(1),
    fontDown: () => changeFont(-1),
    fontUp: () => changeFont(1),
    mirrorX: () => toggleSetting('mirrorX', 'Mirror'),
    mirrorY: () => toggleSetting('mirrorY', 'Vertical flip'),
    theme: toggleTheme,
    fullscreen: toggleFullscreen,
    settings: () => (settingsOpen ? closeSettings() : openSettings()),
    closeSettings,
    resetSettings: () => {
      if (!confirm('Reset all settings to defaults?')) return;
      S = { ...DEFAULTS };
      applySettings();
      saveSettings();
    },
  };

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const fn = actions[btn.dataset.action];
    if (!fn) return;
    e.preventDefault();
    fn();
    // Drop focus so Space / Enter from a clicker doesn't re-trigger the button.
    if (btn.blur) btn.blur();
    if (isPrompter()) showControls();
  });

  /* ============================================================ touch / mouse on stage */

  let ptr = null;
  el.stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    ptr = { id: e.pointerId, y: e.clientY, start: offset, moved: false };
    try { el.stage.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  });
  el.stage.addEventListener('pointermove', (e) => {
    if (!ptr || e.pointerId !== ptr.id) {
      if (e.pointerType === 'mouse') showControls();
      return;
    }
    const dy = e.clientY - ptr.y;
    if (!ptr.moved && Math.abs(dy) > 10) {
      ptr.moved = true;
      dragging = true;
      jumpRemaining = 0;
    }
    if (ptr.moved) {
      offset = clamp(ptr.start - dy * (S.mirrorY ? -1 : 1), 0, maxOffset);
      render();
    }
  });
  const endPointer = (e) => {
    if (!ptr || e.pointerId !== ptr.id) return;
    const tap = !ptr.moved;
    ptr = null;
    dragging = false;
    if (tap && e.type === 'pointerup') togglePlay();
  };
  el.stage.addEventListener('pointerup', endPointer);
  el.stage.addEventListener('pointercancel', endPointer);
  el.stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    jumpRemaining = 0;
    offset = clamp(offset + e.deltaY, 0, maxOffset);
    render();
  }, { passive: false });

  /* ============================================================ keyboard & presentation clickers */

  function clicker(dir) {
    const mode = S.clickerMode;
    if (mode === 'jump' || (mode === 'hybrid' && !playing)) jump(dir * S.jumpLines);
    else changeSpeed(dir);
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable);

    if (!isPrompter()) {
      // Clicker "start presentation" button opens the prompter from the editor.
      if (e.key === 'F5' && !typing) { e.preventDefault(); openPrompter(); }
      if (e.key === 'Escape' && settingsOpen) closeSettings();
      return;
    }
    if (typing) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    let handled = true;
    switch (e.key) {
      case ' ': case 'Enter': case 'k': case 'K': case 'b': case 'B': case '.': case 'F5':
        if (!e.repeat) togglePlay();
        break;
      case 'PageDown': case 'ArrowDown': case 'ArrowRight':
        clicker(1);
        break;
      case 'PageUp': case 'ArrowUp': case 'ArrowLeft':
        clicker(-1);
        break;
      case 'Escape':
        if (settingsOpen) closeSettings(); else pause();
        break;
      case 'Home': goTop(); break;
      case 'End': goEnd(); break;
      case '+': case '=': changeFont(1); break;
      case '-': case '_': changeFont(-1); break;
      case 'm': case 'M': actions.mirrorX(); break;
      case 'v': case 'V': actions.mirrorY(); break;
      case 't': case 'T': toggleTheme(); break;
      case 'f': case 'F': toggleFullscreen(); break;
      case 'e': case 'E': closePrompter(); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  });

  /* ============================================================ game controller */

  const pad = { prev: [], next: {}, id: null };

  function setPadIndicator(id) {
    $$('[data-pad-indicator]').forEach((n) => {
      n.classList.toggle('on', !!id);
      n.title = id || 'No controller detected (press a button to wake it)';
      if (n.closest('.statusbar')) n.textContent = id ? '🎮 Controller connected' : '🎮 No controller';
    });
  }

  window.addEventListener('gamepadconnected', (e) => {
    setPadIndicator(e.gamepad.id);
    toast('Controller connected');
  });
  window.addEventListener('gamepaddisconnected', () => {
    setPadIndicator(null);
    toast('Controller disconnected');
  });

  const deadzone = (v, dz = 0.18) => (Math.abs(v) < dz ? 0 : Math.sign(v) * ((Math.abs(v) - dz) / (1 - dz)) ** 2);

  /** Polls the first connected gamepad. Returns a manual scroll velocity in px/s. */
  function pollGamepad(now) {
    if (!navigator.getGamepads) return 0;
    let gp = null;
    for (const p of navigator.getGamepads()) {
      if (p && p.connected) { gp = p; break; }
    }
    if (!gp) {
      if (pad.id) { pad.id = null; setPadIndicator(null); }
      return 0;
    }
    if (pad.id !== gp.id) { pad.id = gp.id; setPadIndicator(gp.id); }

    const cur = gp.buttons.map((b) => !!b && (b.pressed || b.value > 0.5));
    const val = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
    const down = (i) => cur[i] && !pad.prev[i];
    const repeat = (i) => {
      if (!cur[i]) return false;
      if (!pad.prev[i]) { pad.next[i] = now + 400; return true; }
      if (now >= pad.next[i]) { pad.next[i] = now + 110; return true; }
      return false;
    };

    let vel = 0;
    if (!isPrompter()) {
      if (down(0) || down(9)) openPrompter();
    } else {
      if (down(0) || down(9)) togglePlay(); // A / Start
      if (down(1)) pause(); // B
      if (down(2)) jump(-S.jumpLines); // X
      if (down(3)) jump(S.jumpLines); // Y
      if (down(8)) goTop(); // Select / View
      if (repeat(12) || repeat(5)) changeSpeed(1); // D-pad up / RB
      if (repeat(13) || repeat(4)) changeSpeed(-1); // D-pad down / LB
      if (repeat(15)) changeFont(1); // D-pad right
      if (repeat(14)) changeFont(-1); // D-pad left

      const triggers = deadzone(val(7) - val(6), 0.05); // RT forward, LT back
      const sticks = deadzone(gp.axes[1] || 0) + deadzone(gp.axes[3] || 0);
      vel = (triggers + sticks) * lineH * 12;
      if (vel) jumpRemaining = 0;
    }
    pad.prev = cur;
    return vel;
  }

  /* ============================================================ script editing & import */

  let scriptSaveTimer;
  function onScriptInput() {
    textDirty = true;
    updateStats();
    clearTimeout(scriptSaveTimer);
    scriptSaveTimer = setTimeout(() => {
      try { localStorage.setItem(SCRIPT_KEY, el.script.value); } catch (_) { /* quota */ }
    }, 400);
  }
  el.script.addEventListener('input', onScriptInput);

  async function importFile(file) {
    if (!file) return;
    setStatus(`Importing ${file.name}…`);
    try {
      const text = await window.Importers.fileToText(file);
      if (!text.trim()) throw new Error('No text found in that file.');
      if (el.script.value.trim() && el.script.value !== SAMPLE &&
          !confirm(`Replace the current script with "${file.name}"?`)) {
        setStatus('');
        return;
      }
      el.script.value = text;
      el.script.scrollTop = 0;
      onScriptInput();
      setStatus(`Imported ${file.name}`, 'ok');
    } catch (err) {
      console.error(err);
      setStatus(`Import failed: ${err.message}`, 'error');
    }
  }

  el.fileInput.addEventListener('change', () => {
    importFile(el.fileInput.files[0]);
    el.fileInput.value = '';
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) {
      if (isPrompter()) closePrompter();
      importFile(file);
    }
  });

  /* ============================================================ init */

  const SAMPLE = `Welcome to your teleprompter.

Paste your script here, or tap Import to load a Word (.docx), Rich Text (.rtf) or plain text (.txt) file.

When you're ready, tap Start Prompter. Tap the text to play or pause, and drag to reposition it.

Use the Speed buttons, a presentation clicker, or a Bluetooth game controller to speed up and slow down while you read.

Turn on Mirror if the iPad sits under beam-splitter glass, so the reflection reads correctly.

Switch between light and dark mode with the half-circle button.

Have a great shoot!`;

  function init() {
    let saved = null;
    try { saved = localStorage.getItem(SCRIPT_KEY); } catch (_) { /* ignore */ }
    el.script.value = saved != null ? saved : SAMPLE;
    updateStats();
    bindSettings();
    applySettings();
    setPadIndicator(null);

    window.addEventListener('resize', () => relayout(maxOffset ? offset / maxOffset : 0));
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => relayout(maxOffset ? offset / maxOffset : 0));

    requestAnimationFrame(frame);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
