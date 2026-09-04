# Distribution and release policy

This document defines how the Open App Bridge (OAB) specification, schemas,
reference SDK, and drop-in sender widget are released. The protocol remains
registry-free: npm, GitHub, and CDNs distribute implementation code, but no OAB
handoff depends on an OAB-operated service or registry.

## Supported channels

### npm: normal application builds

The primary JavaScript package is `open-app-bridge`. Applications should pin an
exact reviewed version in their lockfile:

```sh
npm install --save-exact open-app-bridge@1.0.0
```

Bundled applications import the reference API or register the framework-neutral
custom element directly:

```js
import {
  createHandoff,
  discoverReceiver,
  prepareContent,
} from "open-app-bridge";
import "open-app-bridge/widget";
```

The npm package includes readable ES modules, TypeScript declarations, normative
schemas, documentation, and generated standalone bundles in `dist/`. npm is a
build-time distribution channel; receiver applications self-host the output
they deploy.

### GitHub Releases: immutable standalone assets

Every stable tag `vX.Y.Z` publishes:

- the exact npm package archive;
- readable and minified core ESM bundles;
- readable and minified `<oab-share>` ESM bundles;
- the widget stylesheet and source maps;
- `manifest.json` with byte lengths, SHA-256, SHA-384, and SRI values;
- exact-version integration markup in `INTEGRATION.md`;
- `SHA256SUMS` and `SHA384SUMS`; and
- GitHub artifact attestations bound to the release workflow and commit.

The release archive is suitable for self-hosting, review, offline builds, and
environments that do not use npm.

### npm-backed CDNs: sender-only convenience

A static sender may load the exact-version `oab-widget.min.js` asset from an
npm-backed CDN. Production markup must pin the full SDK version, use the
official SHA-384 value from that release's `INTEGRATION.md` or `manifest.json`,
and set `crossorigin="anonymous"`. The bundle loads its adjacent
`oab-widget.css` and contains that stylesheet's independent SHA-384 integrity
value.

Never use `@latest`, an unversioned URL, a branch URL, or an integrity-free CDN
script in production. CDN use is an optional delivery convenience and does not
make the CDN part of the OAB protocol.

## Security boundary by role

| Role | Supported consumption | Required boundary |
| --- | --- | --- |
| Sender application | npm, self-hosted release assets, or exact-version CDN bundle | CDN scripts require SRI; ordinary sender CSP and dependency policy still apply. |
| Receiver capture Document | npm at build time or self-hosted release assets | The deployed runtime and its complete restricted resource graph must be first-party and self-hosted. |
| Detached helper and sender callback Documents | npm at build time or self-hosted release assets | Every transitive script, style, font, image, and other resource must be first-party, self-hosted, and covered by the restricted utility-Document rules. |

An independent implementation may conform to OAB without using the official
SDK. These channel rules govern official artifacts and applications that choose
to consume them; they do not turn one JavaScript package into the protocol.

## Source snapshots and vendoring

Copying an arbitrary current `src/` directory is not a supported installation
instruction. It loses package boundaries, provenance, upgrade visibility, and a
repeatable dependency record.

An audited source snapshot remains a valid fallback for constrained or
air-gapped builds when all of the following are recorded:

1. an immutable release tag or full Git commit;
2. the exact copied files and local modifications;
3. the Apache-2.0 `LICENSE` and `NOTICE`; and
4. a process for reviewing OAB security releases.

Never vendor from a moving branch.

## Build and verification

Generated files are excluded from Git. A clean checkout produces them with the
exact esbuild version in `package-lock.json`:

```sh
npm ci
npm run build
npm run test:distribution
npm run build:verify
```

`build:verify` performs two isolated builds and compares every output byte.
`test:distribution` verifies the artifact manifest, hashes, required API
exports, minification, and the widget-to-stylesheet integrity binding. Browser
CI additionally loads the minified widget bundle and verifies custom-element
registration and stylesheet integrity behavior.

`npm run release:prepare` runs the repository tests, generates the artifacts,
tests them, and verifies reproducibility. `npm pack` runs the same gate through
`prepack`.

## Release authorization and provenance

Stable releases are created only from a `vX.Y.Z` tag whose version exactly
equals `package.json`. The `npm-release` GitHub environment
should require maintainer approval.

npm publication uses npm Trusted Publishing from
`.github/workflows/release.yml`, with GitHub OIDC and no long-lived npm token.
The npm package is public and requests npm provenance. GitHub Release assets are
attested in the same job. Maintainer npm and GitHub accounts must enable
phishing-resistant 2FA where available.

Before the first automated publication, a maintainer must reserve
`open-app-bridge` on npm, configure this repository and release workflow as the
package's trusted publisher, and protect the `npm-release` environment. The
package name was unclaimed when this policy was written; that is not a permanent
reservation until the first publication succeeds.

The `prepublishOnly` guard rejects publication outside the exact tagged release
workflow. It is an accidental-release safeguard; npm ownership, environment
approval, protected tags, trusted publishing, and account security remain the
authoritative controls. Any one-time package-name bootstrap must be separately
reviewed and must not add a persistent registry credential to this workflow.

## Versioning

SDK versions follow Semantic Versioning. Wire identifiers such as `1.0`,
`link-envelope/1`, and `detached-datachannel/1` are separate compatibility
contracts:

- SDK patch: compatible fix, documentation, or internal optimization;
- SDK minor: backward-compatible public API addition or support for an optional
  standardized profile;
- SDK major: breaking JavaScript/TypeScript API change; and
- wire break: a new wire/profile identifier and compatibility documentation,
  regardless of the SDK SemVer chosen for the implementation release.

Security reports follow [SECURITY.md](SECURITY.md). The project publishes an
advisory and patched release when the issue and ecosystem support it; consumers
remain responsible for monitoring releases and updating their pinned version.

## Licensing

Every generated JavaScript and CSS bundle carries a concise Apache-2.0 banner.
The npm archive and GitHub release preserve the complete [LICENSE](LICENSE) and
[NOTICE](NOTICE) files.
