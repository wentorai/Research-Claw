#!/bin/bash
#
# Initialize Memory Plugin Demo
#
# This script initializes the memory plugin with sample data.
#

set -e

echo "🧠 Research-Claw Memory Plugin Demo Initialization"
echo "=================================================="
echo ""

# Check if database exists.
# RC data dir was migrated from the in-project .research-claw to ~/.research-claw
# (see scripts/migrate-rc-data-dir.cjs and the RC_DB_PATH default in ensure-config.cjs).
DB_PATH="$HOME/.research-claw/library.db"

if [ ! -f "$DB_PATH" ]; then
  echo "❌ Database not found at $DB_PATH"
  echo "Please start research-claw first to create the database."
  exit 1
fi

echo "✅ Database found at $DB_PATH"
echo ""

# Check if memory tables exist
if sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='rc_memories';" | grep -q "rc_memories"; then
  echo "✅ Memory tables already exist"
else
  echo "❌ Memory tables not found"
  echo "Please rebuild the extension to create the tables:"
  echo "  cd extensions/research-claw-core && pnpm build"
  exit 1
fi

echo ""
echo "📊 Current database status:"
sqlite3 "$DB_PATH" <<EOF
SELECT
  (SELECT COUNT(*) FROM rc_memories) as memories,
  (SELECT COUNT(*) FROM rc_memory_tags) as tags,
  (SELECT COUNT(*) FROM rc_memory_links) as links;
EOF

echo ""
echo "✅ Memory plugin demo is ready!"
echo ""
echo "📖 To use the memory plugin:"
echo "   1. Start research-claw: pnpm serve"
echo "   2. Open Dashboard: http://127.0.0.1:28789"
echo "   3. Navigate to the Memory panel"
echo "   4. Or use tools in chat: memory_create, memory_search, etc."
echo ""
echo "🎉 Enjoy managing your memories!"
