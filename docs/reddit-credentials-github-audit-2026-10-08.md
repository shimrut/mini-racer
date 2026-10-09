# Reddit credentials GitHub audit — 2026-10-08

## Result

No Reddit or Devvit credentials were found in the checked Git history or current
Git-visible project files. No secret values were printed or copied into this note.

## Evidence and scope

- Read the live advertised references from `https://github.com/shimrut/mini-racer.git`.
  GitHub advertised 30 branches and no tags or pull-request references. Every
  branch tip matched its local `origin` reference, and every tip was available
  locally in this non-shallow checkout.
- Scanned all 1,127 commits reachable from local references, including the 1,079
  commits reachable from the verified GitHub branch tips. Inspected all 9,357
  unique historical file blobs (242,534,251 bytes).
- Compared every historical blob with the current locally stored Devvit token,
  its decoded representation, and its Reddit access and refresh tokens. No
  matches were found. These values stayed in process memory during the scan.
- Checked historical text for quoted assignments to Devvit/Reddit token,
  password, and client-secret fields, plus JWT-shaped strings. No candidates
  were found. These heuristic checks supplement the exact-token comparisons;
  they cannot prove the absence of every possible old or transformed secret.
- Checked 1,259 current tracked and non-ignored untracked files for the same
  current credentials. No matches were found.
- The current Devvit login token resides at `~/.devvit/token`, outside this
  repository. `.env` is empty; `.env.local` contains a Mapmaker configuration
  key, rather than Reddit authentication. Both environment files are ignored
  by `.gitignore`, are untracked, and have no path history in the checked refs.

This audit covers current advertised GitHub branches and their reachable history,
plus local referenced history. It does not inspect GitHub Actions secrets,
unadvertised or deleted refs, other repositories, or credentials no longer
available locally for exact comparison. No credential was revoked or changed.

## Validation

The audit used read-only Git, file, and credential comparisons. Repository changes
are limited to this note; existing working changes were preserved. Documentation
validation checks whitespace and confirms this note contains none of the current
authentication values. Application tests are unnecessary for this documentation-only
addition.
