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
- [ ] The retry flow is fast and predictable after a finish or crash.

### Reddit-specific setup

- [ ] A dedicated production subreddit exists for Mini Racer: `MiniRacerGame`. Do not launch from `mini_racer_dev`.
- [ ] The moderator install flow is confirmed in the target subreddit.
- [ ] The **Create Mini Racer post** menu item successfully creates a playable post.
- [ ] At least one example post has been created and reviewed end to end.

### Quality and trust

- [ ] Daily challenge loading works for a signed-in Reddit user.
- [ ] Leaderboard reads and submissions work for real users in Reddit context.
- [ ] Reddit username display behaves correctly when identity is enabled.
- [ ] Guest fallback identity behaves correctly when Reddit username display is unavailable or off.
- [ ] Invalid or suspicious replay submissions are rejected cleanly.
- [ ] Error states are understandable and do not leave the player stuck.

### Cross-account testing

- [ ] Developer account tested
- [ ] Moderator account tested
- [ ] Regular user account tested

### Release operations

- [ ] `README.md` still matches the shipped product and moderator flow.
- [ ] `CHANGELOG.md` reflects the main launchable changes.
- [ ] `npm test` passes on the version being published.
- [ ] `devvit upload` succeeds.
- [ ] `devvit publish` is run with the intended version bump strategy.

## Publish notes

- Default launch command in this repo: `npm run launch`
- Equivalent direct command: `npx devvit publish`
- Recommended mode for this game: **unlisted publish**
- Use `--public` only if the product direction changes and Mini Racer becomes a general-purpose app for any community

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
- [ ] Confirm the first publish version number and release date
