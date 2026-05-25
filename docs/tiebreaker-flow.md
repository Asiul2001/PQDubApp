# Schätzfrage Flow

```mermaid
flowchart TD
  A[Podium nach Punkten berechnen] --> B{Gleichstand um Platz 1-3?}
  B -- Nein --> C[Normales Tagesranking speichern]
  B -- Ja --> D{Sind alle podiumsrelevanten Teams entschieden?}
  D -- Nein --> E[Warten nur auf Teams, die das Podium noch erreichen koennen]
  D -- Ja --> F{Sind alle betroffenen Tie-Teams bereit?}
  F -- Nein --> G[Warten auf Bereitschaft der Tie-Teams]
  F -- Ja --> H[Schätzfrage aktivieren]
  H --> I{Haben alle Tie-Teams genau eine Schätzung abgegeben?}
  I -- Nein --> J[Schätzungen weiter sammeln]
  I -- Ja --> K[Podium per Distanz zur richtigen Antwort sortieren]
  K --> L[Gutscheine für Platz 1-3 ableiten]
```

## Zusätzliche Regeln

- Zusatzzeit verlängert nur das Ende der Runde. Sie ändert keine Punkte und startet keine Schätzfrage von selbst.
- Teams, die selbst mit allen Restpunkten das Podium nicht mehr erreichen können, blockieren die Schätzfrage nicht.
- Die Schätzfrage ist nur für Teams relevant, die wirklich in einem Podiums-Gleichstand liegen.
- Für die Schätzfrage zählt pro Team genau die erste Abgabe.
- Ohne Podiums-Gleichstand wird direkt das normale Tagesranking verwendet.
