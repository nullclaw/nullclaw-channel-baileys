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

## Authorization Flows

### QR flow

1. Configure `auth_mode: "qr"`.
2. Start the channel with `nullclaw channel start whatsapp`.
3. The plugin prints a QR code to stderr.
4. Open WhatsApp on the phone and link a new device.
5. Once the websocket is open, `health` begins returning `logged_in=true`.

### Pair-code flow

1. Configure:
   - `auth_mode: "pair_code"`
   - `pair_phone_number: "<international number>"`
2. Start the channel.
3. The plugin requests a pairing code from Baileys and prints it to stderr.
4. Enter the code in WhatsApp linked-device flow on the phone.
5. When linking succeeds, `health` reports `logged_in=true`.

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

## Validation

```bash
npm test
```

## References

- [Baileys Connecting](https://baileys.wiki/docs/socket/connecting/)
- [Baileys Receiving Updates](https://baileys.wiki/docs/socket/receiving-updates/)
- [Baileys Sending Messages](https://baileys.wiki/docs/socket/sending-messages/)
- [Baileys Presence and Receipts](https://baileys.wiki/docs/socket/presence-receipts/)
