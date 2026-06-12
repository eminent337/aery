#!/bin/bash
set -e

echo "========================================="
echo "       AERY CI SIMULATION SCRIPT         "
echo "========================================="
echo ""
echo "[1/4] Checking formatting (Biome)..."
bun run fmt

echo ""
echo "[2/4] Checking TypeScript types..."
bun run check:ts

echo ""
echo "[3/4] Running Rust tests..."
bun run test:rs

echo ""
echo "[4/4] Running TypeScript tests (with 30s timeout)..."
# Setting timeout locally to catch any hanging tests just like in CI
bun run test:ts --timeout 30000

echo ""
echo "========================================="
echo "✅ CI SIMULATION PASSED!"
echo "You are ready to push and release."
echo "========================================="
