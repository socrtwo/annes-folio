import Foundation
import Capacitor
import Security
import UIKit

/// Native helpers for Anne's Folio on iOS, used by src/platform/native.ts as the `QuillIOS` plugin:
/// - secureSet / secureGet / secureRemove / secureInfo: API keys in the Keychain (generic passwords,
///   service = the bundle id, readable after the first unlock, never synced or restored to another device).
/// - exportFile: the system export picker for a copy of a file (Files, iCloud Drive, other providers).
/// - printPdf: the system print sheet for PDF bytes.
@objc(QuillIOSPlugin)
public class QuillIOSPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QuillIOSPlugin"
    public let jsName = "QuillIOS"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureInfo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "printPdf", returnType: CAPPluginReturnPromise)
    ]

    /// The export picker's delegate; the picker holds it weakly.
    private var exportDelegate: ExportDelegate?

    // MARK: - Keychain

    private var service: String {
        return Bundle.main.bundleIdentifier ?? "io.github.socrtwo.quillfolio"
    }

    private func keyQuery(_ key: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    @objc func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), let value = call.getString("value") else {
            call.reject("secureSet requires 'key' and 'value'")
            return
        }
        let data = Data(value.utf8)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        var status = SecItemUpdate(keyQuery(key) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var item = keyQuery(key)
            item.merge(attributes) { _, new in new }
            status = SecItemAdd(item as CFDictionary, nil)
        }
        if status == errSecSuccess {
            call.resolve()
        } else {
            call.reject("Could not store the secret in the Keychain (error \(status))")
        }
    }

    @objc func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("secureGet requires 'key'")
            return
        }
        var query = keyQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else {
            // None saved, or the Keychain cannot be read now: the page treats a missing value as "no key".
            call.resolve([:])
        }
    }

    @objc func secureRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("secureRemove requires 'key'")
            return
        }
        let status = SecItemDelete(keyQuery(key) as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Could not remove the secret from the Keychain (error \(status))")
        }
    }

    @objc func secureInfo(_ call: CAPPluginCall) {
        call.resolve(["encrypted": true, "available": true, "backend": "ios-keychain"])
    }

    // MARK: - Export to Files

    @objc func exportFile(_ call: CAPPluginCall) {
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64) else {
            call.reject("exportFile requires 'data' (base64)")
            return
        }
        let name = QuillIOSPlugin.safeFileName(call.getString("name") ?? "document")
        // A folder of its own, so that the copy keeps its name.
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("export-" + UUID().uuidString, isDirectory: true)
        let fileURL = folder.appendingPathComponent(name)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            try? FileManager.default.removeItem(at: folder)
            call.reject("Could not prepare the file for export: \(error.localizedDescription)")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self, let presenter = self.topViewController() else {
                try? FileManager.default.removeItem(at: folder)
                call.reject("The export picker cannot be shown right now")
                return
            }
            let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
            let delegate = ExportDelegate { [weak self] picked in
                try? FileManager.default.removeItem(at: folder)
                self?.exportDelegate = nil
                if let picked = picked {
                    call.resolve(["canceled": false, "name": picked.lastPathComponent])
                } else {
                    call.resolve(["canceled": true])
                }
            }
            self.exportDelegate = delegate
            picker.delegate = delegate
            presenter.present(picker, animated: true)
        }
    }

    // MARK: - Print

    @objc func printPdf(_ call: CAPPluginCall) {
        guard let base64 = call.getString("data"), let data = Data(base64Encoded: base64) else {
            call.reject("printPdf requires 'data' (base64)")
            return
        }
        let jobName = call.getString("jobName") ?? "Anne's Folio document"
        DispatchQueue.main.async { [weak self] in
            guard UIPrintInteractionController.isPrintingAvailable else {
                call.reject("Printing is not available on this device")
                return
            }
            guard UIPrintInteractionController.canPrint(data) else {
                call.reject("This document cannot be printed")
                return
            }
            let controller = UIPrintInteractionController.shared
            let info = UIPrintInfo(dictionary: nil)
            info.outputType = .general
            info.jobName = jobName
            controller.printInfo = info
            controller.printingItem = data
            let done: UIPrintInteractionController.CompletionHandler = { _, completed, error in
                if let error = error {
                    call.reject("Could not print: \(error.localizedDescription)")
                } else {
                    call.resolve(["completed": completed])
                }
            }
            let shown: Bool
            if UIDevice.current.userInterfaceIdiom == .pad, let view = self?.topViewController()?.view {
                // iPad: a popover, anchored to the middle of the screen.
                let anchor = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
                shown = controller.present(from: anchor, in: view, animated: true, completionHandler: done)
            } else {
                shown = controller.present(animated: true, completionHandler: done)
            }
            if !shown {
                call.reject("The print sheet could not be shown")
            }
        }
    }

    // MARK: - Helpers

    /// The view controller on top, so that a sheet opens above anything the app already presents.
    private func topViewController() -> UIViewController? {
        var top = bridge?.viewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }

    static func safeFileName(_ name: String) -> String {
        let cleaned = name
            .components(separatedBy: CharacterSet(charactersIn: "/:\\").union(.controlCharacters))
            .joined(separator: "_")
            .trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "document" : cleaned
    }
}

/// Reports the export picker's outcome once: the place the copy went, or nil when cancelled.
final class ExportDelegate: NSObject, UIDocumentPickerDelegate {
    private var finish: ((URL?) -> Void)?

    init(_ finish: @escaping (URL?) -> Void) {
        self.finish = finish
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish?(urls.first)
        finish = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish?(nil)
        finish = nil
    }
}
