#!/usr/bin/env bash
set -e
echo "Installing Aery..."
if ! command -v node &> /dev/null; then
  echo "Error: Node.js 20+ required. Install from https://nodejs.org"
  exit 1
fi
cd packages/coding-agent
npm install
npm run build
npm install -g .
echo "✓ Aery installed! Run: aery"
