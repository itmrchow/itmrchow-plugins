# Discord — Access & Delivery

Discord only allows DMs between accounts that share a server. Who can DM your bot depends on where it's installed: one private server means only that server's members can reach it; a public community means every member there can open a DM.

The **Public Bot** toggle in the Developer Portal (Bot tab, on by default) controls who can add the bot to new servers. Turn it off and only your own account can install it. This is your first gate, and it's enforced by Discord rather than by this process.

For DMs that do get through, the default policy is **pairing**. An unknown sender gets a 6-character code in reply and their message is dropped. You run `/discord:access pair <code>` from your assistant session to approve them. Once approved, their messages pass through.

All state lives in `~/.claude/channels/discord/access.json`. The `/discord:access` skill commands edit this file; the server re-reads it on every inbound message, so changes take effect without a restart. Set `DISCORD_ACCESS_MODE=static` to pin config to what was on disk at boot (pairing is unavailable in static mode since it requires runtime writes).

## At a glance

| | |
| --- | --- |
| Default policy | `pairing` |
| Sender ID | User snowflake (numeric, e.g. `184695080709324800`) |
| Group key | Channel snowflake — not guild ID |
| Config file | `~/.claude/channels/discord/access.json` |

## DM policies

`dmPolicy` controls how DMs from senders not on the allowlist are handled.

| Policy | Behavior |
| --- | --- |
| `pairing` (default) | Reply with a pairing code, drop the message. Approve with `/discord:access pair <code>`. |
| `allowlist` | Drop silently. No reply. Use this once everyone who needs access is already on the list, or if pairing replies would attract spam. |
| `disabled` | Drop everything, including allowlisted users and guild channels. |

```
/discord:access policy allowlist
```

## User IDs

Discord identifies users by **snowflakes**: permanent numeric IDs like `184695080709324800`. Usernames are mutable; snowflakes aren't. The allowlist stores snowflakes.

Pairing captures the ID automatically. To add someone manually, enable **User Settings → Advanced → Developer Mode** in Discord, then right-click any user and choose **Copy User ID**. Your own ID is available by right-clicking your avatar in the lower-left.

```
/discord:access allow 184695080709324800
/discord:access remove 184695080709324800
```

## Guild channels

Guild channels are off by default. Opt each one in individually, keyed on the **channel** snowflake (not the guild). Threads inherit their parent channel's opt-in; no separate entry needed. Find channel IDs the same way as user IDs: Developer Mode, right-click the channel, Copy Channel ID.

```
/discord:access group add 846209781206941736
```

With the default `requireMention: true`, the bot responds only when @mentioned or replied to. Pass `--no-mention` to process every message in the channel, or `--allow id1,id2` to restrict which members can trigger it.

```
/discord:access group add 846209781206941736 --no-mention
/discord:access group add 846209781206941736 --allow 184695080709324800,221773638772129792
/discord:access group rm 846209781206941736
```

## Mention detection

In channels with `requireMention: true`, any of the following triggers the bot:

- A structured `@botname` mention (typed via Discord's autocomplete)
- An `@everyone` / `@here` mention
- A reply to one of the bot's recent messages
- A match against any regex in `mentionPatterns`

Role mentions do **not** trigger the bot — mentioning a role the bot belongs to is ignored. Mention the bot directly, or add a `mentionPatterns` regex.

Example regex setup for a nickname trigger:

```
/discord:access set mentionPatterns '["^hey claude\\b", "\\bassistant\\b"]'
```

## Delivery

Configure outbound behavior with `/discord:access set <key> <value>`.

**`ackReaction`** reacts to inbound messages on receipt as a "seen" acknowledgment. Unicode emoji work directly; custom server emoji require the full `<:name:id>` form. The emoji ID is at the end of the URL when you right-click the emoji and copy its link. Empty string disables.

```
/discord:access set ackReaction 🔨
/discord:access set ackReaction ""
```

**`replyToMode`** controls threading on chunked replies. When a long response is split, `first` (default) threads only the first chunk under the inbound message; `all` threads every chunk; `off` sends all chunks standalone.

**`textChunkLimit`** sets the split threshold. Discord rejects messages over 2000 characters, which is the hard ceiling.

**`chunkMode`** chooses the split strategy: `length` cuts exactly at the limit; `newline` prefers paragraph boundaries.

## Invite tokens

Pairing is pull-shaped: a stranger arrives, the bot mints a code, a human approves after the fact. Invites are the opposite — an **admin** mints a token up front, hands it out, and whoever redeems it is admitted with no further approval step.

Redemption is `/start <token>` sent as a DM to the bot. Discord has no deep-link mechanism and no command router, so the holder types the token by hand and the server prefix-matches the plain text. The match is strict — exactly 32 lowercase hex characters, nothing before or after — so an ordinary message that happens to begin with `/start ` is still handled normally. A valid token puts the sender's **user snowflake** into `allowFrom` and clears any pairing code they were waiting on.

Every failure is a **silent drop** — unknown, expired, and revoked tokens all get no reply, so this cannot be used to probe which tokens exist. Redemption in a guild channel is refused outright; only DMs count. It is also disabled entirely under `DISCORD_ACCESS_MODE=static`, since static mode never writes `access.json` and an admitted sender would be blocked on their next message; the server logs a warning when invites are configured.

Tokens are stored in a file shared by every channel, not in `access.json` — see [Invite file](#invite-file-shared-across-channels) below.

Tokens are minted from an admin's DM with `/create-token`, handled by the `im-create-token` skill (`im-core` plugin). Minting is the only operation the skill offers — there is no `revoke` and no `list`; anything else means editing the invite file by hand. Three properties are deliberate and permanent:

- **`admins` is read-only to every program.** The first admin is set by editing `access.json` by hand. No code path and no skill adds one, so a redeemed invite can never be escalated into admin rights through conversation.
- **Revoking a token is not the same as removing the people who used it.** Setting `revokedAt` in the invite file stops future redemptions and leaves a tombstone (pruned after 30 days); existing members stay in `allowFrom` until removed with `/discord:access remove <id>`. `usedBy` records who came in on which token.
- **`usedBy` is bucketed per platform.** The same token carried across to a Telegram deployment redeems independently there; one side's redemption never overwrites the other's record.

## Skill reference

| Command | Effect |
| --- | --- |
| `/discord:access` | Print current state: policy, allowlist, pending pairings, enabled channels. |
| `/discord:access pair a4f91c` | Approve pairing code `a4f91c`. Adds the sender to `allowFrom` and sends a confirmation on Discord. |
| `/discord:access deny a4f91c` | Discard a pending code. The sender is not notified. |
| `/discord:access allow 184695080709324800` | Add a user snowflake directly. |
| `/discord:access remove 184695080709324800` | Remove from the allowlist. |
| `/discord:access policy allowlist` | Set `dmPolicy`. Values: `pairing`, `allowlist`, `disabled`. |
| `/discord:access group add 846209781206941736` | Enable a guild channel. Flags: `--no-mention`, `--allow id1,id2`. |
| `/discord:access group rm 846209781206941736` | Disable a guild channel. |
| `/discord:access set ackReaction 🔨` | Set a config key: `ackReaction`, `replyToMode`, `textChunkLimit`, `chunkMode`, `mentionPatterns`. |

## Config file

`~/.claude/channels/discord/access.json`. Absent file is equivalent to `pairing` policy with empty lists, so the first DM triggers pairing.

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // User snowflakes allowed to DM.
  "allowFrom": ["184695080709324800"],

  // Guild channels the bot is active in. Empty object = DM-only.
  "groups": {
    "846209781206941736": {
      // true: respond only to @mentions and replies.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = any member (subject to requireMention).
      "allowFrom": []
    }
  },

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": ["^hey claude\\b"],

  // Reaction on receipt. Empty string disables.
  "ackReaction": "👀",

  // Threading on chunked replies: first | all | off
  "replyToMode": "first",

  // Split threshold. Discord rejects > 2000.
  "textChunkLimit": 2000,

  // length = cut at limit. newline = prefer paragraph boundaries.
  "chunkMode": "newline",

  // Admin user snowflakes, per platform. Hand-edited only — no code path
  // and no skill ever adds an entry here.
  "admins": { "discord": ["184695080709324800"] }
}
```

## Invite file (shared across channels)

Invite tokens do **not** live in `access.json`. They live in one file shared by every IM channel:

`~/.claude/channels/invites.json` (override with the `INVITES_FILE` env var).

That is deliberate. A token is platform-agnostic by design — `usedBy` buckets redemptions per platform precisely so the same ticket works everywhere — so a token minted on Telegram must be redeemable on Discord. While each channel kept its own copy inside its own state directory, the other channel simply could not see it and the redemption was dropped as an unknown token.

The file is not under any platform subdirectory, because it belongs to none of them:

```jsonc
{
  // Bumped only if the on-disk shape ever changes incompatibly.
  "version": 1,
  // Invite tickets, keyed by token. Written by the im-create-token skill and by each
  // channel server when a token is redeemed.
  "invites": {
    "a1b2c3d4e5f60718293a4b5c6d7e8f90": {
      "note": "for Bob",
      "createdAt": 1700000000000,
      "createdBy": "telegram:412587349",
      // Required, epoch ms. There is no never-expiring invite.
      "expiresAt": 1700604800000,
      // Who redeemed it, bucketed by platform. One ticket, every channel.
      "usedBy": { "telegram": ["987654321"], "discord": ["246813579"] },
      // Tombstone. Non-null blocks redemption; the key is kept for 30 days.
      "revokedAt": null
    }
  }
}
```

Deployments that predate this move keep their tokens: on boot each channel server lifts any `invites` still in its own `access.json` into the shared file (merging, never overwriting an existing token) and rewrites `access.json` without the field. Running it twice, or on both channels, changes nothing further.

Two consequences worth knowing:

- The file holds bearer tokens. It is written `0600` and, like the contents of the state directory, the server refuses to send it as a reply attachment.
- There is no lock. Three processes (both channel servers and the `im-create-token` skill) read-modify-write it. Minting and redeeming are human-paced and writes are atomic, so this is an accepted trade-off rather than an oversight.
