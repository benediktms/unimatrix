# unimatrix — dual-platform agent framework

set dotenv-load := false

# List available commands
default:
    @just --list

project_root := justfile_directory()
python := project_root / ".venv/bin/python3"

# Create/refresh Python virtual environment
venv:
    python3 -m venv .venv
    {{python}} -m pip install -q -e .

# Install all dependencies (Python venv + Deno cache)
setup: venv
    deno install

# Build for both platforms
build: (_build "all")

# Build for a specific target (claude, opencode, all)
_build target:
    {{python}} build.py --target {{target}}

# Build for Claude Code only
build-claude: (_build "claude")

# Build for OpenCode only
build-opencode: (_build "opencode")

# Compile the unimatrix MCP server binary
compile:
    mkdir -p bin
    deno compile --allow-read --allow-env --output bin/unimatrix src/skills/borgcube/server.ts

# Install to a project for Claude Code
install-claude path=project_root: build-claude compile
    bash install.sh --claude --project {{path}}

# Install to a project for OpenCode
install-opencode path=project_root: build-opencode compile
    bash install.sh --opencode --project {{path}}

# Install both platforms to a project
install path=project_root: build compile
    bash install.sh --both --project {{path}}

# Install both platforms globally
install-global: build compile
    bash install.sh --both --global

# Inject Borg personality into a brain's AGENTS.md
inject brain:
    {{python}} build.py --inject-tone {{brain}}

# Validate source files (structural checks)
validate:
    {{python}} build.py --validate

# Type-check the OpenCode hook plugin
check-ts:
    deno check src/hooks/opencode/unimatrix-hooks.ts

# Lint Python files
check-py:
    {{python}} -m py_compile build.py
    @for f in src/hooks/claude/*.py src/shared/*.py; do \
        {{python}} -m py_compile "$f" && echo "  ok: $f"; \
    done

# Run all checks
check: check-py check-ts validate

# Clean build output
clean:
    rm -rf dist/

# Full clean (build output + deps)
clean-all: clean
    rm -rf .venv/
