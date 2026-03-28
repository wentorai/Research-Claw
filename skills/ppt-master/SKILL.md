---
name: ppt-master
description: Generate editable PPTX from documents using local ppt-master pipeline.
version: 0.1.0
---

# PPT Master Integration Skill

Use this skill when users ask to create or export slides with `ppt-master`.

## Preconditions

1. Local `ppt-master` repo exists at `integrations/ppt-master` (or plugin config `pptRoot`).
2. Python deps are installed in that repo (`pip install -r requirements.txt`).

## Available gateway methods

- `rc.ppt.status` — check if scripts are available.
- `rc.ppt.init` — initialize a project.
  - params: `{ "projectName": "my-deck", "format": "ppt169" }`
- `rc.ppt.export` — export project to pptx.
  - params: `{ "projectPath": "projects/my-deck", "stage": "final" }`

## Recommended flow

1. Call `rc.ppt.status`.
2. If unavailable, tell user to clone [ppt-master](https://github.com/hugohe3/ppt-master) into `integrations/ppt-master`.
3. Call `rc.ppt.init`.
4. Ask user/agent to generate slide SVG contents in project.
5. Call `rc.ppt.export`.

## Notes

- `projectPath` must be relative to `pptRoot`.
- Keep project names filesystem-safe (`[a-zA-Z0-9._-]`).
