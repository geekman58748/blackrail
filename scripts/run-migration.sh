#!/bin/bash
# BlackRail - Run this in Render Shell
# Go to: Render Dashboard → your API service → Shell tab

echo "=== Running Liquidity Layer Migration ==="
psql $DATABASE_URL -f migrations/0005_liquidity_layer.sql

echo ""
echo "=== Migration Complete! ==="
echo ""
echo "Next steps:"
echo "1. Set FLUTTERWAVE_SECRET_KEY in Render Environment"
echo "2. Enable Transfers in Flutterwave Dashboard"
echo "3. Seed pool: curl -X POST https://blackrail-api.onrender.com/api/liquidity/pool/seed -H 'Content-Type: application/json' -d '{\"amount\": 15000}'"
