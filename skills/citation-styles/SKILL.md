---
name: Citation Styles
description: >-
  Concrete citation format templates for 6 major academic styles:
  APA 7th, IEEE, Harvard, MLA 9th, Chicago 17th, and GB/T 7714-2015.
  Provides copy-paste-ready patterns with field placeholders for
  journal articles, books, conference papers, and more.
---

# Citation Styles Reference

<!-- SKILL MAINTENANCE NOTES:
     - 此 skill 提供 6 种引用格式的具体模板，是 Writing SOP 中引用格式概览的详细补充
     - Writing SOP 的 Citation Formatting Guide 段落应指向此 skill
     - GB/T 7714-2015 是中国用户的核心需求，必须完整覆盖
     - 格式模板使用 {字段名} 占位符，便于模型直接套用
     - 更新时注意各标准的版本号（APA 7th, MLA 9th, Chicago 17th）
-->

## When to Read This Skill

Read this skill when the user asks to:
- Format citations in a specific style (APA, IEEE, Harvard, MLA, Chicago, GB/T)
- Generate a reference list or bibliography
- Convert citations between styles
- Check citation format correctness
- Format Chinese-language (中文) references

**Default**: If the user says "just pick one," use APA 7th (most widely accepted).

---

## 1. APA 7th Edition (American Psychological Association)

### In-text Citation

| Pattern | Example |
|:--------|:--------|
| Parenthetical | (Smith, 2024) |
| Narrative | Smith (2024) |
| Two authors | (Smith & Jones, 2024) / Smith and Jones (2024) |
| 3+ authors | (Smith et al., 2024) / Smith et al. (2024) |
| Multiple works | (Chen, 2023; Smith, 2024) |
| Direct quote | (Smith, 2024, p. 15) |
| Organization | (World Health Organization [WHO], 2024) — first use; (WHO, 2024) — subsequent |

### Reference List Templates

**Journal Article**
```
{LastName}, {Initials}., {LastName2}, {Initials2}., & {LastNameN}, {InitialsN}. ({Year}). {Article title: Only first word and proper nouns capitalized}. {Journal Name in Italic}, {Volume}({Issue}), {StartPage}-{EndPage}. https://doi.org/{DOI}
```
> Zhang, L., Wang, R., & Chen, H. (2024). Deep learning approaches for protein structure prediction. *Nature Methods*, *21*(3), 245-260. https://doi.org/10.1038/s41592-024-01234-5

**Book**
```
{LastName}, {Initials}. ({Year}). {Book title: Sentence case in italic} ({Edition} ed.). {Publisher}. https://doi.org/{DOI}
```
> Creswell, J. W. (2023). *Research design: Qualitative, quantitative, and mixed methods approaches* (6th ed.). SAGE Publications.

**Book Chapter**
```
{ChapterAuthor}, {Initials}. ({Year}). {Chapter title}. In {EditorInitials} {EditorLastName} (Ed.), {Book title in italic} (pp. {StartPage}-{EndPage}). {Publisher}. https://doi.org/{DOI}
```
> Liu, M. (2024). Neural network architectures. In R. Chen & S. Wang (Eds.), *Advances in artificial intelligence* (pp. 45-78). Springer. https://doi.org/10.1007/978-3-030-12345-6_3

**Conference Paper**
```
{LastName}, {Initials}. ({Year}). {Paper title}. In {Proceedings title in italic} (pp. {Pages}). {Publisher}. https://doi.org/{DOI}
```
> Kim, J., & Park, S. (2024). Transformer models for scientific text mining. In *Proceedings of the 62nd Annual Meeting of the ACL* (pp. 1234-1245). Association for Computational Linguistics. https://doi.org/10.18653/v1/2024.acl-long.123

**Preprint**
```
{LastName}, {Initials}. ({Year}). {Title}. {Archive Name}. https://doi.org/{DOI}
```
> Li, X., & Zhou, Y. (2024). Self-supervised learning for molecular property prediction. *arXiv*. https://doi.org/10.48550/arXiv.2024.01234

**Website**
```
{Author or Organization}. ({Year, Month Day}). {Page title in italic}. {Site Name}. {URL}
```
> National Institutes of Health. (2024, March 15). *Climate change and human health research*. https://www.nih.gov/climate-health

**Dataset**
```
{LastName}, {Initials}. ({Year}). {Dataset title} (Version {X}) [Data set]. {Repository}. https://doi.org/{DOI}
```
> Johnson, A. E. W. (2023). *MIMIC-IV clinical database* (Version 2.2) [Data set]. PhysioNet. https://doi.org/10.13026/6mm1-ek67

### Key Rules
- Hanging indent (0.5 in / 1.27 cm) for each entry
- DOI formatted as a URL: `https://doi.org/xxxxx`
- List up to **20 authors**; for 21+, list first 19, then `...` then last author
- Use `&` before the last author (not "and")
- Sentence case for article/chapter/book titles; title case for journal names
- Alphabetical order by first author's last name
- Same-author-same-year: append a, b, c (Smith, 2024a; Smith, 2024b)

---

## 2. IEEE (Institute of Electrical and Electronics Engineers)

### In-text Citation

| Pattern | Example |
|:--------|:--------|
| Single | [1] |
| Multiple | [1], [3] |
| Range | [1]-[5] |
| With context | As shown in [1], the method... |

References are **numbered in order of first appearance** in the text.

### Reference List Templates

**Journal Article**
```
[{N}] {Initials}. {LastName}, "{Article title}," {Journal Name in Italic}, vol. {Vol}, no. {Issue}, pp. {StartPage}-{EndPage}, {Month} {Year}, doi: {DOI}.
```
> [1] L. Zhang and R. Wang, "Deep learning for protein folding," *Nature Methods*, vol. 21, no. 3, pp. 245-260, Mar. 2024, doi: 10.1038/s41592-024-01234-5.

**Conference Paper**
```
[{N}] {Initials}. {LastName}, "{Paper title}," in {Proc. Conference Name in Italic}, {City}, {State/Country}, {Year}, pp. {Pages}, doi: {DOI}.
```
> [2] J. Kim and S. Park, "Transformer models for NLP," in *Proc. 62nd Annu. Meeting ACL*, Bangkok, Thailand, 2024, pp. 1234-1245, doi: 10.18653/v1/2024.acl-long.123.

**Book**
```
[{N}] {Initials}. {LastName}, {Book Title in Italic}, {Edition} ed. {City}, {State/Country}: {Publisher}, {Year}.
```
> [3] J. W. Creswell, *Research Design: Qualitative, Quantitative, and Mixed Methods Approaches*, 6th ed. Thousand Oaks, CA, USA: SAGE, 2023.

**Online Source**
```
[{N}] {Author/Organization}, "{Page title}," {Website Name}, {Date}. [Online]. Available: {URL}. [Accessed: {Date}].
```
> [4] National Institutes of Health, "Climate change and health," *NIH Research*, Mar. 15, 2024. [Online]. Available: https://www.nih.gov/climate-health. [Accessed: Mar. 20, 2024].

**Technical Report**
```
[{N}] {Initials}. {LastName}, "{Report title}," {Institution}, {City}, {State/Country}, Rep. {Number}, {Year}.
```
> [5] A. B. Smith, "Performance analysis of 5G networks," MIT Lincoln Lab., Lexington, MA, USA, Rep. TR-2024-01, 2024.

**Patent**
```
[{N}] {Initials}. {LastName}, "{Patent title}," {Country} Patent {Number}, {Month} {Day}, {Year}.
```
> [6] J. Chen, "Method for neural signal processing," U.S. Patent 11 234 567, Jan. 15, 2024.

### Key Rules
- Abbreviated first names: J. Smith (not John Smith)
- Article/chapter titles in "double quotes"
- Book and journal titles in *italic*
- Abbreviate journal names per IEEE standard (e.g., *IEEE Trans. Pattern Anal. Mach. Intell.*)
- Abbreviate months: Jan., Feb., Mar., Apr., May, Jun., Jul., Aug., Sep., Oct., Nov., Dec.
- All authors listed (no "et al." in reference list; use "et al." only for 7+ authors)
- Numbered sequentially — order of first citation, not alphabetical

---

## 3. Harvard (Author-Date)

### In-text Citation

| Pattern | Example |
|:--------|:--------|
| Parenthetical | (Smith 2024) |
| Narrative | Smith (2024) |
| Two authors | (Smith and Jones 2024) |
| 3+ authors | (Smith et al. 2024) |
| Multiple works | (Chen 2023; Smith 2024) |
| Direct quote | (Smith 2024, p. 15) |
| No date | (Smith n.d.) |

Note: No comma between author and year (unlike APA).

### Reference List Templates

**Journal Article**
```
{LastName}, {Initials}., {LastName2}, {Initials2}. and {LastNameN}, {InitialsN}. {Year}. {Article title}. {Journal Name in Italic}, {Volume}({Issue}), pp.{StartPage}-{EndPage}. doi:{DOI}.
```
> Zhang, L., Wang, R. and Chen, H. 2024. Deep learning approaches for protein structure prediction. *Nature Methods*, 21(3), pp.245-260. doi:10.1038/s41592-024-01234-5.

**Book**
```
{LastName}, {Initials}. {Year}. {Book Title in Italic}. {Edition} ed. {Place}: {Publisher}.
```
> Creswell, J.W. 2023. *Research Design: Qualitative, Quantitative, and Mixed Methods Approaches*. 6th ed. Thousand Oaks: SAGE Publications.

**Book Chapter**
```
{LastName}, {Initials}. {Year}. {Chapter title}. In: {EditorLastName}, {Initials}. ed(s). {Book Title in Italic}. {Place}: {Publisher}, pp.{StartPage}-{EndPage}.
```
> Liu, M. 2024. Neural network architectures. In: Chen, R. and Wang, S. eds. *Advances in Artificial Intelligence*. Berlin: Springer, pp.45-78.

**Conference Paper**
```
{LastName}, {Initials}. {Year}. {Paper title}. In: {Conference Name in Italic}. {Place}, {Date}. {Publisher}, pp.{Pages}.
```
> Kim, J. and Park, S. 2024. Transformer models for scientific text mining. In: *62nd Annual Meeting of the ACL*. Bangkok, 12-17 Aug. 2024. ACL, pp.1234-1245.

**Web Page**
```
{Author/Organization}. {Year}. {Title in Italic}. [online] Available at: {URL} [Accessed {Day} {Month} {Year}].
```
> National Institutes of Health. 2024. *Climate Change and Human Health Research*. [online] Available at: https://www.nih.gov/climate-health [Accessed 20 Mar. 2024].

### Key Rules
- Alphabetical order by first author's last name
- No numbering — entries not numbered
- Year immediately after author name (not in parentheses in reference list)
- "and" between authors (not "&")
- Include [Accessed date] for all online sources
- Title case for book titles; sentence case varies by institution — follow target journal's guide
- Harvard has no single governing body — minor variations exist across institutions

---

## 4. MLA 9th Edition (Modern Language Association)

### In-text Citation

| Pattern | Example |
|:--------|:--------|
| Parenthetical | (Smith 15) |
| Narrative | Smith argues that "..." (15) |
| Two authors | (Smith and Jones 15) |
| 3+ authors | (Smith et al. 15) |
| No page number | (Smith) |
| Multiple works | (Smith 12; Jones 34) |
| No author | ("Article Title" 15) |

Note: No comma between author and page number. No "p." before page number.

### Works Cited Templates

MLA uses a **containers model**: each source sits inside one or more containers (journal, website, database).

**Core template**:
```
{Author}. "{Source Title}." {Container Title in Italic}, {Other Contributors}, {Version}, {Number}, {Publisher}, {Date}, {Location (pages/URL/DOI)}.
```

**Journal Article**
```
{LastName}, {FirstName}, {FirstName2} {LastName2}, and {FirstNameN} {LastNameN}. "{Article Title}." {Journal Name in Italic}, vol. {Vol}, no. {Issue}, {Year}, pp. {StartPage}-{EndPage}. {Database in Italic}, {DOI or URL}.
```
> Zhang, Li, Rui Wang, and Hua Chen. "Deep Learning Approaches for Protein Structure Prediction." *Nature Methods*, vol. 21, no. 3, 2024, pp. 245-60. *Nature*, https://doi.org/10.1038/s41592-024-01234-5.

**Book**
```
{LastName}, {FirstName}. {Book Title in Italic}. {Edition}, {Publisher}, {Year}.
```
> Creswell, John W. *Research Design: Qualitative, Quantitative, and Mixed Methods Approaches*. 6th ed., SAGE Publications, 2023.

**Book Chapter**
```
{LastName}, {FirstName}. "{Chapter Title}." {Book Title in Italic}, edited by {Editor FirstName} {Editor LastName}, {Publisher}, {Year}, pp. {StartPage}-{EndPage}.
```
> Liu, Min. "Neural Network Architectures." *Advances in Artificial Intelligence*, edited by Rui Chen and Shuai Wang, Springer, 2024, pp. 45-78.

**Website**
```
{Author}. "{Page Title}." {Site Name in Italic}, {Publisher (if different from site name)}, {Day} {Month} {Year}, {URL}.
```
> "Climate Change and Human Health Research." *National Institutes of Health*, 15 Mar. 2024, www.nih.gov/climate-health.

**Film / Video**
```
{Title in Italic}. Directed by {Director Name}, {Production Company}, {Year}.
```
> *Oppenheimer*. Directed by Christopher Nolan, Universal Pictures, 2023.

### Key Rules
- Title case for all titles
- Article/chapter/webpage titles in "double quotes"
- Book/journal/website names in *italic*
- Full first names (not initials) for authors
- No year in parenthetical in-text citation — use page numbers
- Works Cited list alphabetized by author last name
- Hanging indent, double-spaced
- Abbreviate months (except May, June, July): Jan., Feb., Mar., Apr., Aug., Sept., Oct., Nov., Dec.
- Shorten page ranges: 245-60 (not 245-260) for numbers above 100

---

## 5. Chicago 17th Edition (Notes-Bibliography)

Chicago has two systems. This section covers **Notes-Bibliography** (used in humanities). For Author-Date (used in sciences), follow a pattern similar to Harvard/APA.

### In-text: Footnotes/Endnotes

First reference gets a **full note**; subsequent references use a **shortened note**.

| Type | Format |
|:-----|:-------|
| Full note | {N}. {FirstName} {LastName}, {rest of citation}. |
| Short note | {N}. {LastName}, {Short Title}, {Page}. |
| Ibid. (immediately repeated) | {N}. Ibid., {Page}. |

### Note Templates (Full) vs Bibliography Templates

**Journal Article**

*Note (full):*
```
{N}. {FirstName} {LastName}, "{Article Title}," {Journal Name in Italic} {Volume}, no. {Issue} ({Year}): {Pages}, https://doi.org/{DOI}.
```
> 1. Li Zhang, Rui Wang, and Hua Chen, "Deep Learning Approaches for Protein Structure Prediction," *Nature Methods* 21, no. 3 (2024): 245-260, https://doi.org/10.1038/s41592-024-01234-5.

*Note (short):*
> 2. Zhang, Wang, and Chen, "Deep Learning Approaches," 250.

*Bibliography:*
```
{LastName}, {FirstName}, {FirstName2} {LastName2}, and {FirstNameN} {LastNameN}. "{Article Title}." {Journal in Italic} {Volume}, no. {Issue} ({Year}): {Pages}. https://doi.org/{DOI}.
```
> Zhang, Li, Rui Wang, and Hua Chen. "Deep Learning Approaches for Protein Structure Prediction." *Nature Methods* 21, no. 3 (2024): 245-260. https://doi.org/10.1038/s41592-024-01234-5.

**Book**

*Note (full):*
```
{N}. {FirstName} {LastName}, {Title in Italic} ({Place}: {Publisher}, {Year}), {Page}.
```
> 3. John W. Creswell, *Research Design: Qualitative, Quantitative, and Mixed Methods Approaches*, 6th ed. (Thousand Oaks: SAGE Publications, 2023), 112.

*Note (short):*
> 4. Creswell, *Research Design*, 115.

*Bibliography:*
```
{LastName}, {FirstName}. {Title in Italic}. {Edition} ed. {Place}: {Publisher}, {Year}.
```
> Creswell, John W. *Research Design: Qualitative, Quantitative, and Mixed Methods Approaches*. 6th ed. Thousand Oaks: SAGE Publications, 2023.

**Book Chapter**

*Note (full):*
```
{N}. {FirstName} {LastName}, "{Chapter Title}," in {Book Title in Italic}, ed. {Editor FirstName} {Editor LastName} ({Place}: {Publisher}, {Year}), {Pages}.
```
> 5. Min Liu, "Neural Network Architectures," in *Advances in Artificial Intelligence*, ed. Rui Chen and Shuai Wang (Berlin: Springer, 2024), 45-78.

*Bibliography:*
```
{LastName}, {FirstName}. "{Chapter Title}." In {Book Title in Italic}, edited by {Editor FirstName} {Editor LastName}, {Pages}. {Place}: {Publisher}, {Year}.
```
> Liu, Min. "Neural Network Architectures." In *Advances in Artificial Intelligence*, edited by Rui Chen and Shuai Wang, 45-78. Berlin: Springer, 2024.

**Website**

*Note (full):*
```
{N}. {Author/Organization}, "{Page Title}," {Site Name}, {Date}, {URL}.
```
> 6. National Institutes of Health, "Climate Change and Human Health Research," NIH, March 15, 2024, https://www.nih.gov/climate-health.

*Bibliography:*
```
{Author/Organization}. "{Page Title}." {Site Name}. {Date}. {URL}.
```
> National Institutes of Health. "Climate Change and Human Health Research." NIH. March 15, 2024. https://www.nih.gov/climate-health.

### Key Rules
- First note = full citation; subsequent = shortened (LastName, *Short Title*, page)
- "Ibid." only when citing the same source as the immediately preceding note
- Bibliography alphabetized by last name, hanging indent
- Full first names in notes; last-name-first only for first author in bibliography
- "and" between authors (not "&")
- Publication details in parentheses in notes; no parentheses in bibliography
- Page ranges: use full numbers (245-260, not 245-60)

---

## 6. GB/T 7714-2015 (中国国家标准)

### 文内引用

**顺序编码制**（理工科常用）

| 模式 | 示例 |
|:-----|:-----|
| 单篇 | [1] |
| 多篇连续 | [1-3] |
| 多篇不连续 | [1,3,5] |
| 引用页码 | [1]^{23-25} 或正文标注 |

**著者-出版年制**（社科常用）

| 模式 | 示例 |
|:-----|:-----|
| 单作者 | (张三, 2024) 或 (Smith, 2024) |
| 双作者 | (张三和李四, 2024) 或 (Smith and Jones, 2024) |
| 三人以上 | (张三等, 2024) 或 (Smith et al., 2024) |
| 多篇 | (张三, 2023; 李四, 2024) |

### 文献类型标志（必须标注）

| 标志 | 类型 | English |
|:-----|:-----|:--------|
| [J] | 期刊论文 | Journal article |
| [M] | 专著/图书 | Monograph/Book |
| [D] | 学位论文 | Dissertation/Thesis |
| [C] | 会议论文 | Conference paper |
| [EB/OL] | 电子文献（网络） | Electronic resource (online) |
| [N] | 报纸文章 | Newspaper article |
| [S] | 标准 | Standard |
| [P] | 专利 | Patent |
| [R] | 报告 | Report |
| [Z] | 其他 | Other |

### 参考文献模板

**期刊论文 [J]**
```
[{序号}] {作者}. {文章题名}[J]. {刊名}, {年}, {卷}({期}): {起始页码}-{终止页码}. DOI:{DOI}.
```
> [1] 张磊, 王锐, 陈华. 基于深度学习的蛋白质结构预测方法研究[J]. 计算机学报, 2024, 47(3): 245-260. DOI:10.11897/SP.J.1016.2024.00245.

**英文期刊论文 [J]**
> [2] ZHANG L, WANG R, CHEN H. Deep learning approaches for protein structure prediction[J]. Nature Methods, 2024, 21(3): 245-260. DOI:10.1038/s41592-024-01234-5.

**专著/图书 [M]**
```
[{序号}] {作者}. {书名}[M]. {版本 (第1版不标注)}. {出版地}: {出版者}, {出版年}: {引用页码}.
```
> [3] 陈伟. 人工智能导论[M]. 第2版. 北京: 清华大学出版社, 2024: 112-135.

> [4] CRESWELL J W. Research design: qualitative, quantitative, and mixed methods approaches[M]. 6th ed. Thousand Oaks: SAGE Publications, 2023.

**学位论文 [D]**
```
[{序号}] {作者}. {论文题名}[D]. {保存地}: {保存单位}, {年份}.
```
> [5] 李晓明. 基于图神经网络的药物分子设计研究[D]. 北京: 清华大学, 2024.

**会议论文 [C]**
```
[{序号}] {作者}. {论文题名}[C]// {会议论文集名}. {出版地}: {出版者}, {年}: {页码}.
```
> [6] 王强, 赵丽. 大语言模型在科学发现中的应用[C]// 第二十三届中国计算语言学大会论文集. 哈尔滨: 中国中文信息学会, 2024: 45-52.

**英文会议论文 [C]**
> [7] KIM J, PARK S. Transformer models for scientific text mining[C]// Proceedings of the 62nd Annual Meeting of the ACL. Bangkok: ACL, 2024: 1234-1245.

**电子文献 [EB/OL]**
```
[{序号}] {作者}. {题名}[EB/OL]. ({发表或更新日期})[{引用日期}]. {URL}. DOI:{DOI}.
```
> [8] 国家自然科学基金委员会. 2024年度项目指南[EB/OL]. (2024-01-15)[2024-03-20]. https://www.nsfc.gov.cn/publish/portal0/tab442/info92345.htm.

**报纸文章 [N]**
```
[{序号}] {作者}. {题名}[N]. {报纸名}, {出版日期}({版次}).
```
> [9] 张伟. 人工智能赋能基础科学研究[N]. 科技日报, 2024-03-15(001).

**标准 [S]**
```
[{序号}] {标准号} {标准名称}[S]. {出版地}: {出版者}, {年}.
```
> [10] GB/T 7714-2015 信息与文献 参考文献著录规则[S]. 北京: 中国标准出版社, 2015.

**专利 [P]**
```
[{序号}] {专利申请者或所有者}. {专利题名}: {专利号}[P]. {公告日期或公开日期}.
```
> [11] 华为技术有限公司. 一种神经网络模型压缩方法: CN202410123456.7[P]. 2024-06-15.

### 关键规则

- **文献类型标志**必须标注于题名后的方括号内，如 `[J]`、`[M]`
- **作者姓名**：中文姓名全写；英文姓在前名缩写（ZHANG L）且全大写
- **3位以上作者**：列前3位，后加 "等" (中文) 或 "et al." (英文)
- **DOI**：有 DOI 的文献必须著录 DOI
- **引用日期**：电子文献 [EB/OL] 必须标注引用日期，格式 `[YYYY-MM-DD]`
- **页码**：用起止页码，中间用连字符
- **第1版**不标注版次，第2版及以上标注

### 中英文混排规则

- 英文文献中作者姓名全大写：`SMITH J, JONES R M`
- 中文文献中作者姓名正常书写：`张磊, 王锐`
- 同一参考文献表中，中英文文献按统一编号排列
- 顺序编码制：按引用顺序排列，不区分中英文
- 著者-出版年制：中英文混排时，通常中文在前英文在后，各自按拼音/字母排序
- 英文文献的题名首词首字母大写，其余小写（非专有名词）
- 中文析出文献用 `//` 连接主文献（如会议论文集），英文用 `In:` 或 `//`

---

## Quick Comparison Table

| Feature | APA 7 | IEEE | Harvard | MLA 9 | Chicago 17 | GB/T 7714 |
|:--------|:------|:-----|:--------|:------|:-----------|:----------|
| In-text | (Author, Year) | [1] | (Author Year) | (Author Page) | Footnote | [1] 或 (作者, 年) |
| Order | Alphabetical | Appearance | Alphabetical | Alphabetical | Alphabetical | Appearance 或 alphabetical |
| Author format | LastName, I. | I. LastName | LastName, I. | LastName, First | FirstName Last | 姓名全写/LAST I |
| "And" | & | — | and | and | and | , (逗号) |
| 3+ authors (in-text) | et al. | — | et al. | et al. | — | 等/et al. |
| DOI | https://doi.org/... | doi: ... | doi:... | URL or DOI | https://doi.org/... | DOI:... |
| Typical field | Social sciences | Engineering | UK/AU general | Humanities | History/Arts | 中国 (all fields) |
