#!/usr/bin/env Rscript
# treatment_map_china.R: replace toy data with your analysis output.
# treatment_map_china.R —— 中国处理组省份地图 (sf + ggplot2)
# install.packages(c("sf", "ggplot2", "dplyr"))
#
# 注: 真实使用需提供中国行政区划 shapefile, 例如:
#   - GADM https://gadm.org/download_country.html  -> CHN_adm1.shp
#   - 阿里云 datav https://datav.aliyun.com/portal/school/atlas/area_selector
#   - 国家基础地理信息中心 1:100 万县级数据
# 本模板用合成多边形 (省份用矩形格代替), 演示框架.
#
# 运行: Rscript treatment_map_china.R   ->  treatment_map_china_out.pdf
# ----------------------------------------------------------------

suppressPackageStartupMessages({
  library(sf)
  library(ggplot2)
  library(dplyr)
})

set.seed(20260501)

# ---- 1. 合成 31 省矩形多边形 (实际换成 st_read("CHN_adm1.shp")) ----
provinces <- c("北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林",
               "黑龙江", "上海", "江苏", "浙江", "安徽", "福建", "江西",
               "山东", "河南", "湖北", "湖南", "广东", "广西", "海南",
               "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃",
               "青海", "宁夏", "新疆")

n_p <- length(provinces)
xs <- rep(0:6, length.out = n_p)
ys <- rep(0:4, each = 7, length.out = n_p)

make_box <- function(x, y) {
  st_polygon(list(rbind(c(x, y), c(x + 1, y),
                        c(x + 1, y + 1), c(x, y + 1),
                        c(x, y))))
}
geoms <- mapply(make_box, xs, ys, SIMPLIFY = FALSE)
sf_chn <- st_sf(province = provinces,
                treat    = sample(c(0, 1), n_p, replace = TRUE,
                                  prob = c(0.65, 0.35)),
                geometry = st_sfc(geoms))

# ---- 2. 绘图 ----
p <- ggplot(sf_chn) +
  geom_sf(aes(fill = factor(treat)),
          color = "black", linewidth = 0.2) +
  geom_sf_text(aes(label = province), size = 1.8, family = "sans") +
  scale_fill_manual(values = c(`0` = "white", `1` = "#08306B"),
                    labels = c(`0` = "控制组", `1` = "处理组 (试点省份)"),
                    name   = NULL) +
  labs(caption = "注: 深色为政策试点省份; 浅色为控制组. 数据来源: 合成示例.") +
  theme_void(base_size = 9) +
  theme(legend.position = "bottom",
        legend.key.size = unit(0.4, "cm"),
        legend.text     = element_text(size = 8),
        plot.caption    = element_text(size = 7, hjust = 0,
                                       margin = margin(t = 6)))

ggsave("treatment_map_china_out.pdf", p, width = 12, height = 8,
       units = "cm", device = cairo_pdf)
message("saved: treatment_map_china_out.pdf")
message("提示: 真实地图请用 sf::st_read('CHN_adm1.shp'), 并加南海九段线小图.")
