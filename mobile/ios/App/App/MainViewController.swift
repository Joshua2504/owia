import UIKit
import Capacitor
import WebKit

/// Haupt-Ansicht der App: die Capacitor-WebView mit owia.net (mobile/capacitor.config.ts).
class MainViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        // Wischen vom Rand = Zurück/Vor wie in Safari. Ohne diese Geste kommt man
        // aus Seiten ohne eigene Navigation (z. B. ein geöffnetes PDF) nicht zurück.
        webView?.allowsBackForwardNavigationGestures = true
    }
}
