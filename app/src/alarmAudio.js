// Bridge to the native background-audio plugin (ios/App/App/DawnAlarmAudio.swift).
//
// Why this and not notifications: iOS caps a notification sound at 30 seconds
// and cannot repeat one, so a notification alarm always stops on its own.
// Why not AlarmKit (iOS 26): its system alert always carries a Stop button -
// Apple's docs say "the system provides a stop button automatically" - so the
// alarm can be silenced without the app running, which is the one thing this
// product cannot allow.
//
// An AVAudioSession in .playback keeps running in the background and plays on
// the media channel, so it also ignores the physical silent switch. The loop
// stops only when this module is told to stop it, which happens exclusively on
// a completed set or an escape hatch.
import { registerPlugin, Capacitor } from '@capacitor/core';

const IDLE = { ringing: false, keepalive: false, sound: '', wasRingingAtLaunch: false, morning: '' };

// The web build has no plugin. Everything no-ops so `vite dev` still runs the
// whole flow; the ring screen falls back to an HTML <audio> element there.
const webStub = {
  async startKeepalive(){ return IDLE; },
  async stopKeepalive(){ return IDLE; },
  async fireAlarm(){ return IDLE; },
  async stopAlarm(){ return IDLE; },
  async getState(){ return IDLE; }
};

const Native = registerPlugin('DawnAlarmAudio', { web: async () => webStub });

export const isNativeAudio = Capacitor.isNativePlatform();

// Every call is wrapped: a plugin that is missing or throws must degrade to the
// notification fallback, never take the app down with it.
async function call(name, args){
  if (!isNativeAudio) return IDLE;
  try { return (await Native[name](args || {})) || IDLE; }
  catch (e){ console.warn('DawnAlarmAudio.' + name + ' failed:', e); return IDLE; }
}

/** Hold the audio session open from arm time to fire time. */
export const startKeepalive = () => call('startKeepalive');
/** Release it - the alarm is disarmed. */
export const stopKeepalive  = () => call('stopKeepalive');
/** Ring, on loop, until stopAlarm(). `morning` is carried so a relaunch knows which. */
export const fireAlarm = (sound, morning) => call('fireAlarm', { sound, morning });
/** The only thing that silences it. */
export const stopAlarm = () => call('stopAlarm');
/** { ringing, keepalive, sound, wasRingingAtLaunch, morning } */
export const getState  = () => call('getState');
