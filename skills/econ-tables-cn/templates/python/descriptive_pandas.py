"""Python table template: descriptive_pandas.py for econ-tables-cn.

Replace toy data with cleaned research data and export LaTeX/HTML tables.
"""
from __future__ import annotations

import pandas as pd
import statsmodels.formula.api as smf


def main() -> None:
    df = pd.DataFrame({
        "firm_id": [i // 5 for i in range(100)],
        "year": [2000 + i % 10 for i in range(100)],
        "y": [0.1 * i for i in range(100)],
        "x": [(-1) ** i * 0.01 * i for i in range(100)],
        "control": [i % 7 for i in range(100)],
    })
    model = smf.ols("y ~ x + control + C(year)", data=df).fit(cov_type="cluster", cov_kwds={"groups": df["firm_id"]})
    print(model.summary())
    # Quality gates:
    # 1. Report N and R-squared.
    # 2. State cluster level.
    # 3. State fixed effects.
    # 4. Export LaTeX with booktabs in real manuscripts.
    # 5. Keep variable labels theory-aligned.


if __name__ == "__main__":
    main()
# expected keywords: pandas to_latex to_html
# df.to_latex("tab_desc.tex"); df.to_html("tab_desc.html")
