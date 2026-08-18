"""
basic_cleaning.py
CSMAR (国泰安) 数据清洗标准模板 - Python 版

流程:
  1) 合成 minimal CSMAR 数据 (用于自检)
  2) 样本筛选: 剔金融 / 剔 ST / 剔 IPO 当年 / 剔 B 股
  3) 关键变量缺失值删除
  4) 极值缩尾 (winsorize_safe, 1%/99%)
  5) 输出干净面板

依赖:
  pip install pandas numpy scipy
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats.mstats import winsorize  # noqa: F401  (留作参考, 实际用 winsorize_safe)


def make_synthetic_panel(n: int = 200, seed: int = 20260501) -> pd.DataFrame:
    """生成 minimal 合成 CSMAR 面板 (含极端值 / 缺失 / B 股 / ST / 金融业)"""
    rng = np.random.default_rng(seed)
    idx = np.arange(n)

    df = pd.DataFrame(
        {
            "Stkcd": [f"{((i % 20) + 1):06d}" for i in idx],
            "year": 2010 + ((idx // 20) % 10),
            "IndCd": np.where(
                idx % 30 == 0, "J66",
                np.where(idx % 40 == 0, "K70",
                         np.where(idx % 7 == 0, "C26", "C39"))
            ),
            "Trdsta": np.where(idx % 50 == 0, 2, 1),
            "ListDt": pd.to_datetime(
                [f"{2009 + (i % 5)}-01-01" for i in idx]
            ),
            "roa": rng.normal(0.05, 0.08, n),
            "lev": rng.uniform(0.1, 0.7, n),
            "size": rng.normal(22.0, 1.5, n),
            "growth": rng.normal(0.15, 0.30, n),
        }
    )

    # 注入 B 股 (开头改为 9)
    b_share_idx = idx[idx % 20 == 0]
    df.loc[b_share_idx, "Stkcd"] = ["9" + s[1:] for s in df.loc[b_share_idx, "Stkcd"]]

    # 注入极端值 / 缺失
    df.loc[idx[idx % 100 == 0], "roa"] = 5.0
    df.loc[idx[idx % 99 == 0], "roa"] = -3.0
    df.loc[idx[idx % 60 == 0], "roa"] = np.nan

    return df


def winsorize_safe(s: pd.Series, lower: float = 0.01, upper: float = 0.01) -> pd.Series:
    """
    NaN 安全的缩尾函数.

    Parameters
    ----------
    s : pd.Series
        待缩尾的序列
    lower : float
        下侧裁剪比例 (0.01 = 1%)
    upper : float
        上侧裁剪比例 (0.01 = 1% from top, 即 99 分位)
    """
    s = s.copy()
    nonna = s.dropna()
    if nonna.empty:
        return s
    lo = nonna.quantile(lower)
    hi = nonna.quantile(1.0 - upper)
    return s.clip(lower=lo, upper=hi)


def clean_csmar_panel(df: pd.DataFrame) -> pd.DataFrame:
    """对原始 CSMAR-like 面板执行标准清洗流程"""

    # Step 1: 样本期窗口
    df = df[(df["year"] >= 2010) & (df["year"] <= 2019)].copy()

    # Step 2: 剔除金融业 (CSRC 2001 = I, CSRC 2012 = J)
    ind_top = df["IndCd"].str[0]
    df = df[~ind_top.isin(["I", "J"])].copy()

    # (可选) 剔除房地产业
    # df = df[df["IndCd"].str[0] != "K"].copy()

    # Step 3: 剔除 ST / *ST / PT
    df = df[df["Trdsta"] == 1].copy()

    # Step 4: 剔除 IPO 当年观测
    df["years_listed"] = df["year"] - df["ListDt"].dt.year
    df = df[df["years_listed"] >= 1].drop(columns=["years_listed"]).copy()

    # Step 5: 剔除 B 股 (首位 9 / 代码段 20)
    df = df[~df["Stkcd"].str.startswith("9")].copy()
    df = df[~df["Stkcd"].str.startswith("20")].copy()

    # Step 6: 关键变量缺失值删除
    key_vars = ["roa", "lev", "size", "growth"]
    df = df.dropna(subset=key_vars).copy()

    # Step 7: 极值缩尾 (全样本 1% / 99%)
    for v in key_vars:
        df[v] = winsorize_safe(df[v], lower=0.01, upper=0.01)

    return df.reset_index(drop=True)


def panel_summary(df: pd.DataFrame) -> None:
    """打印面板结构与描述性统计"""
    print("\n=== 清洗后描述性统计 ===")
    print(df[["roa", "lev", "size", "growth"]].describe().round(3))

    n_firms = df["Stkcd"].nunique()
    n_years = df["year"].nunique()
    print(
        f"\n清洗后样本量: {len(df)} 观测 / {n_firms} 公司 / {n_years} 年"
    )

    years_per_firm = df.groupby("Stkcd").size()
    print("\n=== 面板结构 (每家公司观测年数分布) ===")
    print(years_per_firm.value_counts().sort_index())


def main() -> pd.DataFrame:
    raw = make_synthetic_panel()
    print("=== 原始数据 ===")
    print(raw[["roa", "lev", "size", "growth"]].describe().round(3))
    print("\nIndCd 分布:")
    print(raw["IndCd"].value_counts(dropna=False))
    print("\nTrdsta 分布:")
    print(raw["Trdsta"].value_counts(dropna=False))

    clean = clean_csmar_panel(raw)
    panel_summary(clean)

    # 保存 (生产环境取消注释)
    # clean.to_parquet("clean_panel.parquet", index=False)
    # clean.to_stata("clean_panel.dta", write_index=False)

    print("\n=== Clean panel ready. ===")
    return clean


if __name__ == "__main__":
    main()
