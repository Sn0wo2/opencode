# session/generate

## POST /api/session/{sessionID}/generate

Generate transient text from the current session context without mutating session history. Its tokens and cost count toward the session's totals.

Body:
- `prompt: string`
- `experimental?: { model?: Model.Ref; variant?: string; btw?: string }`

Returns: `SessionGenerateResponse`

## Types

- `Model.Ref`: `{ id: string; providerID: string; variant?: string }`
- `SessionGenerateResponse`: `{ data: { text, tokens, cost, experimental } }`
