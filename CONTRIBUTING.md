# Contributing

Thank you for helping make content interoperability safer and more open.

## Before opening a change

- Search existing issues and protocol discussions.
- Use an issue for wire-format, security-boundary, or compatibility changes.
- Keep product-specific UX outside the normative specification.
- Never weaken receiver opt-in, user mediation, exact-origin checks, preview, or
  resource limits for convenience.

## Development

Requires Node.js 20 or newer. There are no runtime dependencies.

```bash
npm test
npm run check
npm run release:prepare
```

Every behavior change should include tests. Protocol changes should also update:

- `spec/open-app-bridge-1.0.md`;
- relevant JSON schemas;
- TypeScript declarations;
- integration examples; and
- `CHANGELOG.md`.

## Pull requests

Keep pull requests focused and explain:

1. the problem;
2. the observable behavior before and after;
3. security and privacy implications;
4. interoperability impact; and
5. verification performed.

By submitting a contribution, you agree that it is licensed under Apache-2.0.

## Protocol compatibility

Before stable 1.0, breaking draft changes require a changelog entry and updated
fixtures. After stable 1.0, incompatible wire changes require a new version.

## Release and distribution hygiene

The repository tracks clean source code only. Never commit minified bundles or
compiled release artifacts to Git. Official release packaging and distribution
rules are detailed in [DISTRIBUTION.md](DISTRIBUTION.md).

## Community behavior

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
