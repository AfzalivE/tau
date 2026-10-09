# Sandbox

Sandboxes Bash commands and their descendants on macOS and Linux, including calls through codemode. Pi itself, other tools, and MCP servers retain host permissions. Run `/sandbox` for help.

Relative filesystem rules and socket paths resolve from the owning session's working directory, including session-only `/sandbox filesystem` changes. Configuration files are not rewritten.

Terminal-status reports may expose approval titles containing commands, paths, or hosts. Disable these reports with `PI_PROGRAM_STATUS=0`.
