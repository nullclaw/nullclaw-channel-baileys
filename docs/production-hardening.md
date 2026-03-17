# Production Hardening

This plugin is not meant to run as a standalone service. `nullclaw` starts it
as a child process through `channels.external`.

That changes the deployment model:

- the plugin binary must be installed on the same host as `nullclaw`
- logs go through the parent `nullclaw` service
- persistent auth state is owned by the host-provided `state_dir`

## Recommended Deployment Shape

1. Run `nullclaw` itself under a dedicated service account.
2. Install this plugin in a root-owned directory such as:

```text
/opt/nullclaw/plugins/nullclaw-channel-baileys
```

3. Reference that absolute path from `channels.external.accounts.<id>.transport.command`.
4. Keep the `nullclaw` workspace and state directories on persistent storage.

## Filesystem

The important directory is:

```text
<nullclaw state dir>/channels/external/<runtime_name>/<account_id>/auth
```

Recommendations:

- make it writable only by the `nullclaw` service user
- back it up only if you are comfortable backing up live WhatsApp linked-device credentials
- delete it when you intentionally want to force a relink

Suggested permissions:

```bash
chmod 700 /var/lib/nullclaw
chmod 700 /var/lib/nullclaw/channels/external
```

## Authentication Mode Choice

### `qr`

Use this when:

- an operator can watch stderr or service logs during first login
- you are okay with scanning a QR manually

Avoid it when:

- the host is fully headless and nobody can easily view the QR output

### `pair_code`

Use this when:

- the host is headless
- you want a copyable code instead of a QR render

Requirements:

- set `config.auth_mode = "pair_code"`
- set `config.pair_phone_number` to digits only in international format

For unattended environments this is usually the better default.

## Logging

This plugin writes:

- JSON-RPC protocol frames to stdout only
- diagnostics to stderr only

In production, read stderr through the parent `nullclaw` service logs. Do not
pipe plugin stdout into log aggregators directly.

## Node Runtime

Recommendations:

- pin Node to a known major version, currently `>=20`
- deploy from `package-lock.json`
- do not auto-upgrade Baileys blindly without re-testing login and reconnect behavior

Typical install:

```bash
npm ci --omit=dev
```

## Operational Notes

- first login requires operator interaction
- restart should not require re-login if `state_dir/auth` is preserved
- if WhatsApp logs the device out, you must relink
- media-only inbound messages are ignored by the current baseline

## Monitoring

Look for:

- repeated QR or pair-code prompts after restart
- `logged_in=false` after the account was previously linked
- repeated reconnect loops
- missing writes to the auth directory

## Upgrade Advice

Before upgrading:

1. stop `nullclaw`
2. keep a backup of the plugin directory and auth state
3. upgrade in a staging environment first
4. restart and verify `logged_in=true`

## When Not To Use This Plugin

If you want the WhatsApp session to live in its own separately supervised
service boundary, use the bridge approach instead:

- [nullclaw-channel-whatsmeow-bridge](https://github.com/nullclaw/nullclaw-channel-whatsmeow-bridge)

