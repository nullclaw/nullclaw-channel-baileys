# nullclaw-channel-baileys

External WhatsApp channel plugin for `nullclaw` built on top of
[`@whiskeysockets/baileys`](https://www.npmjs.com/package/@whiskeysockets/baileys).

This repository intentionally lives outside `nullclaw` core. It speaks the
generic ExternalChannel JSON-RPC/stdio protocol and can be wired through
`channels.external` without adding Node code to the main runtime repository.

## What It Supports

- QR login
- pairing-code login
- inbound text messages
- outbound text messages
- typing indicators
- message edits
- message deletes
- reactions
- read receipts

Current limits:

- no rich attachments
- no streaming chunks
- no media upload pipeline yet

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Run the plugin directly for local testing:

```bash
node ./bin/nullclaw-channel-baileys.mjs
```

3. Or link it globally:

```bash
npm link
nullclaw-channel-baileys
```

4. Wire it into `nullclaw` via `channels.external`.

## Install

```bash
npm install
```

The executable entrypoint is:

```bash
./bin/nullclaw-channel-baileys.mjs
```

or after a global/link install:

```bash
nullclaw-channel-baileys
```

## nullclaw Config

Example:

```json
{
  "channels": {
    "external": {
      "accounts": {
        "wa-main": {
          "runtime_name": "whatsapp",
          "transport": {
            "command": "/opt/nullclaw/plugins/nullclaw-channel-baileys",
            "timeout_ms": 15000
          },
          "config": {
            "auth_mode": "qr",
            "display_name": "Chrome (Linux)"
          }
        }
      }
    }
  }
}
```

Supported plugin config keys:

- `auth_mode`
  `qr` or `pair_code`
- `pair_phone_number`
  Required when `auth_mode=pair_code`
- `display_name`
  Client display name shown during pairing

The host passes a persistent `state_dir` in `start.params.runtime.state_dir`.
This plugin stores Baileys auth files under `state_dir/auth`.

Complete pair-code example:

```json
{
  "channels": {
    "external": {
      "accounts": {
        "wa-main": {
          "runtime_name": "whatsapp",
          "transport": {
            "command": "/opt/nullclaw/plugins/nullclaw-channel-baileys",
            "timeout_ms": 15000
          },
          "config": {
            "auth_mode": "pair_code",
            "pair_phone_number": "551199999999",
            "display_name": "Chrome (Linux)"
          }
        }
      }
    }
  }
}
```

## Authorization Flows

### QR flow

1. Configure `auth_mode: "qr"`.
2. Start the channel with `nullclaw channel start whatsapp`.
3. The plugin prints a QR code to stderr.
4. Open WhatsApp on the phone and link a new device.
5. Once the websocket is open, `health` begins returning `logged_in=true`.

Practical operator flow:

```bash
nullclaw channel start whatsapp 2> /tmp/nullclaw-baileys.log
```

Then read the QR code from stderr output:

```bash
tail -f /tmp/nullclaw-baileys.log
```

### Pair-code flow

1. Configure:
   - `auth_mode: "pair_code"`
   - `pair_phone_number: "<international number>"`
2. Start the channel.
3. The plugin requests a pairing code from Baileys and prints it to stderr.
4. Enter the code in WhatsApp linked-device flow on the phone.
5. When linking succeeds, `health` reports `logged_in=true`.

## Full Operator CJM

### First login

1. Add the external account config to `nullclaw`.
2. Start the channel with `nullclaw channel start whatsapp`.
3. If `auth_mode=qr`, scan the QR printed to stderr.
4. If `auth_mode=pair_code`, copy the printed pairing code into WhatsApp.
5. Wait for the linked device to complete.
6. Send a test WhatsApp message to the linked account.
7. Verify inbound delivery inside `nullclaw`.
8. Trigger one outbound reply and verify it reaches WhatsApp.

### Restart

1. Stop `nullclaw`.
2. Start `nullclaw` again.
3. The plugin reloads auth files from `state_dir/auth`.
4. If the WhatsApp session is still valid, no QR or pair code is needed.

### Re-link after logout

If WhatsApp logs the device out:

1. Delete the stored auth directory under `state_dir/auth` if you want a clean relink.
2. Start the channel again.
3. Repeat the QR or pair-code flow.

## Troubleshooting

- No QR shown:
  make sure you started the channel and are looking at stderr, not stdout.
- Pair code never appears:
  verify `auth_mode=pair_code` and `pair_phone_number` uses international digits only.
- Repeated relogin requests:
  check that `state_dir` is persistent and writable by the `nullclaw` user.
- Channel looks started but nothing is received:
  send a direct text message first; media-only traffic is ignored by the current baseline.

## Protocol Notes

Manifest:

- `protocol_version: 2`
- `capabilities.health = true`
- `capabilities.typing = true`
- `capabilities.edit = true`
- `capabilities.delete = true`
- `capabilities.reactions = true`
- `capabilities.read_receipts = true`

Not supported:

- `send_rich`
- `streaming`

## Message ID Format

Inbound metadata contains `message_id`. This plugin encodes the full WhatsApp
message key as base64url JSON so later operations can target the same message.

That encoded key is what `edit_message`, `delete_message`, `set_reaction`, and
`mark_read` expect as `message.message_id`.

## Security Notes

- This plugin does not expose an HTTP API by itself.
- WhatsApp auth material is stored under host-provided `state_dir`.
- Anyone who can read `state_dir/auth` can reuse the linked device session.
- Do not put this plugin on a multi-user host without filesystem hygiene.

## Production

For deployment and hardening notes, see:

- [docs/production-hardening.md](./docs/production-hardening.md)

The short version:

- run `nullclaw` under a dedicated service user
- keep this plugin on the same host as `nullclaw`
- prefer `pair_code` on headless hosts
- persist and protect `state_dir/auth`

## Validation

```bash
npm test
```

## References

- [Baileys Connecting](https://baileys.wiki/docs/socket/connecting/)
- [Baileys Receiving Updates](https://baileys.wiki/docs/socket/receiving-updates/)
- [Baileys Sending Messages](https://baileys.wiki/docs/socket/sending-messages/)
- [Baileys Presence and Receipts](https://baileys.wiki/docs/socket/presence-receipts/)
