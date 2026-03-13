# Plan Persistence

When the lead session produces a plan in plan mode (not delegated to the Queen via `/assemble`), the plan must be persisted to the brain before exiting plan mode. Plans that exist only in conversation context are lost on compaction.

## After materializing brain tasks

Save the plan as an artifact — identical to the Queen's Phase 2, step 6:

```
records_create_artifact:
  title: "Plan: <epic title>"
  kind: "plan"
  data: <full plan markdown, base64-encoded>
  task_id: <epic's task ID>
  media_type: "text/markdown"
  tags: ["queen-plan"]
```

Use the `queen-plan` tag for consistency — `/reengage` queries this tag to find plans regardless of who created them.

## Before materializing (lightweight plans)

If the plan does not warrant brain tasks (e.g., a short implementation plan with 1-2 steps), save it as a snapshot instead:

```
records_save_snapshot:
  title: "Plan: <brief description>"
  data: <plan markdown, base64-encoded>
  media_type: "text/markdown"
  tags: ["lead-plan"]
```

This ensures the plan survives compaction and can be referenced in subsequent turns.
