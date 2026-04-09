#!/bin/bash
set -e

# Backup original
cp db.ts db.ts.bak

# CHANGE 1: Add Phase 0 migration columns after supervision columns block
cat > temp_change1.txt << 'EOF'

    // Phase 0 columns
    const phase0Columns = [
      "ALTER TABLE tasks ADD COLUMN attempt_id INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN result_finding_id INTEGER",
    ]
    for (const sql of phase0Columns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }
EOF

sed -i.tmp '251i\' db.ts && cat temp_change1.txt >> db.ts.temp && tail -n +251 db.ts >> db.ts.temp && head -n 250 db.ts.bak > db.ts && cat db.ts.temp >> db.ts && rm db.ts.temp

# Let's use a different approach with Python for better control
python3 << 'EOFPYTHON'
import re

with open('db.ts', 'r') as f:
    content = f.read()

# CHANGE 1: Add Phase 0 migration columns after supervision columns block
phase0_code = '''
    // Phase 0 columns
    const phase0Columns = [
      "ALTER TABLE tasks ADD COLUMN attempt_id INTEGER DEFAULT 0",
      "ALTER TABLE tasks ADD COLUMN result_finding_id INTEGER",
    ]
    for (const sql of phase0Columns) {
      try { this.db.exec(sql) } catch { /* column already exists */ }
    }'''

# Find the position after supervision columns block
pattern = r'(for \(const sql of supervisionColumns\) \{[\s\S]*?\}\n)'
match = re.search(pattern, content)
if match:
    insert_pos = match.end()
    content = content[:insert_pos] + phase0_code + '\n' + content[insert_pos:]
    print("✓ Change 1: Added Phase 0 migration columns")
else:
    print("✗ Change 1 failed: Could not find supervision columns block")

# CHANGE 2: Add feature_flags table after phase0Columns block
feature_flags_code = '''
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS feature_flags (
        flag_name TEXT PRIMARY KEY,
        enabled INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('blackboard_enabled', 0);
      INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('progress_events_enabled', 0);
      INSERT OR IGNORE INTO feature_flags (flag_name, enabled) VALUES ('gates_enabled', 0);
    `)'''

pattern = r'(for \(const sql of phase0Columns\) \{[\s\S]*?\}\n)'
match = re.search(pattern, content)
if match:
    insert_pos = match.end()
    content = content[:insert_pos] + feature_flags_code + '\n' + content[insert_pos:]
    print("✓ Change 2: Added feature_flags table")
else:
    print("✗ Change 2 failed: Could not find phase0Columns block")

# CHANGE 3: Update Task interface - add attempt_id and result_finding_id
interface_pattern = r'(export interface Task \{[\s\S]*?is_synthetic: number\n\})'
if re.search(interface_pattern, content):
    content = re.sub(
        r'(is_synthetic: number\n\})',
        r'is_synthetic: number\n  attempt_id: number\n  result_finding_id: number | null\n}',
        content
    )
    print("✓ Change 3: Updated Task interface with attempt_id and result_finding_id")
else:
    print("✗ Change 3 failed: Could not find Task interface")

# CHANGE 4: Add attempt_id increment in claimTaskWithSession
claimtask_pattern = r'(claimTaskWithSession\([\s\S]*?return stmt\.get\([^)]+\) as Task \| null)'
if re.search(claimtask_pattern, content):
    # This is complex, let's find the method and add the increment
    pattern = r'(claimTaskWithSession\(id: number, agent: string, sessionId\?: string\): Task \| null \{[\s\S]*?)(\s+return stmt\.get)'
    match = re.search(pattern, content)
    if match:
        indent = '      '
        increment_code = f'''
      const result = stmt.get(sessionId ?? null, hbTimeout, id, agent) as Task | null
      if (result) {{
        db.prepare('UPDATE tasks SET attempt_id = COALESCE(attempt_id, 0) + 1 WHERE id = ?').run(id)
      }}
      return result'''
        # Find and replace the return statement in claimTaskWithSession
        content = re.sub(
            r'(claimTaskWithSession\(id: number, agent: string, sessionId\?: string\): Task \| null \{[\s\S]*?const stmt = db\.prepare\(`[\s\S]*?`\)[\s\S]*?)(return stmt\.get\([^)]+\) as Task \| null)',
            lambda m: m.group(1) + increment_code,
            content
        )
        print("✓ Change 4a: Added attempt_id increment in claimTaskWithSession")
    else:
        print("✗ Change 4a failed: Could not parse claimTaskWithSession")
else:
    print("✗ Change 4a failed: Could not find claimTaskWithSession method")

# CHANGE 5: Add helper methods before close()
helper_methods = '''
  isFeatureEnabled(flagName: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM feature_flags WHERE flag_name = ?').get(flagName) as any
    return row ? !!row.enabled : false
  }

  setFeatureFlag(flagName: string, enabled: boolean): void {
    this.db.prepare('INSERT OR REPLACE INTO feature_flags (flag_name, enabled) VALUES (?, ?)').run(flagName, enabled ? 1 : 0)
  }

'''

close_pattern = r'(\n  close\(\): void \{)'
if re.search(close_pattern, content):
    content = re.sub(close_pattern, f'\n{helper_methods}\n  close(): void {{', content)
    print("✓ Change 5: Added helper methods isFeatureEnabled and setFeatureFlag")
else:
    print("✗ Change 5 failed: Could not find close() method")

with open('db.ts', 'w') as f:
    f.write(content)

print("\n✓ All changes applied to db.ts")
EOFPYTHON

