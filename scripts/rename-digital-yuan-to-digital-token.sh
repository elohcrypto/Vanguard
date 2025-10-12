#!/bin/bash

# Script to rename all "digitalYuanToken" and "DIGITAL YUAN" references to "digitalToken"
# This is a comprehensive refactoring across the entire codebase

echo "🔄 Starting comprehensive rename: digitalYuanToken → digitalToken"
echo "================================================================"

# Files to modify
FILES=(
    "demo/interactive-kyc-aml-utxo-proof.js"
    "demo/vanguard-stablecoin-ecosystem-test.js"
    "docs/MISSING_FUNCTION_FIX.md"
    "docs/INVESTOR_TYPE_THRESHOLD_UPDATE_SUMMARY.md"
    "VANGUARD_STABLECOIN_ECOSYSTEM_GUIDE.md"
    "WORKING_DEMOS.md"
)

# Backup files first
echo "📦 Creating backups..."
for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        cp "$file" "$file.backup"
        echo "   ✅ Backed up: $file"
    fi
done

echo ""
echo "🔧 Applying replacements..."

# Replacement patterns
# 1. Variable names: digitalYuanToken → digitalToken
# 2. Display text: DIGITAL YUAN → DIGITAL TOKEN
# 3. Display text: Digital Yuan → Digital Token
# 4. Comments: Vanguard StableCoin → Digital Token (where appropriate)

for file in "${FILES[@]}"; do
    if [ -f "$file" ]; then
        echo "   📝 Processing: $file"
        
        # Variable name replacements
        sed -i 's/digitalYuanToken/digitalToken/g' "$file"
        sed -i 's/this\.digitalYuanToken/this.digitalToken/g' "$file"
        sed -i 's/contracts\.digitalYuanToken/contracts.digitalToken/g' "$file"
        
        # Display text replacements
        sed -i 's/DIGITAL YUAN/DIGITAL TOKEN/g' "$file"
        sed -i 's/Digital Yuan/Digital Token/g' "$file"
        
        # Function/method name replacements
        sed -i 's/deployVanguardStableCoinSystem/deployDigitalTokenSystem/g' "$file"
        sed -i 's/showVanguardStableCoinDashboard/showDigitalTokenDashboard/g' "$file"
        sed -i 's/deployERC3643VanguardStableCoinSystem/deployERC3643DigitalTokenSystem/g' "$file"
        sed -i 's/showERC3643VanguardStableCoinDashboard/showERC3643DigitalTokenDashboard/g' "$file"
        sed -i 's/integrateOraclesWithVanguardStableCoin/integrateOraclesWithDigitalToken/g' "$file"
        sed -i 's/integratePrivacyWithVanguardStableCoin/integratePrivacyWithDigitalToken/g' "$file"
        sed -i 's/getVanguardStableCoinTokenAddress/getDigitalTokenAddress/g' "$file"
        
        # Comment replacements (selective)
        sed -i 's/Vanguard StableCoin Token System/Digital Token System/g' "$file"
        sed -i 's/Vanguard StableCoin token/Digital Token/g' "$file"
        sed -i 's/Vanguard StableCoin Token/Digital Token/g' "$file"
        
        echo "      ✅ Completed"
    else
        echo "      ⚠️  File not found: $file"
    fi
done

echo ""
echo "📊 Summary of changes:"
echo "   • digitalYuanToken → digitalToken"
echo "   • DIGITAL YUAN → DIGITAL TOKEN"
echo "   • Digital Yuan → Digital Token"
echo "   • Vanguard StableCoin Token → Digital Token (in code contexts)"
echo "   • Function names updated to match"

echo ""
echo "✅ Rename complete!"
echo ""
echo "📋 Next steps:"
echo "   1. Review changes: git diff"
echo "   2. Test the demo: npm run demo:interactive:proof"
echo "   3. If satisfied, remove backups: rm *.backup"
echo "   4. If issues, restore: for f in *.backup; do mv \"\$f\" \"\${f%.backup}\"; done"

