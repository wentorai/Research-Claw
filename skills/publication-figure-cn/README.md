# publication-figure-cn

中文学术期刊配图规范 + matplotlib 模板集。

## What

本 Skill 为面向中文核心期刊（《经济研究》《管理世界》《会计研究》《心理学报》《中国工业经济》《金融研究》等）投稿提供：

- **配图规范文档**（字体 / 字号 / 颜色 / 线宽 / 图注 / 比例 / 三线表）
- **可直接复用的 matplotlib 模板**（7 类常用图）
- **LaTeX booktabs 三线表完整示例**
- **黑白可读 + 色盲友好调色板**

## Install / use

本 Skill 不需要安装。把 `publication-figure-cn/` 整个目录拷到任意位置即可被 Claude Code Skill 框架识别。

直接使用：

```bash
# 把 rc 配置丢到工作目录
cp templates/matplotlibrc ./matplotlibrc

# 跑模板
python templates/coefficient_plot.py
# 生成 coefficient_plot.pdf
```

## Files

- `SKILL.md` — Skill 入口
- `references/` — 5 个 markdown 规范文档
- `templates/` — 6 个 matplotlib 脚本 + 1 个 LaTeX 模板 + 1 个 matplotlibrc
- `tests/` — pytest 测试

## Test

```bash
python3 -m pytest tests/ -v
```

如果环境里没有 matplotlib，`test_template_runs.py` 会被自动 skip；其他结构测试仍跑。

## License

Apache-2.0. 见 `LICENSE` 与 `NOTICE`。
