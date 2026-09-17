// ---------------------------------------------------------------------------
// Rep detection - PORTED VERBATIM from rep-counter.html.
//
// Do not retune anything in here. The constants below (LOW/HIGH 0.40/0.60,
// ENV_TAU_OPEN 0.12, ENV_TAU_CLOSE 0.80, CAL_PCT 0.05, ENV_FLOOR_FRAC 0.42,
// MIN_REP_MS 450, MIN_DOWN_MS 240, REP_SWING_FRAC 0.12, STEP_FRAC 0.45) were
// tuned against real push-ups on a real phone and verified at full accuracy.
// They encode measured reality, not theory. The calibration flow, the
// MIN_RANGE sanity check and the ?debug=1 overlay are carried across as-is.
//
// This file was generated mechanically from the prototype; every line not
// listed in PORT_CHANGES below is byte-identical to the source. Regenerate
// with scripts/port.py rather than hand-editing the detection path.
//
// PORT_CHANGES (plumbing and copy only - nothing in the signal path):
//   1. wrapper: IIFE -> export function initCounter(opts); screens map covers the app's screens
//   2. goal: stepper/localStorage replaced by opts.goal (set on the alarm screen)
//   3. copy: camera-denied message points at iOS Settings instead of Safari's address bar
//   4. copy: no-camera message names the Simulator, which is where it will actually be hit
//   5. copy: camera-failure footer mentions the escape hatches
//   6. copy: start button label via START_LABEL (handler body unchanged)
//   7. finish(): added stopCamera() + opts.onFinish(mode,count); againBtn moved to the shell
//   8. debug overlay: ?debug=1 kept verbatim, plus a persisted flag so it is reachable on device
//   9. end: returns {show, stopCamera, reset, isRunning} and gives the camera back
// ---------------------------------------------------------------------------

export function initCounter(opts){
  "use strict";
  opts = opts || {};

  var video   = document.getElementById('cam');
  // PORT: sSetup is gone (the app has its own alarm screens); sAlarm/sRing are
  // added to the same map so one show() still owns every screen.
  var screens = {alarm:s('sAlarm'), ring:s('sRing'), cal:s('sCal'), count:s('sCount'), done:s('sDone')};
  function s(id){ return document.getElementById(id); }
  function show(name){
    for (var k in screens) screens[k].classList.toggle('on', k===name);
  }

  // ---- tunables -------------------------------------------------------
  var GRID_W = 48, GRID_H = 36;     // downsampled analysis resolution
  var HIST    = 150;                // samples kept for the trace (~5s)
  var LOW     = 0.40, HIGH = 0.60;  // hysteresis thresholds (normalised)
  var MIN_REP_MS  = 450;            // reject jitter / double counts
  var MIN_DOWN_MS = 240;            // nobody pushes back up faster than this
  var MIN_RANGE   = 4.0;            // min luminance swing to trust the signal
  var STALL_MS    = 12000;          // warn if nothing counted for this long

  // Calibration. Two slow reps, minus the camera's auto-exposure settle, read
  // as percentiles instead of raw min/max. A rep signal dwells at its
  // turnarounds, so the 5th/95th percentiles sit within ~1% of the true
  // extremes while discarding one-frame flyers. That is what the old 8% pad
  // was reaching for, except the pad widened the range instead of cleaning it,
  // which made every working rep ~16% harder to complete.
  var CAL_MS        = 6000;
  var CAL_WARMUP_MS = 900;
  var CAL_PCT       = 0.05;

  // Signal conditioning and the adaptive envelope.
  var SMOOTH_MS       = 70;         // gentle low-pass: kills sensor noise, not reps
  var ENV_WIN_MS      = 1800;       // trailing window the envelope contracts toward
  var ENV_MIN_FILL_MS = 1400;       // ...only once the window really holds that much
  var ENV_TAU_OPEN    = 0.12;       // seconds — envelope opens fast
  var ENV_TAU_CLOSE   = 0.80;       // seconds — and closes nearly as fast
  var ENV_FLOOR_FRAC  = 0.42;       // never contract below this much of the cal range
  var REP_SWING_FRAC  = 0.12;       // a rep must move this much actual luminance
  var STEP_FRAC       = 0.45;       // a one-frame jump this big is a light change

  // PORT: a packaged app loads capacitor://localhost with no query string, so
  // the ?debug=1 route (kept verbatim, for `vite dev` in a browser) can never
  // fire on device. A persisted flag is OR-ed in; the app shell toggles it with
  // five taps on the alarm screen heading.
  var DEBUG = false;
  try { DEBUG = /(?:^|[?&])debug=1(?:&|$)/.test(location.search); } catch(e){}
  try { if (localStorage.getItem('dawn.debug') === '1') DEBUG = true; } catch(e){}

  // ---- state ----------------------------------------------------------
  var goal = 10, count = 0, phase = 'up', lastRepAt = 0, lastProgressAt = 0;
  var loMark = Infinity, hiMark = -Infinity;   // live luminance envelope
  var samples = [], marks = [];                // trace data
  var running = false, mode = 'reps', rafId = null, stream = null;

  var calRange = 0;                            // range measured during calibration
  var envFloor = MIN_RANGE, minRepSwing = MIN_RANGE * 0.5;
  var envWin = [], envWinT = [];               // trailing window for contraction
  var smBuf  = [], smBufT  = [];               // smoothing window
  var prevRaw = null, lastT = 0, downAt = 0;
  var repLo = Infinity, repHi = -Infinity;     // extremes within the current dip
  var lastSwing = 0, rejSwing = 0, rejFast = 0;
  var lastN = 0.5, lastRaw = 0, fps = 0;

  var work = document.createElement('canvas');
  work.width = GRID_W; work.height = GRID_H;
  var wctx = work.getContext('2d', {willReadFrequently:true});

  // ---- goal -----------------------------------------------------------
  // PORT: the prototype owned its own stepper + localStorage. In the app the
  // goal is set on the alarm screen and persisted via @capacitor/preferences,
  // so it is handed in instead. The counting logic below is untouched.
  goal = Math.max(1, Math.min(50, opts.goal || 10));

  // ---- camera ---------------------------------------------------------
  var preview = s('preview'), embedWarn = s('embedWarn'), demo = false, demoT = 0;

  var embedded = false;
  try { embedded = window.self !== window.top; } catch(e){ embedded = true; }
  if (embedded) embedWarn.classList.remove('hide');

  function cameraFailure(err){
    var name = (err && err.name) ? err.name : 'unknown';
    var msg;
    if (name === 'NotAllowedError' && embedded){
      msg = 'Blocked because this page is embedded in another page \u2014 the camera request never reached you. ' +
            'Open the artifact link directly in Safari or Chrome.';
    } else if (name === 'NotAllowedError'){
      msg = 'Camera access is off for this app. Open the iOS Settings app \u2192 Privacy & Security \u2192 Camera \u2192 Dawn Alarm, turn it on, then come back.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError'){
      msg = 'No usable camera found on this device.';
    } else if (name === 'NotReadableError'){
      msg = 'Another app is holding the camera. Close it and reload.';
    } else if (!navigator.mediaDevices){
      msg = 'No camera available here. The iOS Simulator has no camera \u2014 use the simulated signal below.';
    } else {
      msg = 'The camera did not open (' + name + ').';
    }
    var box = s('camErr');
    if (!box){
      box = document.createElement('div');
      box.className = 'warn'; box.id = 'camErr';
      box.style.marginTop = '14px';
      s('startBtn').parentNode.insertBefore(box, s('startBtn').nextSibling);
    }
    box.textContent = msg + ' You can still tap below to run on a simulated signal, or use an escape hatch.';
  }

  var START_LABEL = 'Start push-ups';   // PORT: UI copy only
  s('startBtn').onclick = function(){
    var btn = this; btn.disabled = true; btn.textContent = 'Asking for the camera\u2026';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      btn.disabled = false; btn.textContent = START_LABEL;
      cameraFailure({name:'NotSupported'}); return;
    }
    navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user', width:{ideal:640} }, audio:false })
      .then(function(st){ stream = st; video.srcObject = st; return video.play(); })
      .then(function(){
        btn.disabled=false; btn.textContent=START_LABEL;
        var e = s('camErr'); if (e) e.remove();
        preview.classList.add('on');
        demo = false;
        startCalibration();
      })
      .catch(function(err){
        btn.disabled = false; btn.textContent = START_LABEL;
        cameraFailure(err);
      });
  };

  s('demoBtn').onclick = function(){
    demo = true; demoT = 0;
    preview.classList.remove('on');
    startCalibration();
  };

  // ---- luminance sampling --------------------------------------------
  function sampleLuma(){
    if (demo){
      demoT += 0.045;
      return 128 + 40*Math.sin(demoT) + (Math.random()*4 - 2);
    }
    if (!video.videoWidth) return null;
    wctx.drawImage(video, 0, 0, GRID_W, GRID_H);
    var d = wctx.getImageData(0, 0, GRID_W, GRID_H).data;
    // centre band only: the body fills the middle, edges are background
    var y0 = (GRID_H*0.2)|0, y1 = (GRID_H*0.8)|0;
    var sum = 0, n = 0;
    for (var y=y0; y<y1; y++){
      for (var x=0; x<GRID_W; x++){
        var i = (y*GRID_W + x)*4;
        sum += 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
        n++;
      }
    }
    return sum/n;
  }

  function pushSample(v){
    samples.push(v); marks.push(false);
    if (samples.length > HIST){ samples.shift(); marks.shift(); }
  }

  function normalise(v){
    var range = hiMark - loMark;
    if (range < 0.0001) return 0.5;
    return Math.max(0, Math.min(1, (v - loMark) / range));
  }

  function pctl(arr, p){
    if (!arr.length) return 0;
    var a = arr.slice().sort(function(x,y){ return x - y; });
    var i = Math.round(p * (a.length - 1));
    return a[Math.max(0, Math.min(a.length - 1, i))];
  }

  // Time-based moving average, so it behaves the same at 24fps and 120fps.
  function smooth(v, now){
    smBuf.push(v); smBufT.push(now);
    while (smBufT.length > 1 && now - smBufT[0] > SMOOTH_MS){ smBuf.shift(); smBufT.shift(); }
    while (smBuf.length > 10){ smBuf.shift(); smBufT.shift(); }
    var sum = 0;
    for (var i=0;i<smBuf.length;i++) sum += smBuf[i];
    return sum / smBuf.length;
  }

  // A light change moves every pixel at once, far faster than a body can move.
  // Slide the whole frame of reference with it, so the normalised signal stays
  // continuous instead of reading the step as half a rep.
  function rebase(d){
    loMark += d; hiMark += d; repLo += d; repHi += d;
    var i;
    for (i=0;i<envWin.length;i++)  envWin[i]  += d;
    for (i=0;i<smBuf.length;i++)   smBuf[i]   += d;
    for (i=0;i<samples.length;i++) samples[i] += d;
  }

  function resetSignal(){
    samples = []; marks = [];
    envWin = []; envWinT = [];
    smBuf  = []; smBufT  = [];
    prevRaw = null; lastT = 0; fps = 0;
    repLo = Infinity; repHi = -Infinity;
    lastSwing = 0; rejSwing = 0; rejFast = 0;
  }

  // ---- calibration ----------------------------------------------------
  var calEnd = 0, calStart = 0, calSamples = [], calShow = 0,
      calTimerEl = s('calTimer'), calStateEl = s('calState');

  function startCalibration(){
    loMark = Infinity; hiMark = -Infinity;
    calSamples = []; calShow = 0;
    resetSignal();
    calStart = performance.now();
    calEnd = calStart + CAL_MS;
    show('cal');
    running = true;
    if (!rafId) loop();   // never stack a second rAF chain on recalibrate
  }

  function calFrame(now){
    var raw = sampleLuma();
    if (raw !== null){
      var v = smooth(raw, now);
      lastRaw = v;
      // Skip the auto-exposure settle: the camera opens dark and ramps, and a
      // single settling frame used to define an extreme for the whole session.
      if (now - calStart >= CAL_WARMUP_MS){
        calSamples.push(v);
        if (v < loMark) loMark = v;
        if (v > hiMark) hiMark = v;
      }
      pushSample(v);
      lastN = (hiMark > loMark)
        ? Math.max(0, Math.min(1, (v - loMark) / (hiMark - loMark))) : 0.5;
    }
    var left = Math.max(0, Math.ceil((calEnd - now)/1000));
    calTimerEl.textContent = left;
    if (now - calStart < CAL_WARMUP_MS){
      calStateEl.textContent = 'settling';
    } else if (now - calShow > 150){
      calShow = now;
      calStateEl.textContent =
        (pctl(calSamples, 1 - CAL_PCT) - pctl(calSamples, CAL_PCT)).toFixed(1) + ' range';
    }
    drawTrace(document.getElementById('traceCal'), true);
    updateDebug(now, 'calibrating');

    if (now >= calEnd){
      var lo = pctl(calSamples, CAL_PCT), hi = pctl(calSamples, 1 - CAL_PCT);
      var range = hi - lo;
      if (calSamples.length < 30 || range < MIN_RANGE){
        // Tell them NOW, not after 30 uncounted reps.
        s('calTitle').textContent = 'It can\u2019t see enough movement';
        s('calLede').textContent  = 'Move the phone further back so more of your body is in frame, then try the practice reps again.';
        calTimerEl.textContent = '\u2014';
        running = false;
        var again = document.createElement('button');
        again.textContent = 'Try the practice reps again';
        again.style.marginTop = '18px';
        again.onclick = function(){
          again.remove();
          s('calTitle').textContent = 'Do two slow push-ups';
          s('calLede').textContent  = 'Go all the way down and all the way up. Take your time \u2014 this is just so it can see your range.';
          startCalibration();
        };
        screens.cal.appendChild(again);
        return;
      }
      // No pad. The percentiles above already are the working extremes, and
      // padding them only moved the goalposts away from every real rep.
      loMark = lo; hiMark = hi;
      calRange    = range;
      envFloor    = Math.max(MIN_RANGE, calRange * ENV_FLOOR_FRAC);
      minRepSwing = Math.max(MIN_RANGE * 0.5, calRange * REP_SWING_FRAC);
      beginCounting();
    }
  }

  s('skipCal').onclick = function(){ switchToTimer(); };

  // ---- counting -------------------------------------------------------
  var countEl = s('countVal'), countSub = s('countSub'),
      liveState = s('liveState'), stallWarn = s('stallWarn');

  function beginCounting(){
    count = 0; phase = 'up'; mode = 'reps';
    lastRepAt = 0; downAt = 0; lastProgressAt = performance.now();
    resetSignal();
    countEl.textContent = '0';
    countSub.textContent = 'of ' + goal;
    liveState.textContent = 'up';
    stallWarn.classList.add('hide');
    show('count');
    running = true;
  }

  function countFrame(now){
    var raw = sampleLuma();
    if (raw === null) return;

    var dt = lastT ? Math.min(0.1, Math.max(1/240, (now - lastT)/1000)) : 1/60;
    lastT = now;
    fps = fps ? fps*0.9 + (1/dt)*0.1 : 1/dt;

    // Step detection reads the RAW sample on purpose: the smoother would
    // spread a light step across several frames and hide it.
    if (prevRaw !== null){
      var d = raw - prevRaw;
      if (Math.abs(d) > STEP_FRAC * (hiMark - loMark)) rebase(d);
    }
    prevRaw = raw;

    var v = smooth(raw, now);
    lastRaw = v;
    pushSample(v);

    envWin.push(v); envWinT.push(now);
    while (envWinT.length && now - envWinT[0] > ENV_WIN_MS){ envWin.shift(); envWinT.shift(); }
    var wLo = Infinity, wHi = -Infinity;
    for (var i=0;i<envWin.length;i++){
      if (envWin[i] < wLo) wLo = envWin[i];
      if (envWin[i] > wHi) wHi = envWin[i];
    }
    var filled = envWinT.length > 1 && (now - envWinT[0]) >= ENV_MIN_FILL_MS;

    // Decaying envelope. The old version could only ever widen loMark/hiMark,
    // so a single bright frame stretched the range for good and the normalised
    // signal crept toward the middle until it stopped crossing the thresholds
    // at all. Now it also eases back toward the last couple of seconds'
    // extremes, so the range tracks the reps actually being done.
    var kOpen  = 1 - Math.exp(-dt / ENV_TAU_OPEN);
    var kClose = 1 - Math.exp(-dt / ENV_TAU_CLOSE);
    if (v < loMark)  loMark += (v - loMark) * kOpen;
    else if (filled) loMark += (wLo - loMark) * kClose;
    if (v > hiMark)  hiMark += (v - hiMark) * kOpen;
    else if (filled) hiMark += (wHi - hiMark) * kClose;

    // ...but never so far that noise fills the scale and invents reps.
    if (hiMark - loMark < envFloor){
      var mid = (hiMark + loMark) / 2;
      loMark = mid - envFloor/2; hiMark = mid + envFloor/2;
    }

    var n = normalise(v);
    lastN = n;
    if (v < repLo) repLo = v;
    if (v > repHi) repHi = v;

    if (phase === 'up' && n < LOW){
      phase = 'down'; downAt = now;
      repLo = v; repHi = v;
      liveState.textContent = 'down';
    } else if (phase === 'down' && n > HIGH){
      var swing = repHi - repLo;
      if (now - lastRepAt <= MIN_REP_MS){
        // too soon after the last rep to be a new one - stay down and wait
      } else if (now - downAt < MIN_DOWN_MS){
        // down and back up faster than a body moves: a flicker, not a rep
        phase = 'up'; liveState.textContent = 'up'; rejFast++;
      } else if (swing < minRepSwing){
        // crossed both thresholds without much actual luminance moving, which
        // means the envelope is tight around noise rather than around a rep
        phase = 'up'; liveState.textContent = 'up'; rejSwing++; lastSwing = swing;
      } else {
        phase = 'up';
        liveState.textContent = 'up';
        lastRepAt = now; lastProgressAt = now; lastSwing = swing;
        marks[marks.length-1] = true;
        registerRep();
      }
    }

    if (now - lastProgressAt > STALL_MS){
      stallWarn.classList.remove('hide');
    }
    drawTrace(document.getElementById('trace'), false);
    updateDebug(now, null);
  }

  function registerRep(){
    count++;
    countEl.textContent = count;
    countEl.classList.remove('flash');
    void countEl.offsetWidth;
    countEl.classList.add('flash');
    stallWarn.classList.add('hide');
    paintDawn(count/goal);
    if (count >= goal) finish();
  }

  function paintDawn(p){
    document.getElementById('dawnWarm').style.opacity = Math.max(0, Math.min(1, p));
  }

  // ---- timer fallback -------------------------------------------------
  var timerEnd = 0;
  function switchToTimer(){
    mode = 'timer';
    closeSheet();
    timerEnd = performance.now() + 30000;
    countSub.textContent = 'seconds of holding still';
    liveState.textContent = 'timer';
    stallWarn.classList.add('hide');
    show('count');
    running = true;
    if (!rafId) loop();
  }
  function timerFrame(now){
    var left = Math.max(0, Math.ceil((timerEnd - now)/1000));
    countEl.textContent = left;
    paintDawn(1 - left/30);
    updateDebug(now, 'timer');   // else the overlay freezes on stale numbers
    if (left <= 0) finish();
  }

  // ---- finish ---------------------------------------------------------
  function finish(){
    running = false;
    preview.classList.remove('on');
    paintDawn(1);
    s('doneBig').textContent = 'Alarm off.';
    s('doneSub').textContent = mode === 'timer' ? 'Close enough. You\u2019re up.' : count + ' reps. You\u2019re up.';
    show('done');
    stopCamera();
    // PORT: single exit point for every route out of a set - reps completed,
    // 30s timer, or bail. The shell silences the alarm and cancels the
    // remaining ring notifications from here.
    if (opts.onFinish) opts.onFinish(mode, count);
  }

  // ---- escape hatch ---------------------------------------------------
  var sheet = s('sheet');
  s('notWorking').onclick = function(){ sheet.classList.add('on'); };
  function closeSheet(){ sheet.classList.remove('on'); }
  s('closeSheet').onclick = closeSheet;
  s('recal').onclick  = function(){ closeSheet(); startCalibration(); };
  s('toTimer').onclick = switchToTimer;
  s('bail').onclick   = function(){ closeSheet(); mode='bail'; finish();
    s('doneSub').textContent = 'No reps. That\u2019s fine \u2014 it should never hold you hostage.'; };

  // ---- trace rendering ------------------------------------------------
  function drawTrace(cv, raw){
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    ctx.clearRect(0,0,W,H);
    if (samples.length < 2) return;

    if (!raw){
      ctx.strokeStyle = 'rgba(135,148,181,.35)';
      ctx.setLineDash([4,6]); ctx.lineWidth = 2;
      [LOW, HIGH].forEach(function(t){
        var y = H - t*H;
        ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke();
      });
      ctx.setLineDash([]);
    }

    var step = W / (HIST - 1);
    ctx.beginPath();
    ctx.lineWidth = 3; ctx.strokeStyle = '#4ECDC4';
    ctx.lineJoin = 'round';
    for (var i=0;i<samples.length;i++){
      var n = raw
        ? (hiMark>loMark ? (samples[i]-loMark)/(hiMark-loMark) : .5)
        : normalise(samples[i]);
      var x = i*step, y = H - Math.max(0,Math.min(1,n))*(H-8) - 4;
      i ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
    }
    ctx.stroke();

    // dots where reps were counted — you can see exactly what it accepted
    ctx.fillStyle = '#FF6B35';
    for (var j=0;j<marks.length;j++){
      if (!marks[j]) continue;
      var nn = normalise(samples[j]);
      ctx.beginPath();
      ctx.arc(j*step, H - nn*(H-8) - 4, 6, 0, Math.PI*2);
      ctx.fill();
    }
  }

  // ---- debug overlay (?debug=1) ---------------------------------------
  // Everything the thresholds are actually reading, on the phone, mid-set.
  var dbgT = 0, dEl = null;
  if (DEBUG){
    s('dbg').classList.add('on');
    dEl = {n:s('dN'), phase:s('dPhase'), mark:s('dbgMark'), lo:s('dLo'), hi:s('dHi'),
           range:s('dRange'), cal:s('dCal'), floor:s('dFloor'), raw:s('dRaw'),
           swing:s('dSwing'), reps:s('dReps'), rej:s('dRej'), fps:s('dFps')};
    // shade the band between LOW and HIGH so the marker's position reads at a glance
    s('dbgBar').style.background =
      'linear-gradient(90deg,#1B2545 0 ' + (LOW*100) + '%,#2C3A6B ' +
      (LOW*100) + '% ' + (HIGH*100) + '%,#1B2545 ' + (HIGH*100) + '% 100%)';
  }
  function num(x){ return isFinite(x) ? x.toFixed(1) : '-'; }
  function updateDebug(now, stage){
    if (!DEBUG || now - dbgT < 80) return;   // ~12Hz is plenty, and cheap
    dbgT = now;
    var range = (hiMark > loMark) ? hiMark - loMark : 0;
    dEl.n.textContent     = lastN.toFixed(3);
    dEl.phase.textContent = stage || (mode === 'timer' ? 'timer' : phase);
    dEl.mark.style.left   = (lastN*100).toFixed(1) + '%';
    dEl.lo.textContent    = num(loMark);
    dEl.hi.textContent    = num(hiMark);
    dEl.range.textContent = num(range);
    dEl.cal.textContent   = calRange ? num(calRange) : '-';
    dEl.floor.textContent = num(envFloor);
    dEl.raw.textContent   = num(lastRaw);
    dEl.swing.textContent = (lastSwing ? num(lastSwing) : '-') + ' / need ' + num(minRepSwing);
    dEl.reps.textContent  = count;
    dEl.rej.textContent   = rejSwing + '+' + rejFast;
    dEl.fps.textContent   = fps ? fps.toFixed(0) : '-';
  }

  // ---- main loop ------------------------------------------------------
  function loop(){
    rafId = requestAnimationFrame(loop);
    if (!running) return;
    var now = performance.now();
    if (screens.cal.classList.contains('on')) calFrame(now);
    else if (screens.count.classList.contains('on')){
      mode === 'timer' ? timerFrame(now) : countFrame(now);
    }
  }
  // ---- PORT: camera teardown + the handle the shell drives --------------
  // The prototype was a page you closed; an app has to give the camera back.
  function stopCamera(){
    try {
      if (stream){ stream.getTracks().forEach(function(t){ t.stop(); }); stream = null; }
    } catch(e){}
    preview.classList.remove('on');
  }

  return {
    show: show,
    stopCamera: stopCamera,
    setGoal: function(g){ goal = Math.max(1, Math.min(50, g || 10)); },
    reset: function(){ running = false; paintDawn(0); stopCamera(); },
    isRunning: function(){ return running; }
  };
}
