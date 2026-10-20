# pi-code-links

[Pi](https://pi.dev) extension that turns file paths and code symbols in the transcript into links that open in your editor.

## Install

```bash
pi install npm:pi-code-links
```

Project-local install lets a repository pin the extension for everyone working on it:

```bash
pi install -l npm:pi-code-links
```

## Requirements

- [Universal Ctags](https://ctags.io) on `PATH`, for example `brew install universal-ctags`. macOS ships BSD ctags in `/usr/bin`; the extension skips it and looks for Universal Ctags. Without it, Pi shows a warning and the transcript stays unchanged.
- A terminal with OSC 8 hyperlink support, such as Ghostty, iTerm2, kitty, or WezTerm.
- An interactive Pi session in a Git working tree. Print and RPC modes are unchanged.

## Usage

In finished user and assistant messages, these references become links:

| Reference       | Opens                                                    |
| --------------- | -------------------------------------------------------- |
| `src/Foo.kt:42` | The file at line 42                                      |
| `Foo.kt`        | The file, when only one file has that name               |
| `Foo.bar()`     | The definition of `bar` in `Foo`; `::` and `#` also work |
| `` `Foo` ``     | The definition of `Foo`, inside a code span              |

File references need an extension. Bare names in prose, names defined in more than one file, fenced code blocks, and existing links stay as they are. Only the rendered text changes; the session keeps the original messages.

When a session starts, the extension indexes the files that Git tracks, plus untracked files that Git does not ignore. It updates a file's entries after the `edit` or `write` tool changes it.

## Editors

```text
/code-links           # choose from a list
/code-links vscode    # choose directly
```

| Editor            | Link                                                      |
| ----------------- | --------------------------------------------------------- |
| `zed`             | `zed://file` (default)                                    |
| `vscode`          | `vscode://file`                                           |
| `vscode-insiders` | `vscode-insiders://file`                                  |
| `vscodium`        | `vscodium://file`                                         |
| `cursor`          | `cursor://file`                                           |
| `idea`            | `idea://open`, for IntelliJ IDEA and other JetBrains IDEs |
| `studio`          | `idea://open`, for Android Studio                         |
| `textmate`        | `txmt://open`                                             |
| `macvim`          | `mvim://open`                                             |
| `nova`            | `nova://open`                                             |
| `file`            | `file://`, opened by the system default app               |

`idea` and `studio` produce the same link. Every JetBrains IDE registers the `idea` scheme, and macOS sends it to one default app.

The choice is saved in `code-links.json` in the Pi agent directory (`~/.pi/agent` by default).

## License

MIT
