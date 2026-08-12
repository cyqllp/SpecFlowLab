import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeLocale,
  translateText,
} from "../src/lib/i18n.js";

test("locale normalization supports English and Simplified Chinese", () => {
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("zh-CN"), "zh-CN");
  assert.equal(normalizeLocale("zh-Hans"), "zh-CN");
});

test("UI translations preserve scientific abbreviations and interpolate counts", () => {
  assert.equal(translateText("Component Spectra", "zh-CN"), "组分光谱");
  assert.equal(translateText("Wavelength (nm)", "zh-CN"), "波长 (nm)");
  assert.equal(translateText("12 components", "zh-CN"), "12 个组分");
  assert.equal(translateText("Batch Global Fitting (7)", "zh-CN"), "批量全局拟合（7）");
  assert.equal(translateText("Fit available, unresolved analysis dataset", "zh-CN"), "已有拟合、含未分辨组分的分析数据集");
  assert.equal(translateText("sample.sflproj opened with treated datasets and analysis state.", "zh-CN"), "sample.sflproj 已打开，包含已处理数据集和分析状态。");
  assert.equal(translateText("SF_vis + SF_nir was added as a derived dataset; both parent sources remain unchanged.", "zh-CN"), "SF_vis + SF_nir 已作为派生数据集添加；两个父源数据均保持不变。");
  assert.equal(translateText("The selected wavelength subranges contain a gap; plots will mark a broken wavelength axis.", "zh-CN"), "所选波长子范围之间存在间隔；图中将标记断开的波长轴。");
  assert.equal(translateText("Merge", "zh-CN"), "合并");
  assert.equal(translateText("Merge spectral ranges", "zh-CN"), "合并光谱范围");
  assert.equal(translateText("Expand VIS", "zh-CN"), "展开 VIS");
  assert.equal(translateText("Drag sample.ufs to another folder", "zh-CN"), "将 sample.ufs 拖到其他文件夹");
  assert.equal(translateText("Component spectra mode", "zh-CN"), "组分光谱模式");
  assert.equal(translateText("Version 1.0.0", "zh-CN"), "版本 1.0.0");
  assert.equal(translateText("SpecFlowLab Manual", "zh-CN"), "SpecFlowLab 使用手册");
  assert.equal(translateText("Treat the dataset before merging", "zh-CN"), "请先处理数据集，再进行合并");
  assert.equal(translateText("AI Investigation", "zh-CN"), "AI 研究");
  assert.equal(translateText("Save .sflai Package...", "zh-CN"), "保存 .sflai 包…");
  assert.equal(translateText("No network upload.", "zh-CN"), "不进行网络上传。");
  assert.equal(translateText("The treated time axes are used directly; no additional time-zero shift is applied.", "zh-CN"), "直接使用已处理的时间轴，不再额外移动时间零点。");
  assert.equal(translateText("2 datasets imported into one new folder. Original CSV text or UFS bytes are preserved.", "zh-CN"), "2 个数据集已导入到一个新文件夹；原始 CSV 文本或 UFS 字节已保留。");
  assert.equal(translateText("EAS", "zh-CN"), "EAS");
  assert.equal(translateText("Gaussian Feature Finder", "zh-CN"), "高斯特征寻找器");
  assert.equal(translateText("2 IRF-limited excluded", "zh-CN"), "已排除 2 个 IRF 受限组分");
  assert.equal(translateText("Component Spectra", "en"), "Component Spectra");
});
