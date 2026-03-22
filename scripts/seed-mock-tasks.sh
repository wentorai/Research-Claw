#!/usr/bin/env bash
# Seed 100 mock tasks into the Research-Claw database.
#
# Distribution:
#   30 todo, 20 in_progress, 10 blocked, 25 done, 15 cancelled
#   Mixed priorities: 15 urgent, 25 high, 35 medium, 25 low
#   Task types: 50 human, 30 agent, 20 mixed
#   ~40 with deadlines (half overdue, half future), 60 without
#
# Usage: bash scripts/seed-mock-tasks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="${SCRIPT_DIR}/../.research-claw/library.db"

if [ ! -f "$DB_PATH" ]; then
  echo "Error: Database not found at $DB_PATH"
  exit 1
fi

echo "Seeding 100 mock tasks into $DB_PATH ..."

python3 -c "
import uuid, random, json
from datetime import datetime, timedelta

random.seed(42)

titles = [
    'Literature review on {topic}',
    'Reproduce experiments from {paper}',
    'Write methodology section for {topic}',
    'Collect dataset for {topic} analysis',
    'Run ablation study on {method}',
    'Draft introduction for {topic} paper',
    'Implement {method} baseline',
    'Analyze results of {method} experiment',
    'Prepare presentation on {topic}',
    'Review related work on {topic}',
    'Design experiment protocol for {method}',
    'Submit paper to {venue}',
    'Revise manuscript based on reviewer feedback',
    'Create visualization for {topic} results',
    'Write abstract for {venue} submission',
    'Conduct statistical analysis of {topic}',
    'Compare {method} with state-of-the-art',
    'Annotate training data for {topic}',
    'Debug training pipeline for {method}',
    'Optimize hyperparameters for {method}',
]

topics = ['protein folding', 'drug discovery', 'climate modeling', 'NLP', 'computer vision',
          'reinforcement learning', 'graph neural networks', 'molecular dynamics',
          'genomics', 'materials science', 'quantum computing', 'robotics']
methods = ['transformer', 'diffusion model', 'GNN', 'VAE', 'RL agent', 'CNN', 'LSTM', 'MoE']
papers = ['Attention Is All You Need', 'BERT', 'GPT-4 Technical Report', 'AlphaFold2',
          'Scaling Laws', 'DPO', 'RLHF', 'Constitutional AI']
venues = ['NeurIPS 2026', 'ICML 2026', 'ACL 2026', 'Nature Methods', 'AAAI 2026']

statuses = ['todo']*30 + ['in_progress']*20 + ['blocked']*10 + ['done']*25 + ['cancelled']*15
priorities = ['urgent']*15 + ['high']*25 + ['medium']*35 + ['low']*25
task_types = ['human']*50 + ['agent']*30 + ['mixed']*20

random.shuffle(statuses)
random.shuffle(priorities)
random.shuffle(task_types)

now = datetime.utcnow()
sqls = []

for i in range(100):
    tid = str(uuid.uuid4())
    template = titles[i % len(titles)]
    title = template.format(
        topic=random.choice(topics),
        method=random.choice(methods),
        paper=random.choice(papers),
        venue=random.choice(venues),
    ).replace(\"'\", \"''\")

    status = statuses[i]
    priority = priorities[i]
    task_type = task_types[i]

    # Deadlines: 40% have them
    deadline = 'NULL'
    if i < 40:
        if i < 20:
            # Overdue
            d = now - timedelta(days=random.randint(1, 30))
        else:
            # Future
            d = now + timedelta(days=random.randint(1, 60))
        deadline = f\"'{d.strftime('%Y-%m-%dT%H:%M:%S.000Z')}'\"

    completed_at = 'NULL'
    if status in ('done', 'cancelled'):
        d = now - timedelta(days=random.randint(0, 14))
        completed_at = f\"'{d.strftime('%Y-%m-%dT%H:%M:%S.000Z')}'\"

    created_at = (now - timedelta(days=random.randint(1, 90))).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    updated_at = (now - timedelta(hours=random.randint(0, 48))).strftime('%Y-%m-%dT%H:%M:%S.000Z')

    desc = f'Task {i+1}: {title}'.replace(\"'\", \"''\")

    sqls.append(f\"\"\"INSERT INTO rc_tasks (id, title, description, task_type, status, priority, deadline, completed_at, created_at, updated_at, parent_task_id, related_paper_id, related_file_path, agent_session_id, tags, notes)
VALUES ('{tid}', '{title}', '{desc}', '{task_type}', '{status}', '{priority}', {deadline}, {completed_at}, '{created_at}', '{updated_at}', NULL, NULL, NULL, NULL, '[]', NULL);\"\"\")

print('BEGIN TRANSACTION;')
for s in sqls:
    print(s)
print('COMMIT;')
" | sqlite3 "$DB_PATH"

echo ""
echo "Done! Task distribution:"
sqlite3 "$DB_PATH" "SELECT status, COUNT(*) as cnt FROM rc_tasks GROUP BY status;"
echo ""
echo "Priority:"
sqlite3 "$DB_PATH" "SELECT priority, COUNT(*) as cnt FROM rc_tasks GROUP BY priority;"
echo ""
echo "Total:"
sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM rc_tasks;"
