# Arena Leaderboard

Arena leaderboard system for multi-game evaluation with persistent storage, incremental updates, and fair model assignment.

## Features

- **Fair Model Assignment**: Weighted random assignment ensures balanced game distribution across models
- **Elo Rating System**: Tracks model performance using pairwise Elo ratings
- **Persistent Storage**: Thread-safe JSON database for leaderboard data
- **Incremental Updates**: Add new models or continue running games without losing existing scores
- **Role-based Statistics**: Track win rates for each model in different roles (game-specific)
- **Game Count Balance**: Monitors and reports fairness of game distribution across models
- **Multi-Game Support**: Supports Avalon and Diplomacy (with lazy loading for extensibility)
- **Real-time Updates**: Leaderboard updates after each game completion

## Files

- `arena_workflow.py`: Arena workflow that assigns models to roles with fairness consideration
- `run_arena.py`: Main entry point for running arena evaluation
- `leaderboard.py`: Leaderboard calculation and display utilities
- `leaderboard_db.py`: Thread-safe persistent storage for leaderboard data
- `test_arena.py`: Test script for leaderboard database functionality

## Usage

### Supported Games

Currently supported games:
- **avalon**: The Resistance: Avalon
- **diplomacy**: Diplomacy (lazy-loaded)

### First Run (Create New Leaderboard)

**Avalon:**
```bash
python games/evaluation/leaderboard/run_arena.py \
    --game avalon \
    --config games/games/avalon/configs/arena_config.yaml \
    --num-games 200 \
    --max-workers 10
```

**Diplomacy:**
```bash
python games/evaluation/leaderboard/run_arena.py \
    --game diplomacy \
    --config games/games/diplomacy/configs/arena_config.yaml \
    --num-games 100 \
    --max-workers 10
```

### Add New Models and Continue

1. Edit the config file to add new models:
```yaml
arena:
  models:
    - qwen-plus
    - qwen-max
    - qwen2.5-14b
    - qwen2.5-32b
    - new-model-name  # New model
```

2. Run with `--continue-leaderboard` flag:
```bash
python games/evaluation/leaderboard/run_arena.py \
    --game avalon \
    --config games/games/avalon/configs/arena_config.yaml \
    --num-games 100 \
    --continue-leaderboard
```

### Continue Running More Games

```bash
python games/evaluation/leaderboard/run_arena.py \
    --game avalon \
    --config games/games/avalon/configs/arena_config.yaml \
    --num-games 50 \
    --continue-leaderboard
```

### Rate Limiting to Prevent API Overload

If you're running many concurrent games and experiencing API rate limit errors, you can add a delay between API calls:

```bash
python games/evaluation/leaderboard/run_arena.py \
    --game avalon \
    --config games/games/avalon/configs/arena_config.yaml \
    --num-games 200 \
    --max-workers 10 \
    --api-call-interval 0.5  # Wait 0.5 seconds between each API call
```

**API Rate Limits:**
- **qwen-max**: RPM = 1200 (20 requests/second)
  - With 5 workers: recommended `0.3-0.4` seconds
  - With 10 workers: recommended `0.5-0.6` seconds
  - With 20 workers: recommended `1.0-1.2` seconds

**Calculation formula:**
- Minimum interval = `max_workers / (RPM / 60)` with safety margin
- For qwen-max (RPM=1200): `interval = max_workers / 20 * 1.2` (20% safety margin)

This will slow down the evaluation but prevent the API from being overwhelmed. Recommended values:
- `0.3-0.4` seconds for moderate concurrency (5 workers)
- `0.5-0.6` seconds for high concurrency (10 workers)
- `1.0-1.2` seconds for very high concurrency (20 workers)
- `0.0` (default) for no rate limiting (fastest but may hit API limits)

### Command-Line Arguments

- `--game` / `-g` (required): Game to evaluate (`avalon` or `diplomacy`)
- `--config` / `-c` (required): Path to arena config YAML file
- `--num-games` / `-n` (default: 200): Number of games to run
- `--max-workers` / `-w` (default: 10): Maximum number of parallel workers
- `--experiment-name`: Optional experiment name for organizing logs
- `--continue-leaderboard`: Continue updating existing leaderboard (preserves Elo scores)
- `--leaderboard-db`: Path to leaderboard database file (default: `games/evaluation/leaderboard/leaderboard.json`)
- `--api-call-interval`: Minimum seconds between API calls to prevent rate limiting (default: 0.0, no limit). For qwen-max (RPM=1200): recommended 0.5-0.6 seconds with 10 workers.

## Configuration

Create a config file (e.g., `arena_config.yaml`):

```yaml
defaults:
  - default_config
  - _self_

arena:
  models:
    - qwen-plus
    - qwen-max
    - qwen2.5-14b
    - qwen2.5-32b
  seed: 42
  elo_initial: 1500
  elo_k: 32

game:
  name: avalon
  num_players: 5
  language: en
  log_dir: games/logs/arena

default_model:
  url:  # Will be read from OPENAI_BASE_URL
  temperature: 0.7
  max_tokens: 2048
  stream: false
```

## Leaderboard Data

Leaderboard data is stored in `games/evaluation/leaderboard/leaderboard.json` by default. The file contains:

- Model Elo ratings (initial and current)
- Total games and wins per model
- Role-specific statistics (wins and games per role)
- Game history with timestamps
- Elo configuration (initial rating and K-factor)
- Balance statistics (min, max, mean, std, balance_ratio)

The database is thread-safe and updates incrementally after each game completion.

## Output

The leaderboard displays:
- Model rankings by Elo (sorted descending)
- Overall win rate percentage
- Total games played per model
- Win rate by role (game-specific roles, e.g., Merlin, Servant, Assassin, Minion for Avalon)
- Average win rate across roles
- Column and row averages
- Game count balance statistics (with warnings if unbalanced)
- Models with insufficient games are marked with `*` (if < 80% of max)

### Fair Model Assignment

The system uses weighted random selection to ensure fair distribution:
- Models with fewer games get higher selection probability
- This helps balance game counts across all models
- Balance ratio is displayed and monitored (ratio < 0.8 triggers warnings)

### Elo Rating System

- Initial Elo: 1500 (configurable via `elo_initial`)
- K-factor: 32 (configurable via `elo_k`)
- Pairwise comparison: Elo updates between all model pairs in each game
- Score normalization: Handles both binary (0/1) and continuous scores

