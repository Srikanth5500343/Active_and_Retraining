//
//  RackARPlugin.m
//
//  Capacitor needs an Objective-C bridge file to discover the plugin
//  methods from the JS side. Each @objc method on the Swift plugin
//  class needs a CAP_PLUGIN_METHOD entry here so that when JS calls
//  RackAR.start(), Capacitor can find the matching `start:` selector.
//

#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(RackARPlugin, "RackAR",
    CAP_PLUGIN_METHOD(isSupported,        CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(requestPermissions, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(start,              CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(setOverlay,         CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stop,               CAPPluginReturnPromise);
)
