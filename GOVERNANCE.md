# Governance

Open App Bridge begins as a maintainer-led open-source project.

## Principles

- Interoperability decisions are documented publicly.
- Security and user agency take priority over convenience.
- The base protocol remains implementable without a central service.
- No single receiver or sender product receives privileged wire behavior.
- Claims about identity and assurance must match observable evidence.

## Decision process

Routine fixes may be merged after review and passing checks. Changes to the
wire protocol, discovery contract, security model, or compatibility policy
require:

1. a public issue describing the use case and alternatives;
2. a written architecture decision when the change is structural;
3. test vectors or interoperability evidence; and
4. an explicit maintainer decision recorded in the issue or pull request.

## Maintainers

Maintainers review contributions, manage releases, coordinate disclosures, and
protect the project's design principles. During the draft phase, the owner of
the canonical repository is the initial maintainer. Additional maintainers are
recorded through public governance changes.

## Releases and distribution

Official releases of the protocol specifications, reference SDKs, and drop-in
components follow the distribution, provenance, and supply-chain policies
documented in [DISTRIBUTION.md](DISTRIBUTION.md).

## Evolution

If the contributor community grows, the project may adopt multiple maintainers
and a lightweight voting or consensus process. Such a change must preserve the
public decision record and neutral protocol ownership.
