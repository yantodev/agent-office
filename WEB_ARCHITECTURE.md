# Agent Office Web Architecture

This document defines the production direction for a web deployment. The Electron application remains the local-first reference implementation; the browser must never receive direct filesystem, Git, secret, or process access.

## Runtime layers

```text
React web client
        │ HTTPS + authenticated WebSocket
Web gateway / API
        │ application interfaces
Application services
   ┌────┼─────┬────────┐
Tasks  Mailbox  Memory  Approvals
        │
Project worker runtime (sandboxed CLI sessions)
        │
Storage adapter (SQLite for single node, PostgreSQL for multi-user)
```

The React client owns navigation, forms, Pixi.js visualization, terminal rendering, and optimistic UI state. It calls resource-oriented HTTP endpoints and subscribes to a project-scoped WebSocket stream. It does not import Electron, `node-pty`, `better-sqlite3`, or Node filesystem APIs.

The web gateway owns authentication, authorization, request validation, rate limiting, WebSocket session binding, and response redaction. Application services own task lifecycle, approvals, mailbox routing, memory retention, GitHub integration, and audit events. Workers are the only processes allowed to access a project workspace or execute a provider CLI.

## Resource interfaces

| Resource | HTTP surface | Realtime events |
| --- | --- | --- |
| Projects | `GET/POST /v1/projects`, `PUT /v1/projects/:id/active` | `project.updated` |
| Agents | `GET/POST /v1/projects/:id/agents`, `POST /.../control` | `agent.state`, `agent.exit`, `terminal.data` |
| Tasks | `GET/POST /v1/projects/:id/tasks`, `PATCH /v1/tasks/:id` | `task.created`, `task.updated` |
| Events | `GET /v1/projects/:id/events` | all project-scoped audit events |
| Mailbox | `GET/POST /v1/projects/:id/messages` | `message.created`, `message.delivered` |
| Approvals | `GET /v1/projects/:id/approvals`, `POST /v1/approvals/:id/resolve` | `approval.updated` |
| Memory | `GET/POST /v1/projects/:id/memories`, `PATCH/DELETE /v1/memories/:id` | `memory.updated` |
| Terminal | WebSocket stream bound to an agent session | binary/text terminal frames |

Every request carries an authenticated user identity. The server checks project membership and capability policy before dispatching the operation. State-changing requests include an idempotency key; approval and GitHub operations also record an audit event.

## Security and isolation

- Use OIDC/session authentication, short-lived access tokens, secure cookies, CSRF protection for browser mutations, and strict WebSocket origin checks.
- Authorize every project resource server-side; never trust a project ID or agent ID sent by the browser.
- Store secrets in a server secret manager and inject only into a worker sandbox with an explicit provider policy. Never send secrets to React or WebSocket logs.
- Run each worker with a per-project filesystem mount, network policy, CPU/memory/time budget, and a non-root identity. A missing sandbox is a hard error for restricted profiles.
- Keep audit events append-only and redact task prompts, terminal output, memory, and error payloads before storage or broadcast.

## Migration path from Electron

1. Extract current main-process interfaces into application services and adapters; keep the current Electron IPC adapter as one transport.
2. Add an HTTP adapter and an authenticated WebSocket adapter over the same services.
3. Move React data access behind a transport-neutral client module. Electron can use a local adapter while web uses HTTP/WebSocket.
4. Replace local `node-pty` sessions with a worker adapter. The worker reports structured events and terminal frames to the application service.
5. Add PostgreSQL and object/blob storage adapters only after the SQLite contract and migrations are covered by integration tests.

## Deployment baseline

Terminate TLS at a reverse proxy, forward only HTTPS/WSS to the gateway, run workers in isolated containers or an equivalent sandbox, and keep storage on private network segments. Health checks must cover gateway, database, queue/event transport, and worker capacity. Backups must encrypt database and project artifacts, test restore regularly, and retain audit data according to the organization's policy.
