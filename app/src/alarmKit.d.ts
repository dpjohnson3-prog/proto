// Type definitions for the DawnAlarmKit Capacitor plugin
// (native implementation: ios/App/App/DawnAlarmKit.swift).
//
// The project itself is plain JS (see alarmKit.js) - this file exists so
// editors can type-check call sites and so the plugin has a documented,
// stable shape independent of the JS wrapper's implementation.

export type AlarmKitAuthorizationStatus = 'authorized' | 'denied' | 'notDetermined' | 'unavailable';

/** 0=Sunday .. 6=Saturday, matching JavaScript's Date.getDay(). */
export type JSWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ScheduleAlarmOptions {
  /** Caller-chosen identifier. AlarmKit's own UUIDs never reach JS. */
  id: string;
  hour: number;
  minute: number;
  /** Empty means a one-time alarm, not "every day" - pass all seven for daily. */
  repeatDays: JSWeekday[];
  /** Shown as the alert's title on the Lock Screen / Dynamic Island. */
  label: string;
  /**
   * Bundle-root wav filename (e.g. "chime.wav") - the same files
   * @capacitor/local-notifications uses for the legacy path. Omit for the
   * system default alert sound.
   */
  sound?: string;
}

export interface ScheduleAlarmResult {
  id: string;
  /** AlarmKit's Alarm.State, stringified: "scheduled" | "countdown" | "paused" | "alerting". */
  state: string;
}

export interface AlarmInfo {
  id: string;
  state: string;
  hour: number;
  minute: number;
  repeatDays: JSWeekday[];
}

export interface DawnAlarmKitPlugin {
  requestAuthorization(): Promise<{ status: AlarmKitAuthorizationStatus; error?: string }>;
  scheduleAlarm(options: ScheduleAlarmOptions): Promise<ScheduleAlarmResult>;
  cancelAlarm(options: { id: string }): Promise<{ ok: true }>;
  listAlarms(): Promise<{
    alarms: AlarmInfo[];
    /** Diagnostics for the Stop intent's re-ring, surfaced without Xcode. */
    debug: { lastStopIntentAt: string; lastFollowUpError: string; followUpAlarmState: string };
  }>;
  /**
   * Call only from the single onFinish() dismissal point (reps complete, the
   * 30s timer, or a deliberate bail) - never on a tap, swipe, or app open.
   * Cancels any short follow-up alarm Stop armed; the recurring alarm itself
   * is untouched.
   */
  completeMission(): Promise<{ ok: true }>;
  /**
   * Poll at boot and on foreground. True exactly once per Stop tap on the
   * system alert, then clears itself.
   */
  consumePushupIntent(): Promise<{ wants: boolean; morning: string }>;
}
