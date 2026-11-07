//
//  DawnAlarmKit.swift
//  A Capacitor plugin wrapping AlarmKit (iOS 26.1+), replacing local
//  notifications as the primary alarm on devices that support it.
//
//  WHY: local notifications and this app's own prior AVAudioSession engine
//  (DawnAlarmAudio.swift) can both be silenced without the app ever running -
//  a swipe, or on-device testing proved, even a volume-button press. AlarmKit
//  alarms are owned by the system the same way Clock app alarms are: no
//  third-party code, including this file, can make them easier to dismiss
//  than Apple allows, which is exactly the property this product needs.
//
//  THE ONE SYSTEM BUTTON: AlarmPresentation.Alert's `stopButton` has been
//  deprecated since iOS 26.1 ("not used anymore and will be removed") - Apple
//  no longer lets an app even label it, let alone hide it. So "stop" is not
//  interpreted as "mission over" here. Tapping it runs DawnAlarmStopIntent,
//  which opens the app to the push-up screen and schedules a near-term
//  follow-up alarm unconditionally - the mission is not actually over until
//  JS calls completeMission() from the same onFinish() path that already
//  silences every other alarm path in this app (see main.js).
//
//  TAP THE BUTTON, DO NOT SWIPE THE ALERT AWAY: on-device testing strongly
//  suggests swiping a locked-screen alert dismisses it as a system-level
//  gesture that never reaches this intent at all, while tapping the actual
//  button reaches it reliably. (An earlier version set openAppWhenRun = false
//  to chase what looked like a reliability race; the real variable across
//  those tests was almost certainly tap-vs-swipe, not that coupling - put
//  back to true once tapping was confirmed reliable.)
//
//  NO SECONDARY BUTTON: AlarmPresentation.Alert's secondaryButton is left
//  nil - that satisfies "remove the snooze option" directly rather than
//  routing a second button into the same push-up flow Stop already reaches.
//
//  ONE RECURRING ALARM + ONE EPHEMERAL FOLLOW-UP: scheduleAlarm() creates a
//  single long-lived AlarmKit alarm that recurs on the chosen days, exactly
//  like a Clock app alarm - dismissing a day's ring does not cancel
//  tomorrow's. The short-interval "ring again" alarm DawnAlarmStopIntent
//  creates on every Stop is a separate, internal, one-off alarm; JS never
//  sees or names it directly. completeMission() cancels whichever one of
//  those is currently outstanding.
//
import Foundation
import AlarmKit
import AppIntents
import ActivityKit
import Capacitor

// MARK: - Shared state
//
// App Intents attached to an AlarmKit alert run in-process here (there is no
// widget extension in this project), so UserDefaults.standard is genuinely
// shared between the intents below and the rest of the app - verified by the
// same mechanism already proven in DawnAlarmAudio.swift's kRinging/kMorning.

private let kIdMap        = "dawn.alarmkit.idMap"        // [uuidString: callerId]
private let kFollowUpId   = "dawn.alarmkit.followUpId"   // uuidString, or absent
private let kWantsPushups = "dawn.alarmkit.wantsPushupScreen"
private let kMorning      = "dawn.alarmkit.morning"
// The bundle-root wav filename (e.g. "chime.wav") picked in the sound
// picker - the same files @capacitor/local-notifications already uses, so a
// follow-up alarm Stop reschedules rings with the same sound as the original,
// not a silent fallback to the system default.
private let kAlarmSound    = "dawn.alarmkit.sound"
// Surfaced through listAlarms() -> the on-screen debug readout, so a failure
// inside the Stop intent is visible without needing Xcode's console at all -
// that round-trip has proven too much UI friction to rely on in practice.
private let kLastError     = "dawn.alarmkit.lastError"
private let kLastStopIntentAt = "dawn.alarmkit.lastStopIntentAt"

/// How soon Stop re-rings if the mission is not done. Short enough that
/// walking away does not buy real rest; long enough to actually reach the
/// push-up screen and start a set.
private let kFollowUpSeconds: TimeInterval = 60

@available(iOS 26.1, *)
struct DawnMissionMetadata: AlarmMetadata {}

/// Opens the app to the push-up screen without touching the alarm's state -
/// used if a secondary/open button is ever reintroduced. Not currently wired
/// to anything (see NO SECONDARY BUTTON above); kept because DawnAlarmStopIntent
/// does the identical "set the flag" half of this inline, and a future
/// countdown/paused presentation may want its own open-only button.
@available(iOS 26.1, *)
struct DawnOpenPushupsIntent: AppIntent, LiveActivityIntent {
    static var title: LocalizedStringResource = "Push-ups"
    static var openAppWhenRun: Bool { true }

    func perform() async throws -> some IntentResult {
        UserDefaults.standard.set(true, forKey: kWantsPushups)
        return .result()
    }
}

/// The alarm's one button. Rearms a short follow-up alarm unconditionally -
/// Stop is never treated as "done." completeMission() is the only thing that
/// cancels the follow-up.
///
/// openAppWhenRun is true - see the file header's TAP THE BUTTON note for why
/// (an earlier version set this false chasing what looked like a reliability
/// race; the real variable was tap-vs-swipe, not this coupling). The
/// kWantsPushups/kMorning flags are still set below so they are picked up the
/// next time the app opens by any means, same as before.
@available(iOS 26.1, *)
struct DawnAlarmStopIntent: AppIntent, LiveActivityIntent {
    static var title: LocalizedStringResource = "Stop"
    static var openAppWhenRun: Bool { true }

    func perform() async throws -> some IntentResult {
        // Set before anything else can fail or be cut short, so the debug
        // readout can distinguish "perform() never ran at all" (this stays
        // absent/stale) from "it ran but scheduleFollowUp threw" (kLastError
        // below gets set) from "it ran and worked" (neither is set).
        UserDefaults.standard.set("\(Date())", forKey: kLastStopIntentAt)
        // scheduleFollowUp() next, before anything else: on a real device
        // test, nothing re-rang when the phone stayed locked after Stop
        // (openAppWhenRun's launch can't proceed without unlocking) - whatever
        // is cutting this intent's execution short, the one thing that must
        // survive that cutoff is the re-ring itself, not the UI flags below.
        // Not swallowed with try? anymore: if this throws, it needs to be
        // visible, not silently lost.
        do {
            try await DawnAlarmKitEngine.scheduleFollowUp()
            UserDefaults.standard.removeObject(forKey: kLastError)
        } catch {
            let msg = "\(Date()): scheduleFollowUp failed: \(error)"
            CAPLog.print("DawnAlarmKit: \(msg)")
            UserDefaults.standard.set(msg, forKey: kLastError)
        }
        let d = UserDefaults.standard
        d.set(true, forKey: kWantsPushups)
        // "Today" at the moment Stop is tapped, in the device's own calendar -
        // must match alarm.js's dayKey() format (local Y-M-D) so JS can use
        // it as the morning key when it calls enterRing().
        d.set(DawnAlarmKitEngine.todayKey(), forKey: kMorning)
        return .result()
    }
}

@available(iOS 26.1, *)
enum DawnAlarmKitEngine {

    static func todayKey(from date: Date = Date()) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    // MARK: id <-> UUID mapping (JS never sees AlarmKit's UUIDs)

    private static func readMap() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: kIdMap) as? [String: String] ?? [:]
    }
    private static func writeMap(_ map: [String: String]) {
        UserDefaults.standard.set(map, forKey: kIdMap)
    }
    static func remember(callerId: String, uuid: UUID) {
        var map = readMap(); map[uuid.uuidString] = callerId; writeMap(map)
    }
    static func forget(callerId: String) {
        var map = readMap()
        for (k, v) in map where v == callerId { map.removeValue(forKey: k) }
        writeMap(map)
    }
    static func uuid(forCallerId callerId: String) -> UUID? {
        guard let s = readMap().first(where: { $0.value == callerId })?.key else { return nil }
        return UUID(uuidString: s)
    }
    static func callerId(forUUIDString s: String) -> String? { readMap()[s] }

    // MARK: weekday mapping - JS convention matches Date.getDay(): 0=Sunday

    static func weekday(fromJSDay d: Int) -> Locale.Weekday? {
        switch d {
        case 0: return .sunday
        case 1: return .monday
        case 2: return .tuesday
        case 3: return .wednesday
        case 4: return .thursday
        case 5: return .friday
        case 6: return .saturday
        default: return nil
        }
    }
    static func jsDay(fromWeekday w: Locale.Weekday) -> Int {
        switch w {
        case .sunday: return 0
        case .monday: return 1
        case .tuesday: return 2
        case .wednesday: return 3
        case .thursday: return 4
        case .friday: return 5
        case .saturday: return 6
        @unknown default: return -1
        }
    }

    static func statusString(_ s: AlarmManager.AuthorizationState) -> String {
        switch s {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notDetermined"
        }
    }

    // MARK: configuration

    static func makeConfig(label: String, schedule: Alarm.Schedule?, soundFile: String?)
        -> AlarmManager.AlarmConfiguration<DawnMissionMetadata> {
        let alert = AlarmPresentation.Alert(
            title: LocalizedStringResource(stringLiteral: label))
            // secondaryButton deliberately omitted - see file header.
        let attributes = AlarmAttributes(
            presentation: AlarmPresentation(alert: alert),
            metadata: DawnMissionMetadata(),
            tintColor: .red)
        // AlertConfiguration.AlertSound.named expects a bundle-root resource
        // name, same convention @capacitor/local-notifications already uses
        // for these same files - see scripts/add-ios-sounds.cjs.
        let sound: AlertConfiguration.AlertSound = soundFile.map { .named($0) } ?? .default
        return AlarmManager.AlarmConfiguration<DawnMissionMetadata>.alarm(
            schedule: schedule,
            attributes: attributes,
            stopIntent: DawnAlarmStopIntent(),
            sound: sound)
    }

    /// The near-term alarm Stop rearms. Replaces whatever follow-up already
    /// existed (cancelling it first) so repeated Stop taps cannot pile up
    /// alarms toward AlarmError.maximumLimitReached. Reuses whatever sound
    /// scheduleAlarm last recorded, so a re-ring does not silently drop back
    /// to the system default.
    @discardableResult
    static func scheduleFollowUp(after seconds: TimeInterval = kFollowUpSeconds) async throws -> Alarm {
        let d = UserDefaults.standard
        if let old = d.string(forKey: kFollowUpId), let oldUUID = UUID(uuidString: old) {
            stopIfAlerting(id: oldUUID)
            _ = try? AlarmManager.shared.cancel(id: oldUUID)
        }
        let id = UUID()
        let config = makeConfig(label: "Dawn Alarm",
                                 schedule: .fixed(Date().addingTimeInterval(seconds)),
                                 soundFile: d.string(forKey: kAlarmSound))
        let alarm = try await AlarmManager.shared.schedule(id: id, configuration: config)
        d.set(id.uuidString, forKey: kFollowUpId)
        return alarm
    }

    static func cancelFollowUpIfAny() {
        let d = UserDefaults.standard
        guard let s = d.string(forKey: kFollowUpId), let uuid = UUID(uuidString: s) else { return }
        stopIfAlerting(id: uuid)
        _ = try? AlarmManager.shared.cancel(id: uuid)
        d.removeObject(forKey: kFollowUpId)
    }

    /// cancel(id:) and stop(id:) are different AlarmKit operations - ground-
    /// truthed in AlarmKit.swiftinterface, not guessed: cancel() removes a
    /// scheduled alarm, stop() ends one that is actively alerting right now.
    /// A real-device test proved cancel() ALONE does not silence a ringing
    /// alarm - swiping the alert, or tapping Disarm in the app while it was
    /// ringing, left the sound going. Call this before cancel(id:) wherever
    /// an alarm is being retired, so an in-progress alert is actually
    /// silenced rather than just unscheduled. Failing here (because the
    /// alarm was not actually alerting) is expected and ignored.
    static func stopIfAlerting(id: UUID) {
        try? AlarmManager.shared.stop(id: id)
    }
}

@objc(DawnAlarmKitPlugin)
public class DawnAlarmKitPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DawnAlarmKitPlugin"
    public let jsName = "DawnAlarmKit"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleAlarm",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelAlarm",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listAlarms",            returnType: CAPPluginReturnPromise),
        // Beyond the four above: both are needed to actually satisfy "ring
        // again until push-ups are done" and "open straight to the push-up
        // screen" - see the file header for why.
        CAPPluginMethod(name: "completeMission",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumePushupIntent",   returnType: CAPPluginReturnPromise)
    ]

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard #available(iOS 26.1, *) else {
            call.resolve(["status": "unavailable"]); return
        }
        Task {
            do {
                let state = try await AlarmManager.shared.requestAuthorization()
                call.resolve(["status": DawnAlarmKitEngine.statusString(state)])
            } catch {
                call.resolve(["status": "unavailable", "error": "\(error)"])
            }
        }
    }

    @objc func scheduleAlarm(_ call: CAPPluginCall) {
        guard #available(iOS 26.1, *) else {
            call.reject("AlarmKit unavailable on this iOS version"); return
        }
        guard let callerId = call.getString("id"),
              let hour = call.getInt("hour"),
              let minute = call.getInt("minute") else {
            call.reject("id, hour and minute are required"); return
        }
        let label = call.getString("label") ?? "Time to get up"
        let repeatDays = (call.getArray("repeatDays", Int.self)) ?? []
        let soundFile = call.getString("sound")
        Task {
            do {
                // Schedule the NEW alarm FIRST. Only once that has actually
                // succeeded do we cancel whatever was there before - so a
                // failure here (network hiccup talking to the system daemon,
                // whatever) never leaves a gap with no alarm at all between
                // cancelling the old one and the new one landing.
                let weekdays = repeatDays.compactMap { DawnAlarmKitEngine.weekday(fromJSDay: $0) }
                let time = Alarm.Schedule.Relative.Time(hour: hour, minute: minute)
                let schedule = Alarm.Schedule.relative(.init(
                    time: time,
                    repeats: weekdays.isEmpty ? .never : .weekly(weekdays)))
                let uuid = UUID()
                let config = DawnAlarmKitEngine.makeConfig(label: label, schedule: schedule, soundFile: soundFile)
                let alarm = try await AlarmManager.shared.schedule(id: uuid, configuration: config)

                // Only now, with the replacement confirmed live, retire the
                // old one under this id (if any).
                let old = DawnAlarmKitEngine.uuid(forCallerId: callerId)
                DawnAlarmKitEngine.remember(callerId: callerId, uuid: uuid)
                if let old, old != uuid {
                    DawnAlarmKitEngine.stopIfAlerting(id: old)
                    _ = try? AlarmManager.shared.cancel(id: old)
                }

                if let soundFile { UserDefaults.standard.set(soundFile, forKey: kAlarmSound) }
                call.resolve(["id": callerId, "state": "\(alarm.state)"])
            } catch {
                call.reject("scheduleAlarm failed: \(error)")
            }
        }
    }

    @objc func cancelAlarm(_ call: CAPPluginCall) {
        guard #available(iOS 26.1, *) else { call.resolve(["ok": true]); return }
        guard let callerId = call.getString("id") else {
            call.reject("id is required"); return
        }
        guard let uuid = DawnAlarmKitEngine.uuid(forCallerId: callerId) else {
            call.resolve(["ok": true]); return
        }
        do {
            // stop() first: this is the Disarm button's only path to actually
            // silence an alarm that is ringing right now, not just one that is
            // merely scheduled. See stopIfAlerting's comment for why cancel()
            // alone is not enough. Also clear any pending follow-up (in case
            // Stop was tapped earlier and this is a full disarm before the
            // follow-up fired) so Disarm truly means nothing rings again.
            DawnAlarmKitEngine.stopIfAlerting(id: uuid)
            try AlarmManager.shared.cancel(id: uuid)
            DawnAlarmKitEngine.forget(callerId: callerId)
            DawnAlarmKitEngine.cancelFollowUpIfAny()
            call.resolve(["ok": true])
        } catch {
            call.reject("cancelAlarm failed: \(error)")
        }
    }

    @objc func listAlarms(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
        // Visible on screen without Xcode: when the Stop intent last ran at
        // all (absent means it never ran - e.g. the system never invoked it
        // while locked), and the error from its last scheduleFollowUp() call,
        // if any.
        var debug: [String: Any] = [
            "lastStopIntentAt": d.string(forKey: kLastStopIntentAt) ?? "",
            "lastFollowUpError": d.string(forKey: kLastError) ?? ""
        ]
        guard #available(iOS 26.1, *) else {
            call.resolve(["alarms": [], "debug": debug]); return
        }
        do {
            let all = try AlarmManager.shared.alarms
            // The follow-up alarm is deliberately excluded from the list
            // below (JS has no id for it), but whether it actually exists in
            // the system - and what state it's in - is exactly the question
            // when it was scheduled without error but never audibly rang.
            if let followUpIdStr = d.string(forKey: kFollowUpId), let followUpUUID = UUID(uuidString: followUpIdStr) {
                if let found = all.first(where: { $0.id == followUpUUID }) {
                    debug["followUpAlarmState"] = "\(found.state)"
                } else {
                    debug["followUpAlarmState"] = "not found in AlarmManager.alarms"
                }
            } else {
                debug["followUpAlarmState"] = "(no follow-up currently tracked)"
            }
            let out: [[String: Any]] = all.compactMap { a in
                guard let callerId = DawnAlarmKitEngine.callerId(forUUIDString: a.id.uuidString) else {
                    return nil   // internal follow-up alarms are not JS's concern
                }
                var entry: [String: Any] = ["id": callerId, "state": "\(a.state)"]
                if let schedule = a.schedule, case .relative(let rel) = schedule {
                    entry["hour"] = rel.time.hour
                    entry["minute"] = rel.time.minute
                    if case .weekly(let days) = rel.repeats {
                        entry["repeatDays"] = days.map { DawnAlarmKitEngine.jsDay(fromWeekday: $0) }
                    } else {
                        entry["repeatDays"] = []
                    }
                }
                return entry
            }
            call.resolve(["alarms": out, "debug": debug])
        } catch {
            call.reject("listAlarms failed: \(error)")
        }
    }

    /// Called from the same onFinish() path that already silences every
    /// other alarm mechanism in this app - never on a tap, swipe, or the app
    /// merely opening. Cancels the short follow-up Stop may have armed.
    /// The main recurring alarm is untouched: tomorrow still rings.
    @objc func completeMission(_ call: CAPPluginCall) {
        guard #available(iOS 26.1, *) else { call.resolve(["ok": true]); return }
        DawnAlarmKitEngine.cancelFollowUpIfAny()
        call.resolve(["ok": true])
    }

    /// Polled at boot and on foreground - mirrors how wasRingingAtLaunch
    /// already works in DawnAlarmAudio.swift. Clears the flag atomically so
    /// it is only ever consumed once.
    @objc func consumePushupIntent(_ call: CAPPluginCall) {
        let d = UserDefaults.standard
        let wants = d.bool(forKey: kWantsPushups)
        let morning = d.string(forKey: kMorning) ?? ""
        if wants { d.set(false, forKey: kWantsPushups) }
        call.resolve(["wants": wants, "morning": morning])
    }
}
