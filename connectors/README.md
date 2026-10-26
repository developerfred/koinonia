# connectors

Unified chat connectors for Koinonia (Twitch and YouTube). TypeScript, no runtime dependencies
(dev: typescript, vitest). `npm install && npm run typecheck && npm test`.

## API

- `ChatMessage`: common model (platform, id, channel, ts, user, text, emotes, badges, kind, paid?).
  `text` is untrusted data: control and bidi characters are replaced (length preserving) and the
  text is capped; consumers must never treat it as instructions.
- `ChatConnector`: `connect`, `disconnect`, `onMessage`, `onEvent` (state, message-deleted,
  user-cleared, error), `send`, `deleteMessage`, `requestTimeout` / `requestBan` (return a
  `ModerationProposal`, nothing is executed), `executeProposal` (only after a human calls
  `proposalStore.approve`; single use; expires).
- `TwitchConnector`: IRC over WebSocket. Anonymous read-only (`justinfan` nick) when no `auth`;
  OAuth mode with `auth.getToken()` (called per connect, never stored or logged). Moderation
  execution is delegated to an injected `TwitchModerationApi` (Helix); none is bundled.
- `YouTubeConnector`: polling `liveChatMessages.list` through an injected `YouTubeApi`
  (`createFetchYouTubeApi` provided for REST), optional `streamList` async-iterable with polling
  fallback, `QuotaTracker` with pacing and pause/resume at quota reset.
- `UnifiedChat`: aggregates connectors into one feed ordered by timestamp within a small hold
  window (`holdMs`), cross-connector dedupe, `pipeTo(ring)` feeding anything shaped like
  `studio/src/chat/ring.ts` `ChatBuffer.push` (`{ts, platform, user, text}`), moderation
  proposal passthrough (`approve` / `reject` are for the human-facing UI only).
- Shared: jittered exponential backoff, token-bucket `RateLimiter`, `SeenSet` dedupe, `redact` /
  `safeLogger` (all connector logging goes through it; chat text is never logged).
- `MockSocket` (transport.ts) and a mock `YouTubeApi` are used in the tests.

## Verified from official docs (fetched during this work)

Twitch (dev.twitch.tv/docs/chat/irc):
- WebSocket endpoint `wss://irc-ws.chat.twitch.tv:443`.
- `CAP REQ :twitch.tv/membership twitch.tv/tags twitch.tv/commands`; tags require commands.
- `PASS oauth:<token>` before `NICK <lowercase login>`; scopes `chat:read`, `chat:edit`.
- Server `PING` must be answered with `PONG` or the connection is closed.
- `RECONNECT` means reconnect and rejoin. Failed auth yields NOTICE then close.
- `CLEARMSG` (target-msg-id), `CLEARCHAT` (target-user-id, ban-duration), tag escaping and
  `badges` / `emotes` tag formats. Over-sending can silently drop messages or close the connection.

YouTube (developers.google.com/youtube/v3/live/docs):
- `liveChatMessages.list`: 5 quota units; params liveChatId, part, pageToken, maxResults
  (200-2000, default 500); returns nextPageToken, pollingIntervalMillis, offlineAt; errors
  liveChatEnded, liveChatNotFound, liveChatDisabled, rateLimitExceeded. The first request
  without a token returns only recent messages. Docs recommend `streamList` over polling.
- `liveChatMessages.insert`: 20 units; scope `youtube` or `youtube.force-ssl`.
- `liveChatBans.insert`: body fields `type` (temporary/permanent), `banDurationSeconds`,
  `bannedUserDetails.channelId`; same scopes. Its quota cost was not on the page.

## Assumed (not verified from docs; treat as gaps)

- Anonymous login (`justinfan<digits>` with any password). Widely used, but absent from the IRC page I fetched.
- Twitch send limit (20 per 30 s) and Twitch emote offsets being code points rather than UTF-16 units.
- Emote image URL pattern `static-cdn.jtvnw.net/emoticons/v2/<id>/default/dark/1.0`.
- Twitch IRC moderation commands being retired in favour of Helix (the connector therefore has no IRC fallback).
- YouTube default daily quota 10,000 and reset at midnight Pacific; costs of delete (20) and ban (50) are guesses; opening a stream is counted as one list unit.
- Error `reason` strings other than those on the list page (`quotaExceeded`, `dailyLimitExceeded`, `forbidden`, 401 for auth).
- Message type shapes beyond text and super chat (`messageDeletedEvent`, `userBannedEvent` field names); `:shortcode:` emoji rendering in `displayMessage`.
- `streamList` wire protocol: only the abstraction exists; no real HTTP/gRPC streaming client is implemented.
- The YouTube send limit (10 per 30 s) is a conservative local default.

## Other gaps

- No Twitch EventSub chat transport (IRC only); no Helix client; no OAuth refresh handling (supply `getToken`).
- No application-level IRC silence watchdog (relies on socket close).
- Quota is tracked locally per process; other consumers of the same project quota are invisible except via `quotaExceeded`.
- Reset time math can be an hour off on DST transition days.
