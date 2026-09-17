# -*- coding: utf-8 -*-
# Mechanically derives app/src/counter.js + styles + screen markup from
# rep-counter.html. Anything not listed in EDITS below crosses over verbatim.
import io,re,sys,json,os

HERE=os.path.dirname(os.path.abspath(__file__))
APP=os.path.dirname(HERE)
REPO=os.path.dirname(APP)
SRC=os.path.join(REPO,'rep-counter.html')
src=io.open(SRC,encoding='utf-8').read()
script=re.search(r'<script>\n([\s\S]*?)\n</script>',src).group(1)
style =re.search(r'<style>\n([\s\S]*?)\n</style>',src).group(1)

EDITS=[]
def edit(old,new,why):
    global script
    if script.count(old)!=1:
        sys.exit('PORT FAIL (%d matches): %s'%(script.count(old),why))
    script=script.replace(old,new)
    EDITS.append(why)

# 1. IIFE -> module function
edit("""(function(){
  "use strict";

  var video   = document.getElementById('cam');
  var screens = {setup:s('sSetup'), cal:s('sCal'), count:s('sCount'), done:s('sDone')};""",
"""export function initCounter(opts){
  "use strict";
  opts = opts || {};

  var video   = document.getElementById('cam');
  // PORT: sSetup is gone (the app has its own alarm screens); sAlarm/sRing are
  // added to the same map so one show() still owns every screen.
  var screens = {alarm:s('sAlarm'), ring:s('sRing'), cal:s('sCal'), count:s('sCount'), done:s('sDone')};""",
"wrapper: IIFE -> export function initCounter(opts); screens map covers the app's screens")

# 2. goal now comes from the alarm setup screen
edit("""  // ---- goal stepper ---------------------------------------------------
  var goalVal = s('goalVal');
  try { var saved = localStorage.getItem('dawn.goal'); if (saved) goal = Math.max(1, Math.min(50, +saved||10)); } catch(e){}
  goalVal.textContent = goal;
  s('plus').onclick  = function(){ goal = Math.min(50, goal+1); goalVal.textContent = goal; persist(); };
  s('minus').onclick = function(){ goal = Math.max(1, goal-1); goalVal.textContent = goal; persist(); };
  function persist(){ try { localStorage.setItem('dawn.goal', goal); } catch(e){} }
""",
"""  // ---- goal -----------------------------------------------------------
  // PORT: the prototype owned its own stepper + localStorage. In the app the
  // goal is set on the alarm screen and persisted via @capacitor/preferences,
  // so it is handed in instead. The counting logic below is untouched.
  goal = Math.max(1, Math.min(50, opts.goal || 10));
""",
"goal: stepper/localStorage replaced by opts.goal (set on the alarm screen)")

# 3. camera-denied copy: the web instructions are wrong inside a native app
edit("""      msg = 'Camera permission was denied. In Safari: aA icon in the address bar \\u2192 Website Settings \\u2192 Camera \\u2192 Allow, then reload.';""",
"""      msg = 'Camera access is off for this app. Open the iOS Settings app \\u2192 Privacy & Security \\u2192 Camera \\u2192 Dawn Alarm, turn it on, then come back.';""",
"copy: camera-denied message points at iOS Settings instead of Safari's address bar")

edit("""      msg = 'This browser will not expose a camera here (it needs a secure, non-embedded page).';""",
"""      msg = 'No camera available here. The iOS Simulator has no camera \\u2014 use the simulated signal below.';""",
"copy: no-camera message names the Simulator, which is where it will actually be hit")

edit("""    box.textContent = msg + ' You can still tap below to watch the counter run on a simulated signal.';""",
"""    box.textContent = msg + ' You can still tap below to run on a simulated signal, or use an escape hatch.';""",
"copy: camera-failure footer mentions the escape hatches")

# 4. start button label (UI copy only - the handler body is untouched)
edit("""  s('startBtn').onclick = function(){
    var btn = this; btn.disabled = true; btn.textContent = 'Asking for the camera\\u2026';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      btn.disabled = false; btn.textContent = 'Turn on the camera';""",
"""  var START_LABEL = 'Start push-ups';   // PORT: UI copy only
  s('startBtn').onclick = function(){
    var btn = this; btn.disabled = true; btn.textContent = 'Asking for the camera\\u2026';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
      btn.disabled = false; btn.textContent = START_LABEL;""",
"copy: start button label via START_LABEL (handler body unchanged)")
script=script.replace("""        btn.disabled=false; btn.textContent='Turn on the camera';""",
                      """        btn.disabled=false; btn.textContent=START_LABEL;""")
script=script.replace("""        btn.disabled = false; btn.textContent = 'Turn on the camera';
        cameraFailure(err);""",
                      """        btn.disabled = false; btn.textContent = START_LABEL;
        cameraFailure(err);""")

# 5. finish() must tell the shell to silence + cancel the alarm
edit("""    s('doneSub').textContent = mode === 'timer' ? 'Close enough. You\\u2019re up.' : count + ' reps. You\\u2019re up.';
    show('done');
  }

  s('againBtn').onclick = function(){
    paintDawn(0);
    if (stream || demo) startCalibration(); else show('setup');
  };
""",
"""    s('doneSub').textContent = mode === 'timer' ? 'Close enough. You\\u2019re up.' : count + ' reps. You\\u2019re up.';
    show('done');
    stopCamera();
    // PORT: single exit point for every route out of a set - reps completed,
    // 30s timer, or bail. The shell silences the alarm and cancels the
    // remaining ring notifications from here.
    if (opts.onFinish) opts.onFinish(mode, count);
  }
""",
"finish(): added stopCamera() + opts.onFinish(mode,count); againBtn moved to the shell")

# 6. debug overlay must stay reachable inside a native shell
edit("""  var DEBUG = false;
  try { DEBUG = /(?:^|[?&])debug=1(?:&|$)/.test(location.search); } catch(e){}""",
"""  // PORT: a packaged app loads capacitor://localhost with no query string, so
  // the ?debug=1 route (kept verbatim, for `vite dev` in a browser) can never
  // fire on device. A persisted flag is OR-ed in; the app shell toggles it with
  // five taps on the alarm screen heading.
  var DEBUG = false;
  try { DEBUG = /(?:^|[?&])debug=1(?:&|$)/.test(location.search); } catch(e){}
  try { if (localStorage.getItem('dawn.debug') === '1') DEBUG = true; } catch(e){}""",
"debug overlay: ?debug=1 kept verbatim, plus a persisted flag so it is reachable on device")

# 7. expose what the shell needs
edit("""})();""",
"""  // ---- PORT: camera teardown + the handle the shell drives --------------
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
}""",
"end: returns {show, stopCamera, reset, isRunning} and gives the camera back")

HEADER = """// ---------------------------------------------------------------------------
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
%s// ---------------------------------------------------------------------------

"""%''.join('//   %d. %s\n'%(i+1,w) for i,w in enumerate(EDITS))

io.open(os.path.join(APP,'src','counter.js'),'w',encoding='utf-8').write(HEADER+script+'\n')

# ---- styles: original verbatim, app additions appended --------------------
io.open(os.path.join(APP,'src','styles.css'),'w',encoding='utf-8').write(
"/* Carried over verbatim from rep-counter.html. */\n"+style+"\n")

# ---- screen markup lifted verbatim ---------------------------------------
def section(i):
    m=re.search(r'(  <section class="screen[^>]*id="%s">[\s\S]*?\n  </section>)'%i,src)
    if not m: sys.exit('missing section '+i)
    return m.group(1)
parts={i:section(i) for i in ['sCal','sCount','sDone']}
parts['sheet']=re.search(r'(<div class="sheet"[\s\S]*?\n</div>)',src).group(1)
parts['dbg']=re.search(r'(<div id="dbg"[\s\S]*?\n</div>)',src).group(1)
io.open(os.path.join(HERE,'parts.json'),'w').write(json.dumps(parts))
print('counter.js written; %d port changes:'%len(EDITS))
for i,w in enumerate(EDITS): print('  %d. %s'%(i+1,w))
