#!/usr/bin/env bash
#
# Everything the Xcode half of the build needs, in one command. Run on a Mac:
#
#     cd app && ./scripts/mac-build.sh
#
# Reports the Xcode version and SDKs, rebuilds the web layer, syncs Capacitor,
# then builds for a generic iOS device with automatic signing. Full output goes
# to build.log; the summary at the end pulls out compile and signing errors,
# which are the two things that actually block getting onto a phone.
#
set -uo pipefail
cd "$(dirname "$0")/.."

TEAM="${DEVELOPMENT_TEAM:-UMPTW639PG}"
LOG="build.log"
line(){ printf '\n== %s ==\n' "$1"; }

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This needs macOS with Xcode. Current platform: $(uname -s)."
  exit 1
fi

line "toolchain"
echo "macOS:  $(sw_vers -productVersion)"
command -v xcodebuild >/dev/null || { echo "xcodebuild not found. Install Xcode, then: sudo xcode-select -s /Applications/Xcode.app"; exit 1; }
xcodebuild -version
echo "developer dir: $(xcode-select -p)"
echo "node $(node -v), npm $(npm -v)"

line "iOS SDKs"
xcodebuild -showsdks 2>/dev/null | grep -i "iOS" || echo "(none reported)"
LATEST=$(xcodebuild -showsdks 2>/dev/null | sed -n 's/.*-sdk iphoneos\([0-9.]*\).*/\1/p' | sort -V | tail -1)
echo "latest iphoneos SDK: ${LATEST:-unknown}"
case "${LATEST%%.*}" in
  2[6-9]|[3-9][0-9]) echo "iOS 26+ SDK present." ;;
  *) echo "NOTE: iOS 26 SDK not found. Dawn does NOT need it (AlarmKit is unused -"
     echo "      its system alert always carries a Stop button, which defeats the"
     echo "      rep requirement). Deployment target is iOS 15.0." ;;
esac

line "web layer"
npm install || exit 1
npm run build || exit 1
npx cap sync ios || exit 1

line "xcodebuild (generic iOS device, automatic signing)"
echo "team: $TEAM   log: $(pwd)/$LOG"
set -o pipefail
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  build 2>&1 | tee "$LOG"
STATUS=${PIPESTATUS[0]}

line "summary"
if [ "$STATUS" -eq 0 ]; then
  echo "BUILD SUCCEEDED."
  echo "Next: open in Xcode (npx cap open ios), pick your iPhone, Run."
else
  echo "BUILD FAILED (exit $STATUS). Breaking it down:"

  echo
  echo "-- Swift/compile errors --"
  grep -E "error:" "$LOG" | grep -vi "provisioning\|code sign\|signing" | sort -u | head -40 || true
  grep -cE "error:" "$LOG" | xargs -I{} echo "({} total 'error:' lines)"

  echo
  echo "-- signing / provisioning --"
  grep -iE "provisioning profile|no profiles|requires a development team|signing for|doesn't support|failed to register|no signing certificate" "$LOG" | sort -u | head -20 || true

  echo
  echo "-- capability mismatches --"
  if grep -qi "time.sensitive" "$LOG"; then
    echo "The Time Sensitive Notifications entitlement is not on the profile."
    echo "Fix: developer.apple.com -> Certificates, Identifiers & Profiles ->"
    echo "     Identifiers -> com.damianjohnson.dawn -> enable 'Time Sensitive"
    echo "     Notifications' -> Save. Then re-run this script."
    echo "Or, to get building now, comment the key out of ios/App/App/App.entitlements"
    echo "(the alarm still works; it just stops piercing Focus modes)."
  else
    echo "(none detected)"
  fi

  echo
  echo "Full log: $(pwd)/$LOG"
  echo "Paste the compile errors back to Claude to get them fixed."
fi
exit "$STATUS"
