"""MockProvider: deterministic in-memory provider used for tests and demos.

The dataset spans economics / finance / management / education / medicine.
"""

from __future__ import annotations

from typing import Any

from ..exceptions import PaperNotFoundError
from ..models import AuthorInfo, Paper, SearchResult
from .base import BaseProvider


def _build_dataset() -> list[Paper]:
    """Return the synthetic dataset.

    All paper ids are prefixed with ``mock:`` so they round-trip through
    :meth:`get_paper`.
    """
    raw: list[dict[str, Any]] = [
        {
            "paper_id": "mock:0001",
            "title": "数字经济对全要素生产率的影响：理论与中国证据",
            "title_en": "Digital Economy and Total Factor Productivity: Evidence from China",
            "authors": [("张伟", "Zhang Wei", "清华大学经济管理学院")],
            "abstract": "本文基于2010-2022年中国省级面板数据，考察数字经济发展对全要素生产率的影响。",
            "keywords": ["数字经济", "全要素生产率", "面板数据"],
            "journal": "经济研究",
            "year": 2023,
            "doi": "10.1000/mock.0001",
            "discipline": "经济学",
            "citations": 128,
        },
        {
            "paper_id": "mock:0002",
            "title": "机器学习在资产定价中的应用：基于中国股市的实证",
            "title_en": "Machine Learning in Asset Pricing: Evidence from Chinese Stock Market",
            "authors": [("李娜", "Li Na", "北京大学光华管理学院"), ("王强", "Wang Qiang", "复旦大学经济学院")],
            "abstract": "本文运用随机森林、神经网络等机器学习方法对中国股市横截面收益进行预测。",
            "keywords": ["机器学习", "资产定价", "横截面收益"],
            "journal": "金融研究",
            "year": 2022,
            "doi": "10.1000/mock.0002",
            "discipline": "金融学",
            "citations": 87,
        },
        {
            "paper_id": "mock:0003",
            "title": "ESG表现与企业价值：来自A股上市公司的证据",
            "title_en": "ESG Performance and Firm Value: Evidence from Chinese A-Share Listed Firms",
            "authors": [("陈芳", "Chen Fang", "中国人民大学财政金融学院")],
            "abstract": "采用2015-2021年A股上市公司样本，本文检验ESG评级对企业价值的影响。",
            "keywords": ["ESG", "企业价值", "可持续金融"],
            "journal": "管理世界",
            "year": 2023,
            "doi": "10.1000/mock.0003",
            "discipline": "金融学",
            "citations": 64,
        },
        {
            "paper_id": "mock:0004",
            "title": "高管激励与企业创新：基于股权激励的实证研究",
            "title_en": "Executive Incentives and Corporate Innovation: Evidence from Equity Incentives",
            "authors": [("刘洋", "Liu Yang", "上海交通大学安泰经济与管理学院")],
            "abstract": "本研究检验股权激励计划对企业研发投入和专利产出的影响。",
            "keywords": ["股权激励", "企业创新", "研发投入"],
            "journal": "管理世界",
            "year": 2021,
            "doi": "10.1000/mock.0004",
            "discipline": "管理学",
            "citations": 152,
        },
        {
            "paper_id": "mock:0005",
            "title": "在线教育对学习效果的因果影响：基于双重差分的研究",
            "title_en": "Causal Effects of Online Education on Learning Outcomes: A DiD Study",
            "authors": [("赵敏", "Zhao Min", "北京师范大学教育学部")],
            "abstract": "利用COVID-19期间自然实验，采用双重差分方法识别在线教育的因果效应。",
            "keywords": ["在线教育", "双重差分", "学习效果"],
            "journal": "教育研究",
            "year": 2022,
            "doi": "10.1000/mock.0005",
            "discipline": "教育学",
            "citations": 41,
        },
        {
            "paper_id": "mock:0006",
            "title": "新冠疫情对城乡居民健康的影响及政策响应",
            "title_en": "Impact of COVID-19 on Urban-Rural Health and Policy Response",
            "authors": [("孙磊", "Sun Lei", "中山大学公共卫生学院")],
            "abstract": "基于2019-2022年健康调查数据，本文分析疫情对不同地区居民健康的差异化影响。",
            "keywords": ["新冠疫情", "公共卫生", "城乡差异"],
            "journal": "中华流行病学杂志",
            "year": 2023,
            "doi": "10.1000/mock.0006",
            "discipline": "医学",
            "citations": 95,
        },
        {
            "paper_id": "mock:0007",
            "title": "绿色金融政策对污染企业转型的影响",
            "title_en": "Green Finance Policy and Pollution Firm Transformation",
            "authors": [("周杰", "Zhou Jie", "厦门大学经济学院")],
            "abstract": "以绿色信贷指引为政策冲击，识别绿色金融对重污染企业的转型激励。",
            "keywords": ["绿色金融", "环境政策", "企业转型"],
            "journal": "经济研究",
            "year": 2021,
            "doi": "10.1000/mock.0007",
            "discipline": "经济学",
            "citations": 73,
        },
        {
            "paper_id": "mock:0008",
            "title": "供应链金融与中小企业融资约束缓解",
            "title_en": "Supply Chain Finance and SME Financial Constraints",
            "authors": [("吴静", "Wu Jing", "西南财经大学金融学院")],
            "abstract": "实证检验供应链金融工具在缓解中小企业融资约束中的作用机制。",
            "keywords": ["供应链金融", "融资约束", "中小企业"],
            "journal": "金融研究",
            "year": 2020,
            "doi": "10.1000/mock.0008",
            "discipline": "金融学",
            "citations": 56,
        },
        {
            "paper_id": "mock:0009",
            "title": "平台经济中的双边市场定价机制",
            "title_en": "Two-Sided Market Pricing in Platform Economy",
            "authors": [("郑浩", "Zheng Hao", "南京大学商学院")],
            "abstract": "构建双边市场理论模型分析互联网平台的定价策略。",
            "keywords": ["平台经济", "双边市场", "定价机制"],
            "journal": "管理科学学报",
            "year": 2022,
            "doi": "10.1000/mock.0009",
            "discipline": "管理学",
            "citations": 38,
        },
        {
            "paper_id": "mock:0010",
            "title": "乡村振兴战略下农村教育资源配置优化",
            "title_en": "Optimizing Rural Education Resource Allocation under Rural Revitalization",
            "authors": [("黄蓉", "Huang Rong", "华东师范大学教育学部")],
            "abstract": "考察乡村振兴战略实施以来农村基础教育资源配置的变化与效果。",
            "keywords": ["乡村振兴", "农村教育", "资源配置"],
            "journal": "教育研究",
            "year": 2023,
            "doi": "10.1000/mock.0010",
            "discipline": "教育学",
            "citations": 22,
        },
        {
            "paper_id": "mock:0011",
            "title": "央行数字货币（DCEP）对货币政策传导的影响",
            "title_en": "Central Bank Digital Currency (DCEP) and Monetary Policy Transmission",
            "authors": [("许蕾", "Xu Lei", "中国人民大学财政金融学院")],
            "abstract": "构建DSGE模型分析数字人民币推广对货币政策传导效率的影响。",
            "keywords": ["央行数字货币", "DCEP", "货币政策"],
            "journal": "金融研究",
            "year": 2024,
            "doi": "10.1000/mock.0011",
            "discipline": "金融学",
            "citations": 12,
        },
        {
            "paper_id": "mock:0012",
            "title": "人工智能技术应用与劳动力市场极化",
            "title_en": "AI Adoption and Labor Market Polarization",
            "authors": [("林峰", "Lin Feng", "浙江大学经济学院")],
            "abstract": "基于企业-雇员匹配数据考察AI应用对不同技能劳动者就业的差异化影响。",
            "keywords": ["人工智能", "劳动力市场", "技能极化"],
            "journal": "经济研究",
            "year": 2024,
            "doi": "10.1000/mock.0012",
            "discipline": "经济学",
            "citations": 19,
        },
        {
            "paper_id": "mock:0013",
            "title": "脑卒中患者康复期心理干预的随机对照试验",
            "title_en": "RCT of Psychological Intervention in Stroke Rehabilitation",
            "authors": [("钱明", "Qian Ming", "复旦大学附属华山医院")],
            "abstract": "通过随机对照试验评估认知行为疗法对脑卒中康复期患者抑郁症状的影响。",
            "keywords": ["脑卒中", "心理干预", "随机对照"],
            "journal": "中华神经科杂志",
            "year": 2022,
            "doi": "10.1000/mock.0013",
            "discipline": "医学",
            "citations": 31,
        },
        {
            "paper_id": "mock:0014",
            "title": "碳排放权交易市场对企业减排行为的影响",
            "title_en": "Carbon Emission Trading and Corporate Emission Reduction",
            "authors": [("方圆", "Fang Yuan", "武汉大学经济与管理学院")],
            "abstract": "利用全国七省市试点准自然实验，识别碳交易政策的减排效应。",
            "keywords": ["碳排放权交易", "环境规制", "准自然实验"],
            "journal": "管理世界",
            "year": 2022,
            "doi": "10.1000/mock.0014",
            "discipline": "经济学",
            "citations": 67,
        },
        {
            "paper_id": "mock:0015",
            "title": "数字普惠金融与农村家庭消费升级",
            "title_en": "Digital Inclusive Finance and Rural Household Consumption",
            "authors": [("罗丹", "Luo Dan", "中央财经大学金融学院")],
            "abstract": "基于CFPS微观数据考察数字普惠金融对农村家庭消费结构升级的影响。",
            "keywords": ["数字普惠金融", "农村家庭", "消费升级"],
            "journal": "金融研究",
            "year": 2023,
            "doi": "10.1000/mock.0015",
            "discipline": "金融学",
            "citations": 44,
        },
        {
            "paper_id": "mock:0016",
            "title": "高校教师科研评价体系改革的国际比较",
            "title_en": "International Comparison of Faculty Research Evaluation Reforms",
            "authors": [("徐慧", "Xu Hui", "华东师范大学高等教育研究所")],
            "abstract": "比较中美英三国高校科研评价体系改革趋势及对国内的启示。",
            "keywords": ["高等教育", "科研评价", "国际比较"],
            "journal": "高等教育研究",
            "year": 2021,
            "doi": "10.1000/mock.0016",
            "discipline": "教育学",
            "citations": 17,
        },
    ]

    papers: list[Paper] = []
    for entry in raw:
        authors = [
            AuthorInfo(name=a[0], name_en=a[1], affiliation=a[2])
            for a in entry["authors"]
        ]
        papers.append(
            Paper(
                paper_id=entry["paper_id"],
                provider="mock",
                title=entry["title"],
                title_en=entry["title_en"],
                authors=authors,
                abstract=entry["abstract"],
                keywords=entry["keywords"],
                journal=entry["journal"],
                year=entry["year"],
                doi=entry["doi"],
                url=f"https://example.org/mock/paper/{entry['paper_id'].split(':')[1]}",
                citations=entry["citations"],
                discipline=entry["discipline"],
            )
        )
    return papers


_DATASET: list[Paper] = _build_dataset()


def _matches(paper: Paper, query: str, filters: dict[str, Any]) -> bool:
    """Return True if ``paper`` matches the query and filters."""
    if query:
        q = query.lower()
        haystack_parts: list[str] = [paper.title or "", paper.title_en or "", paper.abstract or ""]
        haystack_parts.extend(paper.keywords)
        haystack_parts.extend(a.name for a in paper.authors)
        haystack_parts.extend(a.name_en or "" for a in paper.authors)
        if not any(q in part.lower() for part in haystack_parts if part):
            return False

    year_from = filters.get("year_from")
    year_to = filters.get("year_to")
    if year_from is not None and (paper.year is None or paper.year < year_from):
        return False
    if year_to is not None and (paper.year is None or paper.year > year_to):
        return False

    year = filters.get("year")
    if year is not None and paper.year != year:
        return False

    author = filters.get("author")
    if author:
        a_low = author.lower()
        if not any(a_low in (a.name or "").lower() or a_low in (a.name_en or "").lower() for a in paper.authors):
            return False

    journal = filters.get("journal")
    if journal and journal.lower() not in (paper.journal or "").lower():
        return False

    keyword = filters.get("keyword")
    if keyword:
        k_low = keyword.lower()
        if not any(k_low in kw.lower() for kw in paper.keywords):
            return False

    return True


class MockProvider(BaseProvider):
    """In-memory provider with synthetic Chinese academic papers."""

    name = "mock"
    priority = 1000  # very low priority — only used when nothing else works
    description = "Deterministic synthetic dataset spanning 经济/金融/管理/教育/医学."

    def __init__(self, dataset: list[Paper] | None = None) -> None:
        self._papers: list[Paper] = list(dataset) if dataset is not None else list(_DATASET)

    async def search(
        self,
        query: str,
        limit: int = 20,
        **filters: Any,
    ) -> SearchResult:
        results = [p for p in self._papers if _matches(p, query, filters)]
        results = results[: max(0, int(limit))]
        return SearchResult(
            query=query,
            total=len(results),
            papers=results,
            provider=self.name,
            tried_providers=[self.name],
        )

    async def get_paper(self, paper_id: str) -> Paper:
        for p in self._papers:
            if p.paper_id == paper_id:
                return p
        raise PaperNotFoundError(f"Paper not found in MockProvider: {paper_id}")

    async def is_available(self) -> bool:
        return True
