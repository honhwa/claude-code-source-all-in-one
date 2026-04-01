#!/usr/bin/env bash
#
# Start Claude Code - one-command launcher
# Usage:
#   ./start.sh                     # Interactive mode
#   ./start.sh -p "your prompt"    # Non-interactive mode
#   ./start.sh --help              # Show help
#

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Ensure bun is in PATH
export PATH="$HOME/.bun/bin:$PATH"

# Check if setup has been done
if [ ! -d "node_modules/@anthropic-ai/sdk" ]; then
  echo "First run detected. Running setup..."
  node scripts/setup.mjs
  echo ""
fi

# Check API key
if [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "Error: ANTHROPIC_API_KEY is not set."
  echo ""
  echo "  export ANTHROPIC_API_KEY=\"sk-ant-xxx\""
  echo ""
  echo "Or for third-party proxies:"
  echo ""
  echo "  export ANTHROPIC_BASE_URL=\"https://your-proxy.com\""
  echo "  export ANTHROPIC_API_KEY=\"your-key\""
  echo "  export DISABLE_PROMPT_CACHING=1"
  echo ""
  exit 1
fi

# Auto-detect third-party proxy and disable incompatible features
if [ -n "$ANTHROPIC_BASE_URL" ] && ! echo "$ANTHROPIC_BASE_URL" | grep -q "anthropic.com"; then
  export DISABLE_PROMPT_CACHING="${DISABLE_PROMPT_CACHING:-1}"
  export DISABLE_INTERLEAVED_THINKING="${DISABLE_INTERLEAVED_THINKING:-1}"
  export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS="${CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS:-1}"
fi

exec bun src/entrypoints/cli.tsx "$@"
