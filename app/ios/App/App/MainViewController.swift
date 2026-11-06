//
//  MainViewController.swift
//  Registers this app's own native plugins.
//
//  WHY THIS FILE EXISTS: Capacitor's `cap sync` auto-populates
//  capacitor.config.json's packageClassList by scanning each INSTALLED NPM
//  PACKAGE's own ios/ directory (see @capacitor/cli's iosplugin.js) - it never
//  looks at this app target's own Swift files. A CAPBridgedPlugin-conforming
//  class that lives directly in the app (DawnAlarmAudioPlugin,
//  DawnAlarmKitPlugin - neither is an npm package) is therefore never added
//  to that list, never gets its JS-side PluginHeader exported, and every call
//  to it from JS throws Capacitor's generic "UNIMPLEMENTED" error - silently
//  caught and swallowed by both plugins' JS wrappers, so this produced no
//  visible failure beyond the alarm just not working right.
//
//  The fix is Capacitor's own documented extension point: subclass
//  CAPBridgeViewController and register local plugins explicitly in
//  capacitorDidLoad(). SceneDelegate.swift instantiates this class instead of
//  the stock CAPBridgeViewController().
//
import Capacitor

class MainViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DawnAlarmAudioPlugin())
        bridge?.registerPluginInstance(DawnAlarmKitPlugin())
    }
}
