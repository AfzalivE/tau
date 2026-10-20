# Changelog

All notable changes to `pi-code-links` are documented in this file.

The format is based on [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/), and this package uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-20

### Fixed

- Linked references to Kotlin extension functions and properties, such as `DiagramScene.accessibleDescription(fallback)`, through their receiver type. Universal Ctags scopes them to their package, so these references stayed plain text when another file defined the same name.
- Linked calls with arguments inside code spans, such as `` `Foo.bar(baz)` ``.

## [0.1.0] - 2026-10-20

### Added

- Linked file paths, `path:line[:column]` positions, and code symbols in user messages and finished assistant replies, using a Universal Ctags index of the Git working tree.
- Added the `/code-links` command to choose `zed`, `vscode`, `vscode-insiders`, `vscodium`, `cursor`, `idea`, `studio`, `textmate`, `macvim`, `nova`, or `file` links.

[Unreleased]: https://github.com/AfzalivE/tau/commits/main/packages/pi-code-links
[0.1.1]: https://www.npmjs.com/package/pi-code-links/v/0.1.1
[0.1.0]: https://www.npmjs.com/package/pi-code-links/v/0.1.0
