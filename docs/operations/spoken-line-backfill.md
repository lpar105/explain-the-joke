# Backfill spoken Lines in existing Breakdowns

New laugh analysis saves the spoken Lines and their Laugh Regions together. For existing Breakdowns, run the internal action in the intended Convex deployment after deploying the updated backend.

```sh
npx convex run setIngest:backfillSpokenLines '{}'
```

The action processes up to ten Breakdowns per call. Until the result reports `done: true`, pass its `cursor` to the next call as `{"cursor":"..."}`. Each successfully migrated Breakdown is marked in its write transaction, so a rerun from any earlier cursor skips completed work. A transient archive fetch failure stops the batch. Retry with the same cursor.

Backfill uses archived word timings when their words and order match the saved transcript and the timings fit its Lines. When archival timings are missing or unreliable, keep the saved text and existing spoken Line boundaries. Merge multiple Laugh Regions starting on the same Line into one using the earliest start, latest end, and highest intensity. This can combine distinct laughs on older Sets. It avoids guessing where the comic spoke. Wordless Breakdowns retain no Laugh Regions. For timed speech that falls between overlapping laugh starts, the boundary can move back to the last intervening word if starting at the next laugh would create an empty Line.
