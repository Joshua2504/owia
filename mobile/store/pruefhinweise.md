# Hinweise für die Store-Prüfung

In App Store Connect unter *App-Prüfung → Anmeldeinformationen / Hinweise*,
in der Play Console unter *App-Inhalte → App-Zugriff*. Platzhalter in
`<…>` vor dem Einreichen ersetzen (Werte stehen in der Prod-`.env`:
`APP_REVIEW_EMAIL`, `APP_REVIEW_CODE`).

## Zugangsdaten

- Benutzername: `<APP_REVIEW_EMAIL>`
- Passwort: `<APP_REVIEW_CODE>` (6-stelliger Code)

## Text (Deutsch)

> OWiA hilft Privatpersonen, Parkverstöße beim zuständigen Ordnungsamt
> anzuzeigen. Die Anmeldung läuft normalerweise per Einmal-Code aus einer
> E-Mail. Für die Prüfung gibt es ein Demo-Konto mit festem Code:
>
> 1. App öffnen → „Anmelden“ → E-Mail-Adresse `<APP_REVIEW_EMAIL>` eingeben,
>    Datenschutz bestätigen, Sicherheitsprüfung abwarten, „Code anfordern“.
> 2. Als Code `<APP_REVIEW_CODE>` eingeben.
> 3. Unter „Einstellungen“ einmal Name und Anschrift ausfüllen (beliebige Testwerte).
> 4. Kamera-Modus: Kamera- und Standortfreigabe erlauben, ein beliebiges Motiv
>    fotografieren, „Fertig“. Der Entwurf erscheint unter „Meine Anzeigen“.
>
> Das Demo-Konto kann alles ausprobieren, **reicht aber nichts ein** – nichts
> erreicht eine Behörde. Bitte keine Fotos echter Fahrzeuge verwenden.
> Konto löschen: Einstellungen → „Konto schließen“.

## Text (Englisch, für Apple empfohlen)

> OWiA lets private persons in Germany report parking violations to the
> responsible municipal authority (Ordnungsamt). Normal sign-in uses a one-time
> code sent by e-mail. For review, please use the demo account with a fixed code:
>
> 1. Open the app → "Anmelden" → enter `<APP_REVIEW_EMAIL>`, accept the privacy
>    checkbox, wait for the automatic security check, tap "Code anfordern".
> 2. Enter the code `<APP_REVIEW_CODE>`.
> 3. Under "Einstellungen" (settings) fill in any test name and address once.
> 4. Camera mode: allow camera and location access, take a photo of any object,
>    tap "Fertig". The draft appears under "Meine Anzeigen".
>
> The demo account can use every feature but **cannot submit reports** – nothing
> is ever sent to an authority. Account deletion: Einstellungen → "Konto schließen".
>
> Native functionality: in-app camera capture with location tagging, scanning
> of the app's QR stickers, universal links for the e-mail sign-in link, photo
> import from the library, and downloads of generated PDFs.

## Absehbare Rückfragen

- **Apple 4.2 (Minimum Functionality):** Die App lädt die Website. Für die
  Prüfung zählen die Kamera mit Standort, Universal Links und die
  Store-Hinweise oben. Kommt trotzdem eine Ablehnung, siehe
  `docs/MOBILE-APPS.md` → „Wenn Apple ablehnt“.
- **Apple 5.1.1(v) Konto löschen:** vorhanden (Einstellungen → Konto schließen).
- **Apple 5.1.2 / Google „Personal and sensitive data“:** Fotos können
  Kennzeichen Dritter zeigen. Die App erkennt fremde Kennzeichen und Gesichter
  und verlangt vor dem Einreichen deren Schwärzung oder eine Bestätigung.
- **Rechtliches:** Anzeigen durch Privatpersonen sind in Deutschland zulässig
  (§ 46 OWiG i. V. m. § 158 StPO). OWiA ist keine Behörde.
