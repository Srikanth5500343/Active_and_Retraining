//
//  RackARViewController.swift
//
//  Fullscreen ARKit view that renders the live camera feed and floats
//  device-name labels above each detected rack device.
//
//  Detection is NOT done on-device here — the JS layer ships a frame to
//  the server (existing /api/analyze pipeline), gets back a list of
//  device bboxes in image-space, and pushes them via setOverlay(). This
//  controller projects each bbox forward into world-space and parents a
//  SCNText node to it so it stays anchored to the device as the user
//  moves the phone.
//
//  Tap behavior: tapping a label posts back via onTap(id) so the JS
//  layer can navigate ("show me port 15 on this switch", etc.).
//

import UIKit
import ARKit
import SceneKit
import AVFoundation

public struct RackARLabel {
    let id: String
    let label: String
    let sublabel: String?
    let color: String?
    /// Image-space bbox at the time of capture: (x, y, w, h).
    let bbox: (Double, Double, Double, Double)
}

public final class RackARViewController: UIViewController, ARSCNViewDelegate, ARSessionDelegate {

    // MARK: - Public capability checks (read by RackARPlugin)
    public static var isARAvailable: Bool {
        return ARWorldTrackingConfiguration.isSupported
    }
    public static var cameraAuthState: String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:    return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default:    return "prompt"
        }
    }
    public static func requestCamera(_ done: @escaping (Bool) -> Void) {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async { done(granted) }
        }
    }

    // MARK: - Configuration set by the plugin
    public var frameRateHz: Double = 1.0
    public var onFrame: ((String, Int, Int, Double) -> Void)?
    public var onTap:   ((String) -> Void)?
    public var onEnded: ((String) -> Void)?

    // MARK: - AR scene + UI
    private let arView = ARSCNView(frame: .zero)
    private let closeButton = UIButton(type: .system)
    private let infoLabel = UILabel()

    /// Currently displayed labels keyed by id, so setOverlay can do
    /// minimal updates (insert / move / remove) without flicker.
    private var nodes: [String: SCNNode] = [:]

    /// Last-frame timestamp (ARFrame.timestamp), throttled to frameRateHz.
    private var lastFrameForwardedAt: TimeInterval = 0

    // MARK: - Lifecycle
    public override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        // AR scene
        arView.frame = view.bounds
        arView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        arView.session.delegate = self
        arView.delegate = self
        arView.automaticallyUpdatesLighting = true
        view.addSubview(arView)

        // Close button (top-left, floats over AR)
        closeButton.setTitle("✕", for: .normal)
        closeButton.titleLabel?.font = .systemFont(ofSize: 28, weight: .bold)
        closeButton.setTitleColor(.white, for: .normal)
        closeButton.backgroundColor = UIColor(white: 0, alpha: 0.45)
        closeButton.layer.cornerRadius = 22
        closeButton.frame = CGRect(x: 16, y: 50, width: 44, height: 44)
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(closeButton)

        // Hint label (bottom)
        infoLabel.text = "Point the camera at a rack"
        infoLabel.textColor = .white
        infoLabel.font = .systemFont(ofSize: 14, weight: .medium)
        infoLabel.textAlignment = .center
        infoLabel.backgroundColor = UIColor(white: 0, alpha: 0.45)
        infoLabel.layer.cornerRadius = 12
        infoLabel.layer.masksToBounds = true
        infoLabel.frame = CGRect(x: 24, y: view.bounds.height - 80,
                                  width: view.bounds.width - 48, height: 40)
        infoLabel.autoresizingMask = [.flexibleWidth, .flexibleTopMargin]
        view.addSubview(infoLabel)

        // Tap recognizer for label hits
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        arView.addGestureRecognizer(tap)
    }

    public override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        let cfg = ARWorldTrackingConfiguration()
        cfg.planeDetection = [.vertical]   // racks are vertical surfaces
        cfg.environmentTexturing = .none
        cfg.isAutoFocusEnabled = true
        arView.session.run(cfg, options: [.resetTracking, .removeExistingAnchors])
    }

    public override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        arView.session.pause()
        onEnded?("dismissed")
    }

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    // MARK: - Frame forwarding (throttled to frameRateHz)
    public func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard frameRateHz > 0 else { return }
        let interval = 1.0 / frameRateHz
        let now = frame.timestamp
        if now - lastFrameForwardedAt < interval { return }
        lastFrameForwardedAt = now

        guard let cb = onFrame else { return }

        // Convert the captured pixel buffer to a JPEG. Done off the main
        // thread so we don't stall the AR render loop.
        let pixelBuffer = frame.capturedImage
        DispatchQueue.global(qos: .userInitiated).async {
            let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            let context = CIContext()
            guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
            let uiImage = UIImage(cgImage: cgImage, scale: 1, orientation: .right)
            guard let data = uiImage.jpegData(compressionQuality: 0.65) else { return }
            let b64 = data.base64EncodedString()
            DispatchQueue.main.async {
                cb(b64, Int(uiImage.size.width), Int(uiImage.size.height), now * 1000)
            }
        }
    }

    // MARK: - Overlay management
    /// Replace the currently-anchored labels with `labels`. Existing nodes
    /// for matching ids are repositioned, missing ones are created, and
    /// orphaned ids are removed.
    public func setOverlay(labels: [RackARLabel]) {
        infoLabel.text = labels.isEmpty ? "Point the camera at a rack"
                                        : "\(labels.count) device\(labels.count == 1 ? "" : "s") detected"

        let incoming = Set(labels.map { $0.id })
        // Remove nodes whose labels no longer exist
        for (id, node) in nodes where !incoming.contains(id) {
            node.removeFromParentNode()
            nodes.removeValue(forKey: id)
        }
        // Insert / update
        guard let frame = arView.session.currentFrame else { return }
        let imgSize = CVImageBufferGetEncodedSize(frame.capturedImage)
        let viewSize = arView.bounds.size

        for label in labels {
            let (x, y, w, h) = label.bbox
            // Center of the bbox in image space
            let cxImg = x + w / 2
            let cyImg = y + h / 2
            // Map image coords → view coords
            let sx = viewSize.width  / imgSize.width
            let sy = viewSize.height / imgSize.height
            let viewPoint = CGPoint(x: CGFloat(cxImg) * sx,
                                    y: CGFloat(cyImg) * sy)
            // Hit-test against tracked planes / feature points so the
            // label "sticks" to the rack surface instead of floating.
            // Falls back to a fixed distance forward from the camera if
            // no AR anchor is hittable yet.
            let target = worldPosition(forViewPoint: viewPoint, frame: frame)

            if let existing = nodes[label.id] {
                existing.position = target
                if let node = existing.childNode(withName: "label", recursively: true)
                    as? SCNNode, let textGeom = node.geometry as? SCNText {
                    textGeom.string = label.label
                }
            } else {
                let node = makeLabelNode(label: label)
                node.position = target
                arView.scene.rootNode.addChildNode(node)
                nodes[label.id] = node
            }
        }
    }

    /// Build a SCNNode containing a flat colored panel + 3D text. Always
    /// faces the camera (billboard constraint) so it's readable from any
    /// angle.
    private func makeLabelNode(label: RackARLabel) -> SCNNode {
        let node = SCNNode()
        node.name = label.id

        // Panel
        let panel = SCNPlane(width: 0.30, height: 0.10)
        let bgColor = uiColor(fromHex: label.color) ?? UIColor(red: 0.13, green: 0.83, blue: 0.93, alpha: 0.85)
        panel.firstMaterial?.diffuse.contents = bgColor
        panel.firstMaterial?.isDoubleSided = true
        panel.cornerRadius = 0.02
        let panelNode = SCNNode(geometry: panel)
        node.addChildNode(panelNode)

        // Text
        let text = SCNText(string: label.label, extrusionDepth: 0.001)
        text.font = UIFont.systemFont(ofSize: 0.05, weight: .bold)
        text.firstMaterial?.diffuse.contents = UIColor.black
        let textNode = SCNNode(geometry: text)
        textNode.name = "label"
        // Center the text on the panel
        let (minVec, maxVec) = text.boundingBox
        textNode.pivot = SCNMatrix4MakeTranslation(
            (maxVec.x - minVec.x) / 2 + minVec.x,
            (maxVec.y - minVec.y) / 2 + minVec.y, 0)
        textNode.position = SCNVector3(0, 0, 0.001)
        panelNode.addChildNode(textNode)

        // Always face the camera
        let billboard = SCNBillboardConstraint()
        billboard.freeAxes = [.Y]
        node.constraints = [billboard]
        return node
    }

    private func worldPosition(forViewPoint vp: CGPoint, frame: ARFrame) -> SCNVector3 {
        // Try a raycast against the detected vertical planes first; that
        // gives the label the right depth (stuck to the rack face).
        if let raycast = arView.raycastQuery(from: vp,
                                              allowing: .estimatedPlane,
                                              alignment: .vertical),
           let result = arView.session.raycast(raycast).first {
            let t = result.worldTransform
            return SCNVector3(t.columns.3.x, t.columns.3.y, t.columns.3.z)
        }
        // Fallback: project the screen point 0.8m in front of the camera.
        let camTransform = frame.camera.transform
        let forward = simd_make_float3(-camTransform.columns.2.x,
                                        -camTransform.columns.2.y,
                                        -camTransform.columns.2.z) * 0.8
        let pos = simd_make_float3(camTransform.columns.3.x,
                                    camTransform.columns.3.y,
                                    camTransform.columns.3.z) + forward
        return SCNVector3(pos.x, pos.y, pos.z)
    }

    private func uiColor(fromHex hex: String?) -> UIColor? {
        guard var s = hex?.lowercased(), s.hasPrefix("#"), s.count == 7 else { return nil }
        s.removeFirst()
        var rgb: UInt64 = 0
        guard Scanner(string: s).scanHexInt64(&rgb) else { return nil }
        return UIColor(
            red:   CGFloat((rgb & 0xFF0000) >> 16) / 255.0,
            green: CGFloat((rgb & 0x00FF00) >>  8) / 255.0,
            blue:  CGFloat( rgb & 0x0000FF        ) / 255.0,
            alpha: 0.88
        )
    }

    // MARK: - Tap handling
    @objc private func handleTap(_ recognizer: UITapGestureRecognizer) {
        let p = recognizer.location(in: arView)
        let hits = arView.hitTest(p, options: [.searchMode: SCNHitTestSearchMode.closest.rawValue])
        for hit in hits {
            // Walk up to find the labelled root node
            var n: SCNNode? = hit.node
            while let node = n {
                if let id = node.name, nodes[id] != nil {
                    onTap?(id)
                    return
                }
                n = node.parent
            }
        }
    }
}

// Helper missing on older SDKs — image-buffer size in pixels
@inline(__always)
private func CVImageBufferGetEncodedSize(_ buffer: CVPixelBuffer) -> CGSize {
    return CGSize(width: CVPixelBufferGetWidth(buffer),
                  height: CVPixelBufferGetHeight(buffer))
}
