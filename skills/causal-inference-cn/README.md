# causal-inference-cn

A Claude Code Skill for Chinese-context causal inference research. Part of **Research-Claw (科研龙虾)**.

## What's inside

5 core causal identification methods with Stata / R / Python templates, plus China-specific data and policy notes:

- **DiD** — 双重差分（含交错处理 staggered DiD）
- **RDD** — 断点回归（sharp / fuzzy / kink）
- **IV** — 工具变量
- **SC** — 合成控制法
- **PSM** — 倾向得分匹配

## Usage

Place this folder under your Claude Code skills directory, e.g.:

```
~/.claude/skills/causal-inference-cn/
```

Then trigger with phrases like:
- "我要做政策评估，用 DID"
- "帮我写一个 RDD 的 Stata 模板"
- "用 Python 跑合成控制"

## Tests

```bash
cd causal-inference-cn
python -m pytest tests/ -v
```

## License

Apache 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
