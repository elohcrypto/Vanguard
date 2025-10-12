#!/bin/bash

# Cleanup Outdated Scripts
# This script removes or archives outdated scripts that reference deleted demo files

echo "🧹 CLEANUP OUTDATED SCRIPTS"
echo "======================================================"
echo ""

# Create archive directory
echo "📁 Creating archive directory..."
mkdir -p archive/scripts/broken-scripts
mkdir -p archive/scripts/legacy-demos
mkdir -p archive/scripts/legacy-runners

echo "✅ Archive directories created"
echo ""

# Priority 1: Move broken scripts (reference non-existent files)
echo "🔴 Priority 1: Archiving BROKEN scripts..."
echo "   These scripts reference files that no longer exist"
echo ""

BROKEN_SCRIPTS=(
    "run-interactive-comprehensive-demo.js"
    "test-interactive-demo.js"
    "test-demo-integration.js"
    "fix-compliance-rules-functions.js"
    "add-governance-to-demo.js"
)

for script in "${BROKEN_SCRIPTS[@]}"; do
    if [ -f "scripts/$script" ]; then
        echo "   📦 Archiving: $script"
        mv "scripts/$script" "archive/scripts/broken-scripts/"
    else
        echo "   ⚠️  Not found: $script (already removed?)"
    fi
done

echo ""
echo "✅ Broken scripts archived to: archive/scripts/broken-scripts/"
echo ""

# Priority 2: Move legacy TypeScript demos
echo "🟡 Priority 2: Archiving LEGACY TypeScript demos..."
echo "   These are old demos from before modular refactoring"
echo ""

LEGACY_DEMOS=(
    "comprehensive-demo.ts"
    "erc3643-demo.ts"
    "interactive-erc3643-demo.ts"
    "key-recovery-demo.ts"
)

for script in "${LEGACY_DEMOS[@]}"; do
    if [ -f "scripts/$script" ]; then
        echo "   📦 Archiving: $script"
        mv "scripts/$script" "archive/scripts/legacy-demos/"
    else
        echo "   ⚠️  Not found: $script (already removed?)"
    fi
done

echo ""
echo "✅ Legacy demos archived to: archive/scripts/legacy-demos/"
echo ""

# Priority 3: Move legacy JavaScript runners
echo "🟡 Priority 3: Archiving LEGACY JavaScript runners..."
echo "   These may reference old demo files"
echo ""

LEGACY_RUNNERS=(
    "run-demo-only.js"
    "run-erc3643-demo.js"
    "run-interactive-erc3643-demo.js"
    "run-key-recovery-demo.js"
    "run-hardhat-demo.js"
)

for script in "${LEGACY_RUNNERS[@]}"; do
    if [ -f "scripts/$script" ]; then
        echo "   📦 Archiving: $script"
        mv "scripts/$script" "archive/scripts/legacy-runners/"
    else
        echo "   ⚠️  Not found: $script (already removed?)"
    fi
done

echo ""
echo "✅ Legacy runners archived to: archive/scripts/legacy-runners/"
echo ""

# Create README in archive
echo "📝 Creating archive README..."

cat > archive/scripts/README.md << 'EOF'
# Archived Scripts

This directory contains scripts that have been archived during the modular refactoring.

## Directory Structure

### `broken-scripts/`
Scripts that reference files that no longer exist:
- `run-interactive-comprehensive-demo.js` - Referenced deleted `demo/interactive-comprehensive-demo.js`
- `test-interactive-demo.js` - Referenced deleted `demo/interactive-comprehensive-demo.js`
- `test-demo-integration.js` - Referenced deleted `demo/interactive-kyc-aml-utxo-proof.js`
- `fix-compliance-rules-functions.js` - Referenced deleted `demo/interactive-kyc-aml-utxo-proof.js`
- `add-governance-to-demo.js` - Referenced deleted `demo/interactive-kyc-aml-utxo-proof.js`

**Status:** ❌ Non-functional - kept for historical reference only

### `legacy-demos/`
Old TypeScript demo files from before modular refactoring:
- `comprehensive-demo.ts` - Old comprehensive demo (561 lines)
- `erc3643-demo.ts` - Old ERC-3643 demo
- `interactive-erc3643-demo.ts` - Old interactive demo
- `key-recovery-demo.ts` - Old key recovery demo

**Status:** ⚠️ May still work but replaced by modular architecture

### `legacy-runners/`
Old JavaScript runner scripts:
- `run-demo-only.js` - Old demo runner
- `run-erc3643-demo.js` - Old ERC-3643 runner
- `run-interactive-erc3643-demo.js` - Old interactive runner
- `run-key-recovery-demo.js` - Old key recovery runner
- `run-hardhat-demo.js` - Old Hardhat demo runner

**Status:** ⚠️ May reference old demo files

## Current Demo

The current working demo is:

```bash
npm run demo:interactive:proof
```

This runs `demo/index.js` which uses the modular architecture with 9 feature modules.

## Archive Date

**Archived:** 2025-01-12  
**Reason:** Modular refactoring - replaced monolithic demo with modular architecture

EOF

echo "✅ Archive README created"
echo ""

# Summary
echo "======================================================"
echo "🎉 CLEANUP COMPLETE!"
echo "======================================================"
echo ""
echo "📊 Summary:"
echo "   ✅ Broken scripts archived: ${#BROKEN_SCRIPTS[@]}"
echo "   ✅ Legacy demos archived: ${#LEGACY_DEMOS[@]}"
echo "   ✅ Legacy runners archived: ${#LEGACY_RUNNERS[@]}"
echo ""
echo "📁 Archive locations:"
echo "   • archive/scripts/broken-scripts/"
echo "   • archive/scripts/legacy-demos/"
echo "   • archive/scripts/legacy-runners/"
echo ""
echo "✅ Current working demo:"
echo "   npm run demo:interactive:proof"
echo ""
echo "📋 Next steps:"
echo "   1. Review archived scripts if needed"
echo "   2. Delete archive directory if you don't need them"
echo "   3. See SCRIPTS_AUDIT_REPORT.md for full details"
echo ""
echo "======================================================"

