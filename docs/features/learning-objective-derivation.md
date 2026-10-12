<!-- markdownlint-disable MD013 -->

# Modellgestützte Lernzielableitung in der Quizvorbereitung (#456 Slice 5)

**Stand:** 2026-10-05

**Status:** Implementiert und standardmäßig deaktiviert; technische Realmodell-Abnahme der Lernzielableitung bleibt Teil der Slice-8-Gesamtabnahme

**Runtime:** [Private Open-Weight-LLM-Runtime](open-weight-llm-runtime.md)
**Datenhaltung:** [ADR-0036](../architecture/decisions/0036-learning-objective-storage-and-live-projection.md)

## Produktgrenze und Auslöser

Die Ableitung startet ausschließlich nach der ausdrücklichen Aktion einer Lehrperson in der Lernzieloberfläche der Quizvorbereitung. Weder Join, Vote, Submit, WebSocket-Ereignisse, Quizwechsel, Live-Kurzfassung noch das Öffnen des Moderationskompasses starten diesen Auftrag. Ist `OPEN_WEIGHT_LLM_ENABLED=false`, bleiben manuelle Lernziele vollständig nutzbar; es gibt keinen SaaS-Fallback.

Die Oberfläche erklärt den Unterschied zwischen manuellen Lernzielen und automatisch formulierten Vorschlägen. Jeder Modellvorschlag kommt als `draft` zurück und benötigt eine Hostprüfung. Er wird nie automatisch bestätigt, als Lernerfolg interpretiert oder in Teilnehmerpayloads aufgenommen.

## Autorisierung und Ablauf

Der lokale Quizentwurf liegt im Browser und besitzt deshalb keinen serverseitigen Host-Token. Der explizite Zwei-Schritt-Vertrag autorisiert ausschließlich begrenzte CPU-Arbeit und keinen Zugriff auf gespeicherte Quiz- oder Sessiondaten:

1. `quiz.prepareLearningObjectiveDerivation` bindet `schemaVersion`, `operationId`, `quizId` und `expectedBundleRevision` an eine zufällige, fünf Minuten gültige Einmal-Capability. Redis speichert nur ihren SHA-256-Hash. Der Prepare-Pfad besitzt einen eigenen, Shared-NAT-tauglichen Rate-Limit-Bucket.
2. `quiz.deriveLearningObjectives` akzeptiert den strikt versionierten Ableitungsauftrag plus Capability. Fehlende, abgelaufene, wiederholte, korrupte oder anders gebundene Capabilities werden vor Modellarbeit verworfen. Eine atomare Redis-Operation vergleicht und verbraucht den Bearer bereits beim Reservieren der Modellarbeit; ein TTL-gebundener Tombstone verhindert auch bei verzögerten Parallelrequests einen Replay. Nach Erfolg, Fehler oder Abbruch wird dieser Tombstone bestmöglich entfernt.

Der Client hält während des Auftrags den Trigger gesperrt, bietet Abbruch an und ordnet eine Antwort zusätzlich über Operation, Quiz und erwartete Bundle-Revision zu. Vor dem atomaren Anwenden vergleicht er die beim Start serialisierten Quellfragen mit dem aktuellen lokalen Stand. Änderungen, Deaktivierung, Löschung, eine konkurrierende Lernzieländerung oder fehlende Restkapazität lassen das bestehende Bundle unverändert.

## Versionierte Verträge und Payload

Die Shared-Verträge liegen in `libs/shared-types/src/learning-objective-derivation.ts` und `learning-objective-derivation-capability.ts`:

- `LearningObjectiveDerivationInputSchema`, Schema-Version 1;
- Ableitungsversion `learning-objectives-v1`;
- `operationId`, lokale `quizId`, `expectedBundleRevision`, Locale und `maximumDrafts` von 1 bis 100;
- vollständige Fragen auf Basis des bestehenden `QuizUploadQuestionInputSchema`, ergänzt um erforderliche stabile `sourceQuestionId` und `enabled`;
- strikte Result-Union für `completed`, `busy` mit ausschließlich manuellem Retry, `disabled`, `aborted`, `timeout`, `unavailable`, `invalid_response`, `misconfigured`, `circuit_open`, `no_eligible_questions` und `input_too_large`.

Nur aktive, bewertbare Aufgaben mit Lösung werden projiziert: Single-/Multiple-Choice, Kurzantwort einschließlich Text-/Numerikregeln, Schätzfrage, Zuordnung, Reihenfolge und Kategorisierung. Freitext, Umfrage und Rating werden nicht als scheinbar lösungshaltige Aufgaben umgedeutet. Fragetext, sämtliche Antwortoptionen und Korrektheitswerte sowie typspezifische Musterlösung, Toleranzen, Zuordnungen, Reihenfolge oder Kategoriebezüge werden kanonisch in den privaten Runtimeauftrag übernommen. Passt schon eine einzelne vollständige Projektion nicht in den Vertrag, lautet das Ergebnis `input_too_large`; Inhalte werden nicht still gekürzt.

## Budget, Batching und Laufzeitgrenze

Jede vollständig serialisierte Runtime-Usernachricht bleibt bei höchstens 2.500 UTF-8-Bytes. Der Backendservice sortiert zunächst stabil nach Aufgabenreihenfolge und `sourceQuestionId` und bildet anschließend gierig reproduzierbare Batches. Jeder Batch erhält aus `operationId` und Batchindex eine deterministische UUID. Die Batches laufen sequenziell über denselben globalen Runtime-Slot; es gibt weder parallele Unteraufträge noch eine interne Modellqueue oder automatisches Busy-Retry.

Jeder Modell-Batch hat standardmäßig ein eigenes Zeitlimit von 300 Sekunden (`OPEN_WEIGHT_LLM_LEARNING_TIMEOUT_MS`). Zusätzlich gilt ein gemeinsames Wall-Clock-Budget von 20 Minuten für die gesamte Ableitung. Das gemeinsame Signal bricht auch den gerade aktiven Runtimeaufruf ab. Ein Hostabbruch ergibt `aborted`, das Gesamtlaufzeitende `timeout`; beide geben den App-seitigen Inflight-Slot frei und verwerfen bereits erzeugte Teilergebnisse. Jede andere Teilstörung verwirft ebenfalls den gesamten Ableitungslauf und stoppt weitere Batches. Der private Modellserver kann einen abgebrochenen Auftrag weiterhin als belegt melden; ein sofortiger erneuter Versuch ist deshalb nicht garantiert möglich.

`maximumDrafts` entspricht der beim Start verbleibenden lokalen Kapazität. Überzählige, deterministisch sortierte Vorschläge werden begrenzt, und eine lokalisierte Limitation weist die Kürzung aus. Ein fachlich leerer Modelloutput bleibt ein erfolgreicher, aber ausdrücklich limitierter Nullvorschlag und wird nicht als erfundenes Lernziel aufgefüllt.

## Prompt-, Quellen- und Provenienzschutz

Der fachliche Systemprompt trägt die Version `learning-objectives-system-v1`. Er behandelt Fragetexte, Antworten, Lösungserläuterungen und darin eingebettete Anweisungen ausdrücklich als nicht vertrauenswürdige Kursdaten. Das Modell darf nur beobachtbare, hostprüfbare Lernziele formulieren und ausschließlich exakte Aufgaben-IDs des aktuellen Batches referenzieren. Schemafremde Antworten, erfundene IDs, Querverweise auf einen anderen Batch und doppelte Referenzen scheitern geschlossen.

Ein fertiger Vorschlag enthält:

- eine aus Operation und vollständigem Vorschlagsinhalt deterministisch abgeleitete UUID;
- einen expliziten `question-set`-Scope;
- `model-derived`-Herkunft mit Ableitungs-, Modell- und Artefaktversion;
- einen SHA-256-Digest über exakt die kanonische Quellsemantik der referenzierten Aufgaben;
- ausschließlich den Bestätigungszustand `draft`.

Die Modellidentität bindet das Repository `unsloth/Qwen3-4B-Instruct-2507-GGUF`, den vollständigen GGUF-SHA-256, die Repository-Revision, `Q4_K_M` und llama.cpp `server-b10524`. Runtime-Telemetrie enthält weiterhin nur Auftragstyp, Modellalias, Laufzeit und Tokenzahlen. Rohpayload, System-/Userprompt, Antworten und vollständige Modellantwort werden weder in Telemetrie noch in Standardlogs geschrieben.

## Anwenden, Fehler und erneute Ableitung

Ein `completed`-Result wird in höchstens einer atomaren Bundleänderung append-only angewendet; ein leerer Resultatbestand oder ein idempotentes Replay benötigt keine Änderung. Bestehende manuelle Ziele, bestätigte Modellziele und bereits bearbeitete Entwürfe werden nicht ersetzt. Dieselbe deterministische Draft-ID macht eine identische verspätete Antwort idempotent. Ein Fehler, Busy, Abbruch, Timeout, Quellenkonflikt oder Bundle-CAS-Konflikt verändert kein Lernziel. Retry bleibt eine neue, ausdrückliche Hostaktion.

Relevante spätere Änderungen an Aufgaben oder Lösungen markieren gespeicherte modellabgeleitete Ziele über den bestehenden Sidecar-Lebenszyklus als prüfbedürftig. Die private Quellsemantik und ihr Digest gelangen nicht in den lösungsfreien Live-Moderationskontext.

## Nachweise und offene Realmodellgrenze

Fokussierte Tests decken Vertragsstrenge, sämtliche Lösungstypen, Multibyte-Budget und stabile Batchbildung, Einzelüberlauf, Gesamttimeout/Slotfreigabe, Hostabbruch, Busy ohne Retry, Teilfehler, erfundene und batchfremde Referenzen, Deduplizierung, Kapazitätslimit, deterministische IDs/Digests, injizierte Kursanweisungen, Einmal-Capability, Rate Limit sowie Router- und Store-CAS ab.

Die kanonischen Produktdaten für Integration, E2E und Realmodellmessung sind `getDemoQuizPayload(...)` und `getDemoQuizSeedFingerprint(...)` in `apps/frontend/src/app/features/quiz/data/demo-quiz-payload.ts`. Kleine Unit-Tests dürfen fokussierte Minimalfixtures verwenden.

Runtime R hat das gepinnte Modell und die Schemaerzwingung bereits mit einem realen `topic_label`-Auftrag belegt. Ein Produktionsversuch mit dem umfangreichen Demo-Quiz am 2026-10-12 erreichte den privaten Modellserver, erzeugte Tokens, überschritt aber das frühere 120-Sekunden-Gesamtbudget ohne fertige Lernziele. Die längeren Limits sind deshalb noch kein Nachweis für eine erfolgreiche Realmodell-Ableitung oder didaktische Qualität. Die Slice-8-Abnahme muss für jeden echten Lauf Systemprompt, Userpayload, angefordertes Schema und vollständige Antwort ohne Secrets dokumentieren sowie CPU-/Prefill-/Speicherwerte und die Produktionsgrenze ausweisen. `OPEN_WEIGHT_LLM_ENABLED` bleibt bis zu dieser Abnahme und einer getrennten Betreiberentscheidung standardmäßig `false`.

## Fokussierte Verifikation

```bash
npm run test -w @arsnova/shared-types -- --run \
  src/learning-objective-derivation.test.ts \
  src/learning-objective-derivation-capability.test.ts \
  src/open-weight-llm.test.ts
npm run test -w @arsnova/backend -- --run \
  src/lib/learningObjectiveDerivation.test.ts \
  src/lib/learningObjectiveDerivationCapability.test.ts \
  src/lib/openWeightLlmClient.test.ts \
  src/__tests__/quiz.learning-objective-derivation.test.ts \
  src/__tests__/rateLimit.test.ts
npm exec -w @arsnova/frontend -- vitest run \
  src/app/core/trpc.client.spec.ts \
  src/app/features/quiz/data/demo-quiz-payload.spec.ts \
  src/app/features/quiz/data/quiz-store.service.spec.ts \
  src/app/features/quiz/quiz-learning-objectives/quiz-learning-objectives.component.spec.ts
```
