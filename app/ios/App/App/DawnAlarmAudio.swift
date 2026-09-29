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

    var onStateChange: (([String: Any]) -> Void)?

    // Survives a crash or a force-quit, so the app can work out on next launch
    // that it *should* have been ringing.
    private let kRinging = "dawn.audio.ringing"
    private let kMorning = "dawn.audio.morning"
    private let kSound   = "dawn.audio.sound"

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
            "morning": UserDefaults.standard.string(forKey: kMorning) ?? ""
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
        if isKeepingAlive { return }
        activateForKeepalive()
        keepalivePlayer = player(for: "keepalive.wav", volume: 0.0, loops: -1)
        keepalivePlayer?.play()
        emit()
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
        wasRingingAtLaunch = false
        if returningToKeepalive { startKeepalive() } else { deactivate() }
        emit()
    }

    func stopEverything() {
        alarmPlayer?.stop(); alarmPlayer = nil
        keepalivePlayer?.stop(); keepalivePlayer = nil
        let d = UserDefaults.standard
        d.set(false, forKey: kRinging)
        d.removeObject(forKey: kMorning)
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
