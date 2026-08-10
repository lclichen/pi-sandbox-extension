# pi-sandbox-extension

A [pi](https://github.com/earendil-works/pi-mono) CLI extension that connects
the coding agent to a centralized Apptainer sandbox management platform and
routes its built-in tools (`read`, `write`, `edit`, `bash`, `grep`, `find`,
`ls`) into a managed container over the platform's REST API.

The platform acts as the **middleman**: the agent runs on your laptop, but
every file read, write, and shell command is forwarded to the platform, which
executes it inside your Apptainer sandbox (via SSH or the `apptainer` CLI on the
server) and returns the result. This lets you develop inside an isolated,
persistent container without running the agent itself inside it.

## Architecture

```
pi (your machine)          platform (Node.js server)        Apptainer container
  read/write/bash  ──HTTPS──►  /api/v1/containers/:id/tools/*  ──►  executor
  (this extension)            (sandbox-platform)                 (SSH or apptainer CLI)
```

This mirrors pi's own `gondolin` (micro-VM) and `ssh` (remote shell) extension
patterns, but targets a centralized multi-user platform instead of a single
local VM.

## Prerequisites

- A running `sandbox-platform` server (see `../sandbox-platform`).
- pi installed and on your PATH.
- An account on the platform (an `admin` is seeded by default; ask your admin
  for a regular account).

## Install

Copy the extension into pi's auto-discovery directory so it loads in every
project:

```bash
cp -R pi-sandbox-extension ~/.pi/agent/extensions/pi-sandbox-extension
```

Or load it ad-hoc for a single project:

```bash
cd /path/to/project
pi -e /path/to/pi-sandbox-extension
```

No `npm install` is needed — the extension only imports types from
`@earendil-works/pi-coding-agent` (resolved by pi at runtime) and uses Node's
built-in `fetch`.

## Configure

Create `~/.pi/agent/extensions/sandbox-platform.json`:

```json
{
  "url": "https://sandbox.corp.com",
  "username": "your-username"
}
```

Environment variable overrides (highest precedence):

| Variable                      | Purpose                                   |
|-------------------------------|-------------------------------------------|
| `SANDBOX_PLATFORM_URL`        | Platform base URL                         |
| `SANDBOX_PLATFORM_TOKEN`      | Pre-obtained JWT access token (skip login)|
| `SANDBOX_API_KEY`             | Long-lived API key (`sk_...`); preferred over the JWT for automation |
| `SANDBOX_PLATFORM_USERNAME`   | Default username for the login prompt     |
| `SANDBOX_CONTAINER`           | Container id to auto-connect on startup   |

### Long-lived API keys

For automation or to avoid re-login, create an API key once via `/sandbox-apikey`
(or get one from the admin console) and add it to the config file:

```json
{ "url": "https://sandbox.corp.com", "apiKey": "sk_abcdef1234567890..." }
```

When `apiKey` is set, the extension uses it for all platform calls (via the
`X-API-Key` header) and skips the JWT refresh flow — keys do not expire until
revoked. Revoke keys with `/sandbox-apikey` → "Revoke a key", or from the
admin console.

Project-local override: `<cwd>/.pi/sandbox-platform.json`.

## Usage

1. Start pi in a project:

   ```bash
   pi -e /path/to/pi-sandbox-extension --sandbox-container 12
   ```

2. If not already authenticated, run `/sandbox-login` inside pi and enter your
   credentials. The token is cached in the global config file.

3. If you did not pass `--sandbox-container`, run `/sandbox-list` to pick a
   running container, or the extension will prompt you on the first tool call.

4. Use pi normally. `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`
   now execute inside the connected container. User `!`/`!!` shell commands are
   routed there too.

## Commands

| Command           | Description                                              |
|-------------------|----------------------------------------------------------|
| `/sandbox-login`  | Authenticate against the platform (username/password)    |
| `/sandbox-status` | Show the connected user, container, and instance         |
| `/sandbox-list`   | List running containers and connect to one               |
| `/sandbox-new`    | Create a new container and connect to it                 |
| `/sandbox-url`    | Print the configured platform URL                        |
| `/sandbox-apikey` | Manage long-lived API keys (create / list / revoke / use)|

## Auto-provisioning

If you start pi with no running container, the extension automatically
creates one from the first public image (using that image's default resources)
and connects to it — so after `/sandbox-login` you can start coding
immediately. Use `/sandbox-new` to create a container with a specific image or
name.

## Notes

- The extension falls back to **local host execution** when no container is
  connected or the platform is unreachable, so loading it is never fatal. You
  will see a status-bar indicator when a container is active.
- Token refresh is automatic: on a 401 the extension silently refreshes once
  using the cached refresh token before retrying.
- **Live bash output**: `bash` commands stream their stdout/stderr in real
  time over the platform's SSE endpoint (`POST /tools/bash/stream`) — progress
  bars, logs, and long-running output appear as they are produced instead of
  after completion. If the platform predates the stream endpoint (404/405),
  the extension transparently falls back to request/response `bash`.
- The platform relays tool operations; see `../sandbox-platform` for the
  container lifecycle (create/start/stop/snapshot/restore) and admin APIs.
