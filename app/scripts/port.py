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

# ---- styles ---------------------------------------------------------------
# The prototype was a web page; the app runs in a WKWebView with
# viewport-fit=cover, so the layout extends under the status bar, the notch and
# the home indicator. Each edit below KEEPS the prototype's declaration and adds
# an override after it: the original value is untouched and stays as the
# fallback for anything that does not understand env().
CSS_EDITS=[]
def cedit(old,new,why):
    global style
    if style.count(old)!=1:
        sys.exit('CSS PORT FAIL (%d matches): %s'%(style.count(old),why))
    style=style.replace(old,new)
    CSS_EDITS.append(why)

cedit("""    padding:clamp(20px,5vw,40px);""",
"""    padding:clamp(20px,5vw,40px);
    /* SAFE AREA: insets added on top of the padding above, all four sides, so
       the heading clears the status bar, the bottom clears the home indicator
       and neither edge is eaten by the notch in landscape. */
    padding:
      calc(clamp(20px,5vw,40px) + env(safe-area-inset-top, 0px))
      calc(clamp(20px,5vw,40px) + env(safe-area-inset-right, 0px))
      calc(clamp(20px,5vw,40px) + env(safe-area-inset-bottom, 0px))
      calc(clamp(20px,5vw,40px) + env(safe-area-inset-left, 0px));""",
".wrap: safe-area insets added to the existing padding on all four sides")

cedit("""    position:fixed;top:14px;right:14px;z-index:5;""",
"""    position:fixed;top:14px;right:14px;z-index:5;
    /* SAFE AREA: otherwise the thumbnail sits under the clock and battery. */
    top:calc(14px + env(safe-area-inset-top, 0px));
    right:calc(14px + env(safe-area-inset-right, 0px));""",
"#preview: camera thumbnail offset below the status bar and clear of the notch")

cedit("""    padding:26px clamp(20px,5vw,32px) 32px;""",
"""    padding:26px clamp(20px,5vw,32px) 32px;
    /* SAFE AREA: pad the content clear of the home indicator rather than
       lifting the sheet, so its background still reaches the screen edge. */
    padding-bottom:calc(32px + env(safe-area-inset-bottom, 0px));
    padding-left:calc(clamp(20px,5vw,32px) + env(safe-area-inset-left, 0px));
    padding-right:calc(clamp(20px,5vw,32px) + env(safe-area-inset-right, 0px));""",
".sheet: escape-hatch buttons padded clear of the home indicator (background still full-bleed)")

cedit("""    position:fixed;left:10px;bottom:10px;z-index:20;""",
"""    position:fixed;left:10px;bottom:10px;z-index:20;
    /* SAFE AREA: same bottom edge problem as the sheet. */
    bottom:calc(10px + env(safe-area-inset-bottom, 0px));
    left:calc(10px + env(safe-area-inset-left, 0px));""",
"#dbg: debug overlay lifted above the home indicator")

# #dawn and #dawnWarm are deliberately NOT inset: they are full-bleed
# background gradients on position:fixed;inset:0, and insetting them would
# leave unpainted bars behind the status bar and home indicator.

# Styles the app shell needs that the prototype never had. These live here,
# not appended to styles.css by hand, because this script OVERWRITES that file:
# an earlier version of this block was lost exactly that way, which left the
# time picker and the ring screen unstyled.
APP_CSS = """

  /* ---- app shell additions (alarm setup + ringing screens) ------------- */
  .field{display:flex;align-items:center;gap:14px;margin-bottom:22px}
  .field label{color:var(--dim);font-size:15px}
  .field input[type="time"]{
    margin-left:auto;font-family:var(--font);font-size:30px;font-weight:800;
    background:#1B2545;color:var(--text);border:1.5px solid #2B3763;
    border-radius:12px;padding:10px 14px;min-height:56px;
    font-variant-numeric:tabular-nums;
  }
  #sRing .count{font-size:clamp(90px,30vw,160px);margin:auto 0 0}
  #sRing .countSub{margin-bottom:auto}
  .note.armed{color:var(--signal)}
  /* Persistent, not a toast: this is the line someone comes back to look for
     at 06:45 when they are working out why nothing rang. */
  .note.caution{color:var(--gold)}

  /* Back to the alarm screen. Shown ONLY for a "Try it now" test run: when a
     real alarm is ringing this screen is the dismissal gate, and a one-tap
     exit would make the rep requirement meaningless. The escape-hatch sheet
     stays as the deliberate way out of both. It lives inside #sRing, so the
     .screen display toggle hides it on every other screen for free. */
  .backArrow{
    position:fixed;z-index:6;
    top:calc(14px + env(safe-area-inset-top, 0px));
    left:calc(14px + env(safe-area-inset-left, 0px));
    width:44px;height:44px;min-height:44px;padding:0;
    display:flex;align-items:center;justify-content:center;
    background:rgba(11,16,38,.55);color:var(--text);
    border:1.5px solid #2B3763;border-radius:12px;
    font-size:22px;line-height:1;font-weight:400;
  }
  .backArrow.hide{display:none}
  /* The arrow is fixed to the viewport corner, so the ring screen's own
     content has to be pushed clear of it - otherwise it lands on top of the
     heading. Only when the arrow is actually shown. Toggled from main.js
     rather than :has(), which needs iOS 15.4 and the target here is 15.0. */
  #sRing.hasBack{padding-top:52px}
"""

CSS_HEADER=("/* Carried over from rep-counter.html. The prototype's declarations are\n"
            "   unchanged; the edits below only ADD iOS safe-area insets after them.\n"
            "   The app shell's own styles are appended at the end.\n"
            "   Generated by scripts/port.py - do not hand-edit.\n\n"
            + ''.join('     %d. %s\n'%(i+1,w) for i,w in enumerate(CSS_EDITS))
            + "*/\n")
io.open(os.path.join(APP,'src','styles.css'),'w',encoding='utf-8').write(
CSS_HEADER+style+APP_CSS+"\n")

# ---- screen markup lifted verbatim ---------------------------------------
def section(i):
    m=re.search(r'(  <section class="screen[^>]*id="%s">[\s\S]*?\n  </section>)'%i,src)
    if not m: sys.exit('missing section '+i)
    return m.group(1)
parts={i:section(i) for i in ['sCal','sCount','sDone']}
parts['sheet']=re.search(r'(<div class="sheet"[\s\S]*?\n</div>)',src).group(1)
parts['dbg']=re.search(r'(<div id="dbg"[\s\S]*?\n</div>)',src).group(1)
io.open(os.path.join(HERE,'parts.json'),'w').write(json.dumps(parts))
print('counter.js written; %d JS port changes, %d CSS safe-area edits:'%(len(EDITS),len(CSS_EDITS)))
for i,w in enumerate(EDITS): print('  %d. %s'%(i+1,w))
