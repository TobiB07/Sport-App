# Freies Training – Sport-App

Trainings-App **ohne starren Trainingsplan**: Man trägt ein, was man trainiert hat, und bekommt eine
priorisierte Auswahl an Einheiten für die aktuelle Woche, ohne feste Tage und ohne „verpasst“.
Nur das **Tapering** vor einem Wettkampf ist ein fester Tagesplan.

## Starten

Reine Web-App (HTML/CSS/JavaScript, keine Build-Tools). Lokal:

```bash
python -m http.server 5173
```

Dann http://localhost:5173 öffnen. Daten liegen im `localStorage` des jeweiligen Geräts.
Jede Person nutzt ihr eigenes Handy. Sicherung per Export/Import im Profil.

## Aufs Handy (GitHub Pages)

Die App läuft als installierbare Web-App (PWA) über GitHub Pages. Nach einer Änderung in `sw.js` die
Cache-Version (`sportapp-vN`) hochzählen, committen und `git push`. Die Handys laden die neue Version beim
nächsten Öffnen mit Internet.

- **iPhone:** Seite in Safari öffnen → Teilen → „Zum Home-Bildschirm“
- **Android:** Seite in Chrome öffnen → Menü ⋮ → „App installieren“

Wichtig: Die Daten liegen im Speicher des Browsers auf dem Handy. Die App immer über das Homescreen-Icon
öffnen (Safari löscht Daten nicht installierter Seiten nach längerer Nichtnutzung) und ab und zu
unter Profil → „Sicherung herunterladen“ sichern.

## Aufbau

| Datei | Inhalt |
|---|---|
| `js/data.js` | Sportarten, Wettkampfdistanzen, Taper-/Regenerationslängen, Einheiten-Typen |
| `js/engine.js` | Regelwerk: Leistungsstand, Belastung, Prognose, Wochenempfehlungen, Tapering |
| `js/store.js` | Datenhaltung (localStorage) + Demo-Daten |
| `js/app.js` | Oberfläche: Einrichtung, Woche, Kalender, Ziele, Stand, Profil |

## Regelwerk (feste Regeln, keine KI)

- **Leistungsstand**: bestes Wettkampfergebnis → 10-km-Äquivalent (Riegel, Exponent 1,06),
  Rad → 40-km-Tempo (Exponent 1,05). Fallback: Wohlfühltempo aus dem Profil, sonst Schätzung nach Level.
- **Triathlon-Zeiten je Disziplin** (optional bei Ergebnissen und Zielen): Gesamtzeit ≠ Summe, die Differenz ist
  die Wechselzeit (T1 + T2). Splits aus Ergebnissen fließen in den Leistungsstand ein (Laufsplit ÷ Vorermüdungsfaktor,
  Radsplit ÷ 1,02, Schwimmsplit ÷ 1,08 für Freiwasser). Die eigene Wechselzeit (relativ zum Standard) wird für
  Prognosen übernommen. Zielzeiten je Disziplin bestimmen das Wettkampftempo in den Empfehlungen.
- **Alter der Ergebnisse**: ab 12 Monaten +0,4 % pro Monat langsamer gewertet (max. +8 %).
  Triathlon ohne Disziplin-Zeiten → Aufteilung nach typischen Anteilen (+2 % Sicherheitsabschlag).
- **Trainingstempo**: lockere/lange Einheiten (und Wettkämpfe) mit Distanz der letzten 6 Wochen. Aus Tempo und
  Anstrengung (Gefühl, Puls in % HFmax → Gefühl, beides gemittelt) wird die Leistung je Disziplin zurückgerechnet
  (Median, Ausreißer verworfen, letzte 3 Wochen stärker gewichtet). Ab 3 Einheiten wird es mit dem Wettkampfergebnis
  gemischt: max. ±6 % bei frischem, bis ±15 % bei altem Ergebnis. Ohne Ergebnis ersetzt es das Wohlfühltempo.
  Trend = letzte 3 Wochen vs. die 3 davor. Zone-2-Tempos kommen dann ebenfalls aus dem Training.
- **Belastung**: Dauer × Gefühl (1–10). Fitness = 42-Tage-Schnitt, Ermüdung = 7-Tage-Schnitt.
  Verhältnis > 1,5 → keine harten Einheiten.
- **Fitness je Disziplin**: eigene Disziplin 100 %, andere Ausdauersportarten 20 %, Kraft 10 %.
  Ergibt −4 % … +5 % auf die Prognose der Disziplin (halb gewichtet, wenn Trainingstempo schon einfließt).
- **Prognose**: aus Leistungsstand + Fitness je Disziplin. „Möglich bis zum Wettkampf“ = Prognose −
  Verbesserungsrate je Woche (Einsteiger 0,6 %, Fortgeschritten 0,4 %, Ambitioniert 0,25 %, max. 26 Wochen)
  × Beständigkeit.
- **Beständigkeit** (letzte 4 Wochen, Pausen ausgenommen, ab 2 Wochen Daten): ½ × Umfang im Verhältnis zum
  Richtwert (max. 120 %) + ½ × Anteil der Wochen mit mind. 2 Einheiten. Spanne 30–120 %.
- **Gewichtung der Disziplinen**: alle anstehenden Ziele, Gewicht = Priorität (A 1 / B 0,6 / C 0,3)
  ÷ (1 + Wochen bis Wettkampf ÷ 4). Ein naher Lauf verschiebt den Fokus also vorübergehend Richtung Laufen.
- **Phase je Disziplin** (nach dem nächsten Wettkampf mit dieser Disziplin): > 12 Wochen Grundlage,
  > 6 Wochen Aufbau, sonst Spezifisch (Wettkampftempo).
- **Wochenumfang**: Mitte der angegebenen Wochenstunden × Phasenfaktor, max. Obergrenze.
  Je Disziplin: langer Block, 1–2 Qualitätseinheiten, Rest locker. Max. 2 (unter 6 h) bzw. 3 harte Lauf-/Rad-Einheiten.
- **Schrittweise Steigerung**: Wochenumfang max. Ø der letzten 4 Wochen × 1,2 (mind. +1,5 h bzw. 40 % des Richtwerts).
  Pausentage der aktuellen Woche werden anteilig abgezogen.
- **Wettkampfergebnisse** zählen automatisch als Einheit „Wettkampf“ (Gefühl 9) in die Belastung,
  beim Triathlon je Disziplin. Für das Trainingstempo werden sie nicht verwendet (stecken schon in den Ergebnissen).
- **Zeiteingabe**: „1:45“ ist mehrdeutig. Es gilt die Deutung (h:mm oder m:ss), die näher an der Prognose liegt.
- **Ermüdung**: nach einer harten Einheit wird die nächste harte erst ab übermorgen bzw. morgen empfohlen.
- **Tapering** (Priorität A): 5/10 km, Sprint, Zeitfahren 7 Tage · Olympisch, Radmarathon 10 ·
  Halbmarathon, Mitteldistanz, 200 km 14 · Marathon, Langdistanz 21. B = halb (min. 4 Tage), C = 2 Tage.
- **Regeneration** nach Wettkämpfen (z. B. Halbmarathon 7, Marathon 14 Tage): halber Umfang, nur locker.
- **Pausen** (krank/verletzt/Urlaub): keine Empfehlungen, danach Wiedereinstieg mit 60 % → 100 % Umfang.
- **Lange Einheiten im Tapering** richten sich nach der Wettkampfdistanz: 3 Wochen vorher 80 %, 2 Wochen vorher 60 %,
  in der letzten Woche max. 50 % der längsten Einheit (Marathon z. B. 145 / 110 / 90 min).

## Offene Ideen

- Hosting (z. B. GitHub Pages), damit die App auf den Handys installiert werden kann
