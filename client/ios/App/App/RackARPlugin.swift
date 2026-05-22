//
//  RackARPlugin.swift
//
//  Capacitor plugin glue for the RackAR native AR rack-overlay view.
//
//  Architecture:
//    JS ──RackAR.start()──> RackARPlugin.start()
//          └─ presents RackARViewController fullscreen over the WebView
//          └─ posts 'frame' events back at frameRateHz
//    JS ──RackAR.setOverlay({devices})──> RackARPlugin.setOverlay()
//          └─ controller renders SCNText nodes anchored on top of the
//             ARSCNView, positioned by the device bbox in image-space
//    JS ──RackAR.stop()──> dismiss controller, restore WebView
//
//  All AR work lives in RackARViewController; this file is just the
//  Capacitor bridge.
//

import Foundation
import Capacitor

@objc(RackARPlugin)
public class RackARPlugin: CAPPlugin {
    private weak var controller: RackARViewController?

    @objc func isSupported(_ call: CAPPluginCall) {
        let arOK = RackARViewController.isARAvailable
        let camStatus = RackARViewController.cameraAuthState
        call.resolve([
            "ar": arOK,
            "camera": camStatus,
            "platform": "ios",
        ])
    }

    @objc func requestPermissions(_ call: CAPPluginCall) {
        RackARViewController.requestCamera { granted in
            call.resolve([
                "ar": RackARViewController.isARAvailable,
                "camera": granted ? "granted" : "denied",
                "platform": "ios",
            ])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        guard RackARViewController.isARAvailable else {
            call.reject("AR not supported on this device")
            return
        }
        let frameRateHz = call.getDouble("frameRateHz") ?? 1.0

        DispatchQueue.main.async { [weak self] in
            guard let self = self,
                  let bridge = self.bridge,
                  let root   = bridge.viewController else {
                call.reject("No host view controller")
                return
            }
            // If already running, just update the frame rate
            if let existing = self.controller {
                existing.frameRateHz = frameRateHz
                call.resolve()
                return
            }
            let vc = RackARViewController()
            vc.frameRateHz = frameRateHz
            vc.modalPresentationStyle = .fullScreen
            vc.onFrame = { [weak self] jpegBase64, w, h, ts in
                self?.notifyListeners("frame", data: [
                    "jpegBase64": jpegBase64,
                    "width": w,
                    "height": h,
                    "ts": ts,
                ])
            }
            vc.onTap = { [weak self] id in
                self?.notifyListeners("tap", data: ["id": id])
            }
            vc.onEnded = { [weak self] reason in
                self?.notifyListeners("ended", data: ["reason": reason])
                self?.controller = nil
            }
            self.controller = vc
            root.present(vc, animated: true) { call.resolve() }
        }
    }

    @objc func setOverlay(_ call: CAPPluginCall) {
        guard let controller = self.controller else {
            call.reject("AR not active — call start() first")
            return
        }
        let devices = call.getArray("devices", JSObject.self) ?? []
        var labels: [RackARLabel] = []
        for d in devices {
            guard let id = d["id"] as? String,
                  let label = d["label"] as? String,
                  let bboxArr = d["bbox"] as? [Any], bboxArr.count == 4 else {
                continue
            }
            let bbox = bboxArr.compactMap { ($0 as? NSNumber)?.doubleValue }
            guard bbox.count == 4 else { continue }
            labels.append(RackARLabel(
                id: id,
                label: label,
                sublabel: d["sublabel"] as? String,
                color: d["color"] as? String,
                bbox: (bbox[0], bbox[1], bbox[2], bbox[3])
            ))
        }
        DispatchQueue.main.async { [weak controller] in
            controller?.setOverlay(labels: labels)
            call.resolve()
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard let controller = self.controller else {
            call.resolve()
            return
        }
        DispatchQueue.main.async { [weak self] in
            controller.dismiss(animated: true) {
                self?.controller = nil
                call.resolve()
            }
        }
    }
}
