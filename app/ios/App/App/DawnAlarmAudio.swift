//
//  DawnAlarmAudio.swift
//  Keeps an alarm ringing until the reps are actually done.
//
//  WHY THIS EXISTS
//  Local notifications cannot ring continuously: iOS caps a notification sound
//  at 30 seconds and there is no repeat. AlarmKit (iOS 26) looks like the right
//  answer but is not - its system alert always carries a Stop button ("The
//  system provides a stop button automatically"), so the alarm can be silenced
//  without the app ever running, which defeats the entire product.
//
//  So: background audio. An AVAudioSession in .playback keeps running when the
//  app is backgrounded and plays on the MEDIA channel, which means it ignores
//  the physical silent switch. The loop stops only when the JavaScript side
//  says so, and that happens exclusively on a completed set or one of the
//  escape hatches.
//
//  WHAT CAN STILL KILL IT
//  Force-quitting from the app switcher. Nothing can prevent that; iOS tears
//  down the process and the audio with it. The notification schedule stays in
//  place as a fallback so a force-quit still produces beeps, and the UI warns
//  that swiping the app away disables the reliable alarm.
//
import Foundation
import AVFoundation
import Capacitor

@objc(DawnAlarmAudioPlugin)
public class DawnAlarmAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DawnAlarmAudioPlugin"
    public let jsName = "DawnAlarmAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startKeepalive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopKeepalive",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fireAlarm",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleAlarm",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearScheduledAlarm", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAlarm",      returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState",       returnType: CAPPluginReturnPromise)
    ]

    private let engine = DawnAlarmEngine.shared

    override public func load() {
        engine.onStateChange = { [weak self] state in
            self?.notifyListeners("stateChange", data: state)
        }
        engine.restoreAfterLaunch()
    }

    @objc func startKeepalive(_ call: CAPPluginCall) {
        engine.startKeepalive()
        call.resolve(engine.stateDictionary())
    }

    @objc func stopKeepalive(_ call: CAPPluginCall) {
        engine.stopEverything()
        call.resolve(engine.stateDictionary())
    }

    @objc func fireAlarm(_ call: CAPPluginCall) {
        let sound = call.getString("sound") ?? "chime.wav"
        // The morning this ring belongs to. Stored so a relaunch can tell the
        // JS side which morning was ringing, and the satisfied-morning logic
        // there - the single source of truth - decides whether to resume.
        let morning = call.getString("morning") ?? ""
        let ok = engine.fireAlarm(soundFile: sound, morning: morning)
        if ok {
            call.resolve(engine.stateDictionary())
        } else {
            call.reject("Could not start alarm audio for \(sound)")
        }
    }

    /// Hand the fire time to the native side so the transition does not depend
    /// on JavaScript, which is not running when the phone is locked.
    @objc func scheduleAlarm(_ call: CAPPluginCall) {
        let at = call.getDouble("at") ?? 0
        let sound = call.getString("sound") ?? "chime.wav"
        let morning = call.getString("morning") ?? ""
        engine.scheduleAlarm(atEpochMs: at, soundFile: sound, morning: morning)
        call.resolve(engine.stateDictionary())
    }

    @objc func clearScheduledAlarm(_ call: CAPPluginCall) {
        engine.clearScheduledAlarm()
        call.resolve(engine.stateDictionary())
    }

    @objc func stopAlarm(_ call: CAPPluginCall) {
        // Back to keepalive rather than tearing the session down: the alarm is
        // over but the app may still be armed for tomorrow.
        engine.stopAlarm(returningToKeepalive: true)
        call.resolve(engine.stateDictionary())
    }

    @objc func getState(_ call: CAPPluginCall) {
        call.resolve(engine.stateDictionary())
    }
}

final class DawnAlarmEngine {
    static let shared = DawnAlarmEngine()

    private let session = AVAudioSession.sharedInstance()
    private var keepalivePlayer: AVAudioPlayer?
    private var alarmPlayer: AVAudioPlayer?
    private var wasRingingAtLaunch = false
    private var interruptedWhileRinging = false
    private var monitor: Timer?

    /// How often the native side checks whether the alarm is due. The app is
    /// kept alive by the audio session, so this timer really does run while
    /// backgrounded - which is the entire point of it existing.
    private let monitorSeconds = 10.0
    /// If the fire time passed longer ago than this, do not suddenly start
    /// blaring - the phone was probably off. The notifications cover that case.
    private let staleMs = 60.0 * 60.0 * 1000.0

    var onStateChange: (([String: Any]) -> Void)?

    // Survives a crash or a force-quit, so the app can work out on next launch
    // that it *should* have been ringing.
    private let kRinging = "dawn.audio.ringing"
    private let kMorning = "dawn.audio.morning"
    private let kSound   = "dawn.audio.sound"
    private let kFireAt        = "dawn.audio.fireAt"
    private let kSchedSound    = "dawn.audio.schedSound"
    private let kSchedMorning  = "dawn.audio.schedMorning"

    private init() {
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(handleInterruption(_:)),
                       name: AVAudioSession.interruptionNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleRouteChange(_:)),
                       name: AVAudioSession.routeChangeNotification, object: nil)
        nc.addObserver(self, selector: #selector(handleMediaReset(_:)),
                       name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    var isRinging: Bool { alarmPlayer?.isPlaying ?? false }
    var isKeepingAlive: Bool { keepalivePlayer?.isPlaying ?? false }

    func stateDictionary() -> [String: Any] {
        return [
            "ringing": isRinging,
            "keepalive": isKeepingAlive,
            "sound": UserDefaults.standard.string(forKey: kSound) ?? "",
            // True when the process died (force-quit, crash, reboot) while an
            // alarm was supposed to be ringing. JS decides whether to resume.
            "wasRingingAtLaunch": wasRingingAtLaunch,
            "morning": UserDefaults.standard.string(forKey: kMorning) ?? "",
            // Epoch ms of the next natively-scheduled ring, 0 if none, plus
            // whether the timer that watches for it is actually running.
            "scheduledAt": UserDefaults.standard.double(forKey: kFireAt),
            "monitoring": monitor != nil
        ]
    }

    private func emit() { onStateChange?(stateDictionary()) }

    // MARK: - Session

    /// Mixes with whatever else is playing: arming an alarm at 22:00 must not
    /// stop someone's podcast.
    private func activateForKeepalive() {
        do {
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            CAPLog.print("DawnAlarmAudio: keepalive session failed: \(error)")
        }
    }

    /// Takes the session over. No .mixWithOthers, so the alarm is not competing
    /// with anything, and .playback means the silent switch does not apply.
    private func activateForAlarm() {
        do {
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true, options: [.notifyOthersOnDeactivation])
        } catch {
            CAPLog.print("DawnAlarmAudio: alarm session failed: \(error)")
        }
    }

    private func player(for file: String, volume: Float, loops: Int) -> AVAudioPlayer? {
        let name = (file as NSString).deletingPathExtension
        let ext  = (file as NSString).pathExtension.isEmpty ? "wav" : (file as NSString).pathExtension
        guard let url = Bundle.main.url(forResource: name, withExtension: ext) else {
            CAPLog.print("DawnAlarmAudio: \(file) is not in the bundle")
            return nil
        }
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            p.numberOfLoops = loops
            p.volume = volume
            p.prepareToPlay()
            return p
        } catch {
            CAPLog.print("DawnAlarmAudio: could not open \(file): \(error)")
            return nil
        }
    }

    // MARK: - Keepalive

    func startKeepalive() {
        guard !isRinging else { return }
        startMonitor()     // the schedule is watched for as long as we are armed
        if isKeepingAlive { return }
        activateForKeepalive()
        // volume 1.0, NOT 0.0: keepalive.wav is generated at 3 LSB (-80.8 dBFS)
        // precisely so the session is never fed pure digital silence, which is
        // a good way to get an app suspended. Muting the player here would
        // output exact zeroes and throw that mitigation away. It is inaudible
        // at full volume already.
        keepalivePlayer = player(for: "keepalive.wav", volume: 1.0, loops: -1)
        keepalivePlayer?.play()
        emit()
    }

    // MARK: - Native scheduling
    //
    // The transition from keepalive to alarm MUST happen natively. It used to
    // be driven from JavaScript, reached through the localNotificationReceived
    // listener - but iOS only calls that when the app is in the FOREGROUND
    // (it maps to userNotificationCenter(_:willPresent:)), and a WKWebView in a
    // backgrounded app is not running JS anyway. So with the phone locked the
    // keepalive kept playing silence, the notification made its 30 seconds of
    // noise, and the continuous alarm never started. That was the whole bug.

    func scheduleAlarm(atEpochMs: Double, soundFile: String, morning: String) {
        let d = UserDefaults.standard
        d.set(atEpochMs, forKey: kFireAt)
        d.set(soundFile, forKey: kSchedSound)
        d.set(morning, forKey: kSchedMorning)
        startMonitor()
        emit()
    }

    func clearScheduledAlarm() {
        UserDefaults.standard.removeObject(forKey: kFireAt)
        emit()
    }

    private func startMonitor() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard self.monitor == nil else { return }
            let t = Timer(timeInterval: self.monitorSeconds, repeats: true) { [weak self] _ in
                self?.tick()
            }
            t.tolerance = 2.0   // let iOS coalesce it; a few seconds late is fine
            RunLoop.main.add(t, forMode: .common)
            self.monitor = t
        }
    }

    private func stopMonitor() {
        DispatchQueue.main.async { [weak self] in
            self?.monitor?.invalidate()
            self?.monitor = nil
        }
    }

    private func tick() {
        guard !isRinging else { return }
        let d = UserDefaults.standard
        let fireAt = d.double(forKey: kFireAt)
        guard fireAt > 0 else { return }
        let now = Date().timeIntervalSince1970 * 1000.0
        guard now >= fireAt else { return }
        d.removeObject(forKey: kFireAt)
        guard now - fireAt < staleMs else { emit(); return }
        fireAlarm(soundFile: d.string(forKey: kSchedSound) ?? "chime.wav",
                  morning: d.string(forKey: kSchedMorning) ?? "")
    }

    // MARK: - Alarm

    @discardableResult
    func fireAlarm(soundFile: String, morning: String) -> Bool {
        keepalivePlayer?.stop()
        keepalivePlayer = nil
        activateForAlarm()
        guard let p = player(for: soundFile, volume: 1.0, loops: -1) else {
            // Fall back to holding the session so a retry can work, and let the
            // notification fallback carry this morning.
            startKeepalive()
            return false
        }
        alarmPlayer = p
        p.play()
        let d = UserDefaults.standard
        d.set(true, forKey: kRinging)
        d.set(morning, forKey: kMorning)
        d.set(soundFile, forKey: kSound)
        wasRingingAtLaunch = false
        emit()
        return true
    }

    /// The ONLY way the alarm stops. Called from JS on a completed set or an
    /// escape hatch - never on a tap, a swipe or backgrounding.
    func stopAlarm(returningToKeepalive: Bool) {
        alarmPlayer?.stop()
        alarmPlayer = nil
        interruptedWhileRinging = false
        let d = UserDefaults.standard
        d.set(false, forKey: kRinging)
        d.removeObject(forKey: kMorning)
        // This morning is done. JS schedules the next one after topUp().
        d.removeObject(forKey: kFireAt)
        wasRingingAtLaunch = false
        if returningToKeepalive { startKeepalive() } else { deactivate() }
        emit()
    }

    func stopEverything() {
        stopMonitor()
        alarmPlayer?.stop(); alarmPlayer = nil
        keepalivePlayer?.stop(); keepalivePlayer = nil
        let d = UserDefaults.standard
        d.set(false, forKey: kRinging)
        d.removeObject(forKey: kMorning)
        d.removeObject(forKey: kFireAt)
        wasRingingAtLaunch = false
        deactivate()
        emit()
    }

    private func deactivate() {
        do { try session.setActive(false, options: [.notifyOthersOnDeactivation]) }
        catch { CAPLog.print("DawnAlarmAudio: deactivate failed: \(error)") }
    }

    /// Called on plugin load. Does NOT resume by itself: it only records that
    /// the process came back while an alarm was supposed to be ringing, so the
    /// JS side can check the satisfied-morning record before deciding.
    func restoreAfterLaunch() {
        wasRingingAtLaunch = UserDefaults.standard.bool(forKey: kRinging)
    }

    // MARK: - The three ways audio stops on its own

    /// A call or Siri. The alarm must come back afterwards.
    @objc private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        switch type {
        case .began:
            interruptedWhileRinging = isRinging
        case .ended:
            // Resume whether or not the system suggests it: for an alarm,
            // "should resume" is not the system's call to make.
            if interruptedWhileRinging {
                interruptedWhileRinging = false
                activateForAlarm()
                alarmPlayer?.play()
            } else if UserDefaults.standard.bool(forKey: kRinging) {
                let sound = UserDefaults.standard.string(forKey: kSound) ?? "chime.wav"
                let morning = UserDefaults.standard.string(forKey: kMorning) ?? ""
                fireAlarm(soundFile: sound, morning: morning)
            } else {
                startKeepalive()
            }
            emit()
        @unknown default: break
        }
    }

    /// Headphones pulled out. iOS pauses by default - an alarm must not.
    @objc private func handleRouteChange(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        guard reason == .oldDeviceUnavailable else { return }
        if UserDefaults.standard.bool(forKey: kRinging) {
            activateForAlarm()
            if alarmPlayer?.isPlaying != true { alarmPlayer?.play() }
        } else if isKeepingAlive {
            activateForKeepalive()
            keepalivePlayer?.play()
        }
        emit()
    }

    /// Audio stack restarted underneath us; every player is invalid.
    @objc private func handleMediaReset(_ note: Notification) {
        let d = UserDefaults.standard
        alarmPlayer = nil
        keepalivePlayer = nil
        if d.bool(forKey: kRinging) {
            fireAlarm(soundFile: d.string(forKey: kSound) ?? "chime.wav",
                      morning: d.string(forKey: kMorning) ?? "")
        } else {
            startKeepalive()
        }
    }
}
