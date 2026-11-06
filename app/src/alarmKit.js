// Bridge to the native AlarmKit plugin (ios/App/App/DawnAlarmKit.swift).
//
// AlarmKit (iOS 26.1+) alarms are owned by the system the same way Clock app
// alarms are - nothing short of Apple's own stop button can silence one, and
// as of 26.1 that button cannot even be relabeled, let alone hidden. That is
// the property local notifications and this app's prior AVAudioSession
// engine (alarmAudio.js) both lacked: both proved silenceable without the
// app ever running - a swipe, or on a real device test, even a volume-button
// press.
//
// On iOS < 26.1, requestAuthorization() resolves 'unavailable' and arm()/
// disarm() in alarm.js fall back to the notification + background-audio path
// entirely - see useAlarmKit() there.
import { registerPlugin, Capacitor } from '@capacitor/core';

const webStub = {
  async requestAuthorization(){ return { status: 'unavailable' }; },
  async scheduleAlarm(){ return { id: '', state: 'unavailable' }; },
  async cancelAlarm(){ return { ok: true }; },
  async listAlarms(){ return { alarms: [], debug: { lastStopIntentAt: '', lastFollowUpError: '', followUpAlarmState: '' } }; },
  async completeMission(){ return { ok: true }; },
  async consumePushupIntent(){ return { wants: false, morning: '' }; }
};

const Native = registerPlugin('DawnAlarmKit', { web: async () => webStub });

export const isNative = Capacitor.isNativePlatform();

async function call(name, args){
  if (!isNative) return webStub[name]();
  try { return await Native[name](args || {}); }
  catch (e){ console.warn('DawnAlarmKit.' + name + ' failed:', e); throw e; }
}

/** { status: 'authorized' | 'denied' | 'notDetermined' | 'unavailable' } */
export const requestAuthorization = () => call('requestAuthorization');

/**
 * Schedules (or replaces) the single recurring alarm under `id`. Recurs
 * forever on `repeatDays` (0=Sunday..6=Saturday, matching Date.getDay();
 * empty means a one-time alarm, not "every day" - pass all seven for daily).
 * Dismissing one morning's ring does not cancel the rest - only cancelAlarm
 * does that.
 * @param {{id:string, hour:number, minute:number, repeatDays:number[], label:string}} opts
 * @returns {Promise<{id:string, state:string}>}
 */
export const scheduleAlarm = (opts) => call('scheduleAlarm', opts);

/** Cancels the recurring alarm under `id` entirely (the disarm path). */
export const cancelAlarm = (id) => call('cancelAlarm', { id });

/** @returns {Promise<{alarms:{id:string,state:string,hour:number,minute:number,repeatDays:number[]}[]}>} */
export const listAlarms = () => call('listAlarms');

/**
 * THE dismissal point - call only from the same onFinish() path that already
 * silences every other alarm mechanism (reps complete, 30s timer, or a
 * deliberate bail). Cancels whatever short follow-up alarm Stop may have
 * armed; the recurring alarm itself is untouched, so tomorrow still rings.
 */
export const completeMission = () => call('completeMission');

/**
 * Poll at boot and on foreground (mirrors alarmAudio.js's wasRingingAtLaunch).
 * True exactly once per Stop tap, then clears itself.
 * @returns {Promise<{wants:boolean, morning:string}>}
 */
export const consumePushupIntent = () => call('consumePushupIntent');
