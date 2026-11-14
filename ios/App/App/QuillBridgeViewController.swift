import UIKit
import Capacitor

/// The app's bridge view controller: registers the app's own plugin (QuillIOSPlugin), which is not an npm
/// package and so is not found by Capacitor's automatic plugin registration.
/// Main.storyboard and SceneDelegate both use this class.
class QuillBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(QuillIOSPlugin())
    }
}
