---
name: Plotting SOP
description: >-
  Standard operating procedure for academic figure generation.
  Four rendering engines: Python (data viz), Mermaid (flowcharts),
  AI Image via NanoBanana/OpenRouter (complex diagrams), SVG (vector).
  Includes engine selection decision tree, ReAct self-correction,
  NanoBanana configuration, environment detection, and academic style rules.
---

# Plotting SOP — 科研作图标准操作规程

<!-- SKILL MAINTENANCE NOTES:
     - This is a SYSTEM-LEVEL skill (lives in research-claw/skills/, NOT research-plugins)
     - Covers all figure generation workflows for academic research
     - NanoBanana = OpenRouter API endpoint for Gemini image generation
     - ReAct pattern: generate → execute → error? → inject error → retry (max 3)
     - References: writing-sop (embeds figures), workspace-sop (saves figures)
     - AGENTS.md §3 Quick Path points here for "画图/作图/figure"
     - Update AGENTS.md pointers when modifying this skill
-->

## When to Read This Skill

Read this skill when the user asks to:
- Draw, plot, or visualize any figure or diagram
- Create charts for a paper (bar, line, scatter, heatmap, radar, etc.)
- Draw flowcharts, architecture diagrams, or concept maps
- Generate figures during academic writing (called from writing-sop Phase 2)
- Convert data into visual representations

---

## §1 Environment Detection (run once per session)

Before generating any figure, **MUST** check available capabilities.
Run these checks silently (do not show output to user unless something fails):

```
Check 1: python3 -c "import matplotlib; print('matplotlib', matplotlib.__version__)"
Check 2: python3 -c "import seaborn; print('seaborn', seaborn.__version__)"
Check 3: which mmdc 2>/dev/null || npx --yes @mermaid-js/mermaid-cli mmdc --version 2>/dev/null
Check 4: python3 -c "import cairosvg; print('cairosvg OK')" 2>/dev/null
```

Record results in session memory. Do NOT repeat these checks for subsequent figures.

**If matplotlib is missing** (common on native macOS/WSL2 installs):
1. Tell user: "Python 科学绘图库未安装。是否允许我运行安装脚本？(约 30 秒)"
2. If user agrees: `bash scripts/setup-plotting-env.sh`
3. If setup script not found: `pip install --user matplotlib seaborn numpy pandas`
4. If user declines: skip Python Engine, use Mermaid or AI Image instead

**If mmdc is missing**: This is normal. Use `npx --yes @mermaid-js/mermaid-cli mmdc` as fallback.
If npx also fails: save `.mmd` file and tell user to paste at https://mermaid.live

---

## §2 Engine Selection Decision Tree

**MUST** follow this decision tree for every figure request. Do NOT skip steps.

```
User requests a figure
  │
  ├─ 1. Is it DATA VISUALIZATION (charts with numbers/statistics)?
  │    YES → §4 Python Engine
  │    Examples: bar chart, line plot, scatter, heatmap, violin, radar, histogram, box plot
  │
  ├─ 2. Is it a SIMPLE STRUCTURED DIAGRAM (≤15 nodes AND aesthetics not critical)?
  │    YES → §5 Mermaid Engine
  │    Examples: simple flowchart, sequence diagram, class diagram, Gantt chart
  │
  ├─ 3. Is it a COMPLEX diagram (>15 nodes OR requires visual polish)?
  │    (architecture diagram, research methodology flow, concept map,
  │     multi-layer system diagram, publication-quality illustration)
  │
  │    → Is NanoBanana/OpenRouter configured?
  │        YES → §6 AI Image Engine (NanoBanana)
  │        NO  → Recommend NanoBanana to user (see §3)
  │              → User provides API key? → §6 AI Image Engine
  │              → User declines?
  │                  → WARN: "本地引擎生成复杂流程图的质量有限，可能需要手动调整。"
  │                  → Fall back to §5 Mermaid Engine (best effort)
  │
  └─ 4. Is it a CUSTOM VECTOR graphic (geometric shapes, coordinate annotations)?
       YES → §7 SVG Engine
```

---

## §3 NanoBanana Configuration Guide

NanoBanana provides access to Gemini's native image generation through OpenRouter.
It is the **only reliable path** for complex, publication-quality academic diagrams
because it generates images directly (pixel-level), bypassing code generation entirely.

### Why recommend NanoBanana

- LLM-generated Mermaid/Python code for complex diagrams **frequently has syntax errors**
- Even when correct, code-rendered diagrams look mechanical and unprofessional
- Gemini image generation produces **visually polished, publication-ready** figures
- **Low-IQ models benefit most**: the API quality is independent of the local model's coding ability

### Configuration

User needs to provide an **OpenRouter API Key**.
Store in MEMORY.md under `## Global > ### Environment`:

```
NanoBanana: configured
OpenRouter API Key: [stored in environment, not in memory]
```

**Recommended model**: `google/gemini-2.5-flash-preview-image-generation`
**Alternative model**: `google/gemini-2.5-pro-preview-image-generation`
**API endpoint**: `https://openrouter.ai/api/v1/chat/completions`

### How to tell the user

When the user requests a complex diagram and NanoBanana is not configured:

> "这类复杂的学术图表，推荐使用 NanoBanana（基于 Gemini 图片生成）来获得最佳效果。
> 您只需提供一个 OpenRouter API Key（https://openrouter.ai/settings/keys）。
> 如果您不想配置，我也可以使用本地工具（Mermaid/Python）尝试生成，但质量可能有限。"

---

## §4 Python Engine — Data Visualization

For charts based on numerical data: bar, line, scatter, heatmap, violin, radar, box, histogram, pie, area, etc.

### Output Path Resolution (MUST set before generating code)

Set `output_path` per §9 naming convention:
```
output_path = "outputs/figures/{topic}-fig{N}.png"
```
Example: `outputs/figures/model-comparison-fig1.png`

### Code Template (MUST follow this structure)

The generated Python code **MUST** include all of the following elements.
Low-IQ models: copy this template exactly, then fill in the plotting section.

```python
import matplotlib
matplotlib.use('Agg')  # Non-interactive backend — MUST be before pyplot import
import matplotlib.pyplot as plt
import numpy as np

# ── Academic style settings ──────────────────────────────────
plt.rcParams.update({
    'font.family': 'sans-serif',
    'font.size': 12,
    'figure.dpi': 300,
    'axes.linewidth': 1.2,
    'axes.grid': True,
    'grid.alpha': 0.3,
    'legend.framealpha': 0.9,
})

fig, ax = plt.subplots(figsize=(10, 6))

# ── [YOUR PLOTTING CODE HERE] ───────────────────────────────
# Generate reasonable example data if user did not provide actual data.
# If using example data, add text annotation: "Example Data" in bottom-right.

# ── Labels and title (ALL ENGLISH) ──────────────────────────
ax.set_xlabel('X Label', fontsize=13)
ax.set_ylabel('Y Label', fontsize=13)
ax.set_title('Chart Title', fontsize=14, fontweight='bold')

# ── Save ─────────────────────────────────────────────────────
plt.tight_layout()
plt.savefig('{output_path}', format='png', dpi=300, bbox_inches='tight')
plt.close()
print('OK')
```

### Execution Protocol

1. **Generate code** following the template above
2. Save code to temp file: `system.run` with inline Python or write to `/tmp/rc_plot_{hash}.py`
3. **Execute**: `python3 /tmp/rc_plot_{hash}.py`
4. **Check result**:
   - Exit code 0 AND "OK" in stdout AND output file exists → **SUCCESS**
   - Otherwise → **FAILURE** → enter ReAct loop

### ReAct Self-Correction (max 3 attempts)

If execution fails:

**Attempt 2-3**: Inject the previous code and error into your next generation:

```
## Previous attempt FAILED. Fix the code.

### Previous code:
[paste the code that failed]

### Error output:
[paste stderr, truncated to 500 chars]

### Fix instructions:
- Analyze the error carefully
- Fix syntax errors, indentation, missing imports
- Ensure matplotlib.use('Agg') is BEFORE pyplot import
- Ensure savefig path is correct: {output_path}
- Do NOT use libraries that are not installed (stick to matplotlib, numpy, pandas, seaborn)
```

If all 3 attempts fail → inform user: "Python 作图失败。请检查数据格式或简化图表要求。"

### Color Palettes (academic standard)

| Use case | Palette | Code |
|----------|---------|------|
| Categorical (≤10) | tab10 | `plt.cm.tab10` |
| Categorical (≤8) | Set2 | `plt.cm.Set2` |
| Sequential | viridis | `cmap='viridis'` |
| Diverging | RdYlBu | `cmap='RdYlBu'` |
| Colorblind-safe | Paired | `plt.cm.Paired` |

**NEVER** use red-green only contrast. Always use colorblind-safe palettes.

### Chart Type Quick Reference

| User says | Chart type | Key code |
|-----------|-----------|----------|
| 柱状图/bar chart | Grouped bar | `ax.bar(x, y)` |
| 折线图/line chart | Line plot | `ax.plot(x, y)` |
| 散点图/scatter | Scatter | `ax.scatter(x, y)` |
| 热力图/heatmap | Heatmap | `import seaborn as sns; sns.heatmap(data)` |
| 箱线图/box plot | Box | `ax.boxplot(data)` or `sns.boxplot()` |
| 小提琴图/violin | Violin | `sns.violinplot()` |
| 雷达图/radar | Radar | Custom with `ax = fig.add_subplot(111, polar=True)` |
| 饼图/pie | Pie | `ax.pie(sizes, labels=labels)` |
| 直方图/histogram | Histogram | `ax.hist(data, bins=30)` |
| 面积图/area | Stacked area | `ax.stackplot(x, y1, y2)` |

---

## §5 Mermaid Engine — Structured Diagrams

For flowcharts, sequence diagrams, class diagrams, state machines, Gantt charts.

### Supported Diagram Types

| Type | Keyword | Best for |
|------|---------|----------|
| Flowchart (vertical) | `flowchart TD` | Process flows, decision trees |
| Flowchart (horizontal) | `flowchart LR` | Pipelines, architectures |
| Sequence diagram | `sequenceDiagram` | API calls, message passing |
| Class diagram | `classDiagram` | OOP design, data models |
| State diagram | `stateDiagram-v2` | State machines, lifecycle |
| Gantt chart | `gantt` | Project timelines |

### Syntax Rules (critical for low-IQ models)

1. Node IDs: use simple letters — `A`, `B`, `C` (NOT Chinese, NOT spaces)
2. Labels: wrap in `[]` — `A[Start Process]`
3. Arrows: `-->` or `-->|label|`
4. **NEVER** use these characters inside labels: `&`, `<`, `>`
5. For decision nodes (diamond shape): use single braces — `C{Is valid?}`
6. Keep diagrams **≤15 nodes AND aesthetics not critical**. For larger or visually polished diagrams → recommend NanoBanana (§6).

### Rendering Protocol

1. **Generate** Mermaid code
2. Save to temp file: `/tmp/rc_mermaid_{hash}.mmd`
3. **Render** (try in order):
   - `mmdc -i /tmp/rc_mermaid_{hash}.mmd -o {output_path} -w 1920 -H 1080 --backgroundColor white`
   - `npx --yes @mermaid-js/mermaid-cli -i /tmp/rc_mermaid_{hash}.mmd -o {output_path}`
   - Both fail → save `.mmd` file to workspace + tell user: "Mermaid 渲染工具未安装。已保存源文件，请粘贴到 https://mermaid.live 查看。"
4. **Check result**: file exists + size > 1KB → SUCCESS

### ReAct for Mermaid

If mmdc returns an error:
- Parse the error message (usually "Parse error on line N")
- Fix the syntax issue (often: special characters in labels, missing brackets)
- Retry (max 3 attempts)

---

## §6 AI Image Engine — NanoBanana (Complex Diagrams)

For complex academic diagrams that require visual polish: architecture diagrams,
research methodology flows, concept maps, multi-layer system diagrams.

### When to Use

- Diagram has >15 nodes or complex spatial layout
- User wants "美观/professional/publication-ready" quality
- User explicitly requests AI-generated figure
- Low-IQ model is active (AI Image quality is model-independent)

### API Call Protocol

**Step 0 — Confirm with user** before calling the API (costs money):
> "即将调用 NanoBanana (Gemini) 生成图片，预计消耗约 $0.01 API 额度。是否继续？"
Wait for user confirmation. If user declines → fall back to §5 Mermaid.

**Step 1 — Generate and execute** a Python script via `system.run`:

```python
import requests, base64, sys, os

API_KEY = os.environ.get('OPENROUTER_API_KEY', '')
if not API_KEY:
    print('ERROR: OPENROUTER_API_KEY not set', file=sys.stderr)
    sys.exit(1)

resp = requests.post(
    'https://openrouter.ai/api/v1/chat/completions',
    headers={
        'Authorization': f'Bearer {API_KEY}',
        'Content-Type': 'application/json',
    },
    json={
        'model': 'google/gemini-2.5-flash-preview-image-generation',
        'messages': [{
            'role': 'user',
            'content': 'Generate a professional academic diagram: {description}.\n\n'
                       'Style: clean, minimal, publication-ready, white background, '
                       'no watermark, clear English labels, professional color scheme '
                       '(blues, grays, muted tones), high resolution for academic paper.'
        }],
    },
    timeout=120,
)
resp.raise_for_status()
data = resp.json()

# Extract image from multimodal response
content = data['choices'][0]['message']['content']
b64_data = None
if isinstance(content, list):
    for part in content:
        if part.get('type') == 'image_url':
            url = part['image_url']['url']
            b64_data = url.split(',', 1)[1]
            break
        elif part.get('type') == 'image' and 'data' in part:
            b64_data = part['data']
            break
elif isinstance(content, str) and 'data:image' in content:
    b64_data = content.split(',', 1)[1]

if not b64_data:
    print('ERROR: No image found in API response', file=sys.stderr)
    sys.exit(1)

with open('{output_path}', 'wb') as f:
    f.write(base64.b64decode(b64_data))
print('OK')
```

**Step 2 — Check**: file exists + size > 1KB → SUCCESS.

**If API call fails** (timeout, auth error, quota exceeded):
- Log the error
- **WARN user**: "NanoBanana API 调用失败。降级到 Mermaid 引擎。"
- Fall back to §5 Mermaid Engine

---

## §7 SVG Engine — Custom Vector Graphics

For geometric shapes, coordinate-annotated diagrams, simple custom illustrations.

### Generation Method

Generate Python code using `svgwrite`:

```python
import svgwrite

dwg = svgwrite.Drawing('{output_path}', size=('800px', '600px'))
dwg.add(dwg.rect(insert=(0, 0), size=('100%', '100%'), fill='white'))

# [YOUR SVG ELEMENTS HERE]

dwg.save()
print('OK')
```

If `svgwrite` is not available, generate raw SVG XML and save directly.

**PNG conversion** (optional):
- Try: `python3 -c "import cairosvg; cairosvg.svg2png(url='{svg_path}', write_to='{png_path}', dpi=300)"`
- If cairosvg unavailable: keep `.svg` file, inform user

---

## §8 Quality Checklist (run after EVERY figure)

After generating a figure, **MUST** verify:

| # | Check | How to verify | If FAIL |
|---|-------|---------------|---------|
| 1 | File exists | `ls -la {output_path}` | Re-run generation |
| 2 | File size > 1KB | Same command | File is corrupt → regenerate |
| 3 | Labels in English | Review generated code | Fix labels → re-run |
| 4 | DPI ≥ 300 (Python) | Check savefig params in code | Fix → re-run |
| 5 | No overlapping text | Visual inspection if possible | Add `tight_layout()` or adjust |

If checks fail → fix and re-run (counts as one ReAct iteration).

---

## §9 Academic Figure Standards

### File Naming

Save all figures to: `outputs/figures/{topic}-fig{N}.{ext}`

Examples:
- `outputs/figures/transformer-fig1.png`
- `outputs/figures/model-comparison-fig2.png`
- `outputs/figures/methodology-flow-fig3.png`

### Caption Rule

Every figure **MUST** have an English caption. Present to user as:

> **Figure {N}.** {Caption text describing what the figure shows.}

### Citation Format

When embedding in text: "as shown in Figure {N}" or "see Figure {N}".

### Style Rules

- **Font**: sans-serif (Arial, Helvetica), ≥ 10pt for all text
- **DPI**: 300 minimum (publication standard)
- **Background**: white (no transparency)
- **Colors**: colorblind-safe palettes (viridis, Set2, tab10, Paired)
- **Borders**: thin axis lines (1-1.5pt), no box frames around plots
- **Grid**: light gray (alpha 0.3), optional but recommended for data plots
- **Legend**: positioned to avoid overlapping data; semi-transparent background

---

## §10 Integration with Writing SOP

When called from **writing-sop Phase 2** (first draft generation):

1. Writing-sop identifies a section needs a figure
2. It invokes this skill (plotting-sop) with the figure description
3. This skill generates the figure → `workspace_save` to `outputs/figures/`
4. Return to writing-sop with: figure path + caption
5. Writing-sop embeds the figure reference in the draft

**Pattern for inline invocation:**
```
[Writing-sop Phase 2, writing Methods section]
→ "This section needs a methodology flowchart"
→ [Load plotting-sop] → Engine selection → Generate → Save
→ [Return to writing-sop] → "See Figure 1" inserted in text
```

---

## RC Local Tools Reference

| Task | Tool | Example |
|:-----|:-----|:--------|
| Run Python plot | `system.run` | `python3 /tmp/rc_plot_abc.py` |
| Run Mermaid compile | `system.run` | `npx --yes @mermaid-js/mermaid-cli -i input.mmd -o output.png` |
| Call NanoBanana API | `system.run` | Python requests POST to OpenRouter endpoint |
| Save figure | `workspace_save` | `outputs/figures/{name}.png` |
| Check file | `system.run` | `ls -la outputs/figures/{name}.png` |
| Install deps (if needed) | `system.run` | `pip install matplotlib seaborn` |
