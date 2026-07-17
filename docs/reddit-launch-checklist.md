# Reddit Launch Checklist

This checklist maps Mini Racer to Reddit’s current Devvit launch guidance:
[Launch your app](https://developers.reddit.com/docs/guides/launch/launch-guide)

## Purpose

Use this as the final go/no-go list before running `devvit publish`.

Mini Racer is a **game**, so the most important launch requirements are:

- Stable on both **mobile and web**
- Tested with **developer, moderator, and regular user** accounts
- Uses a **custom first screen**
- Avoids **inline scrolling** inside the in-feed launch experience
- Has a **dedicated non-test subreddit** for the live launch

## Launch checklist

### Product and UX

- [ ] The in-feed launch card is clear at first glance and explains the action: race today’s challenge.
- [ ] The full game is understandable for a first-time player without extra instructions.
- [ ] The launch card works without inline scroll traps.
- [ ] The expanded game works across phone and desktop layouts.
- [ ] The retry flow is fast and predictable after a finish or an enabled collision auto-restart.
- [ ] A verified lifetime PB ghost appears on the next attempt for that track, including when the track returns on a later date.
- [ ] The PB ghost uses the player's currently selected car and is visibly more transparent than the live player car.
- [ ] `Race Now` keeps the custom-post loading screen visible until the resolved track ghost is prepared: valid historical posts load their own ghost, while expired posts load today's featured-track ghost.
- [ ] `Personal Best Ghost` defaults on, disables immediately in Settings, and stays disabled after reopening the app.
- [ ] The finish screen shows `Improve`, `Share Time`, and `Home`, and sharing displays the exact comment plus Reddit username before posting.
- [ ] `Share Best` appears only for a verified time in the selected standings day and keeps the selected day and scroll position after canceling.

### Reddit-specific setup

- [ ] A dedicated production subreddit exists for Mini Racer: `MiniRacerGame`. Do not launch from `mini_racer_dev`.
- [ ] The moderator install flow is confirmed in the target subreddit.
- [ ] The **Create Mini Racer post** menu item successfully creates a playable post.
- [ ] At least one example post has been created and reviewed end to end.
- [ ] Moderator, scheduler, and repeated create actions reuse the same canonical post for the subreddit and UTC day.
- [ ] The pinned `🏁 Mini Racer score thread` comment exists before a newly triggered post action reports success, and an older recoverable post is repaired before sharing.
- [ ] Podium automation can be enabled and disabled independently from race posts, publishes the just-expired track at 00:01 UTC, and repeated scheduler/menu actions reuse one canonical podium post.
- [ ] Podium posts show exactly three positions, preserve publication-time username/private-name choices, expose no player IDs, and use explicit placeholders when fewer than three verified racers finished.

### Quality and trust

- [ ] Daily challenge loading works for a signed-in Reddit user.
- [ ] Leaderboard reads and submissions work for real users in Reddit context.
- [ ] Reddit username display behaves correctly when identity is enabled.
- [ ] Guest fallback identity behaves correctly when Reddit username display is unavailable or off.
- [ ] Invalid or suspicious replay submissions are rejected cleanly.
- [ ] A daily leaderboard improvement and a lifetime track PB improvement are displayed and stored independently.
- [ ] Existing retained verified results seed a time-only track PB without showing a fabricated ghost.
- [ ] A geometry or simulation revision rejects an incompatible stored ghost instead of rendering it on the changed track.
- [ ] Error states are understandable and do not leave the player stuck.
- [ ] `SUBMIT_COMMENT` user-action permission is present in `devvit.json`, and the reviewed app version is approved for regular-user attribution.
- [ ] A regular user can preview, confirm, and view a score-thread reply authored by that same account.
- [ ] Playtest/app-account fallback attribution is rejected and cleaned up instead of appearing as a successful player share.
- [ ] Re-sharing the same result returns the existing comment; deleting it allows a new share.

### Cross-account testing

- [ ] Developer account tested
- [ ] Moderator account tested
- [ ] Regular user account tested

### Release operations

- [x] `README.md` still matches the shipped product and moderator flow.
- [x] `CHANGELOG.md` reflects the main launchable changes.
- [x] `npm test` passes on the version being published.
- [x] The `1.0.0` upload and remote build succeeded.
- [x] `devvit publish --version 1.0.0` submitted the intended unlisted release.

## Publish notes

- Default launch command in this repo: `npm run launch`
- Equivalent direct command: `npx devvit publish`
- Recommended mode for this game: **unlisted publish**
- Use `--public` only if the product direction changes and Mini Racer becomes a general-purpose app for any community
- Version `1.0.0` was uploaded on July 10, 2026 and is pending Reddit review because the app creates custom posts.

## Reviewer summary

Mini Racer is a subreddit-specific racing game with:

- A custom inline launch screen
- A full expanded gameplay view
- Server-side replay validation
- Redis-backed daily leaderboards
- Moderator-controlled post creation

## Open decision before launch

- [x] Confirm the production subreddit name: `MiniRacerGame`
- [ ] Confirm who owns launch-day moderation and player support
- [x] Confirm the first publish version number and release date: `1.0.0`, submitted July 10, 2026
