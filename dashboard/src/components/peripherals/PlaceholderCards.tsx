/**
 * PlaceholderCards — 置灰占位卡 (Task 17)
 *
 * 导出两张置灰卡:
 *   - LabPlaceholderCard      物理实验室(仪器接入愿景)
 *   - EmbodiedPlaceholderCard 具身科研智能(机械臂 / 移动平台 / 人形愿景)
 *
 * 设计语言:
 *   - 整卡 opacity 0.5 → 视觉上置灰,传递"未开放"信号
 *   - 灰色状态条 (#6B7280)
 *   - "即将推出" 灰色 Tag (antd Tag color="default")
 *   - 整卡可点 (cursor: pointer) → 打开 antd Modal 显示愿景简介
 *   - Modal 无任何行动按钮 (footer={null}),底部注"敬请期待"
 *
 * i18n 键:
 *   periph.placeholder.comingSoon
 *   periph.placeholder.lab.*
 *   periph.placeholder.embodied.*
 */

import React, { useState } from 'react';
import { Modal, Tag, Typography } from 'antd';
import { ExperimentOutlined, RobotOutlined } from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import { useConfigStore } from '../../stores/config';
import { getThemeTokens } from '../../styles/theme';

const { Text, Paragraph, Title } = Typography;

// ── Shared constants ──────────────────────────────────────────────────────────

const GREY = '#6B7280';

// ─────────────────────────────────────────────────────────────────────────────
// ① 物理实验室卡 — LabPlaceholderCard
// ─────────────────────────────────────────────────────────────────────────────

export function LabPlaceholderCard() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* ── 卡体:整体 opacity 0.5 ─────────────────────────────────────────── */}
      <div
        data-testid="periph-placeholder-lab"
        onClick={() => setOpen(true)}
        style={{
          opacity: 0.5,
          cursor: 'pointer',
          border: `1px solid ${tokens.border.default}`,
          borderRadius: 8,
          overflow: 'hidden',
          background: tokens.bg.surface,
          userSelect: 'none',
        }}
      >
        {/* 灰色状态条 */}
        <div
          data-testid="periph-placeholder-lab-strip"
          style={{ height: 4, background: GREY }}
        />

        {/* 卡片主体 */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 标题行 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <ExperimentOutlined
              style={{ fontSize: 18, color: GREY, flexShrink: 0 }}
            />
            <Text strong style={{ fontSize: 14, color: tokens.text.primary, flex: 1 }}>
              {t('periph.placeholder.lab.title', '物理实验室')}
            </Text>
            {/* 即将推出 Tag */}
            <Tag
              data-testid="periph-placeholder-lab-tag"
              color="default"
              style={{ fontSize: 11, borderRadius: 4, color: GREY }}
            >
              {t('periph.placeholder.comingSoon', '即将推出')}
            </Tag>
          </div>

          {/* 简介文案 */}
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t(
              'periph.placeholder.lab.hint',
              '面向培养箱、显微镜、PCR 仪等真实仪器接入,让 Agent 直接读取仪器状态并控制实验流程。',
            )}
          </Text>
        </div>
      </div>

      {/* ── Modal 愿景简介 ────────────────────────────────────────────────── */}
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title={null}
        width={520}
        centered
      >
        <div style={{ padding: '8px 4px' }}>
          {/* 标题 */}
          <Title
            data-testid="periph-placeholder-lab-modal-title"
            level={4}
            style={{ margin: '0 0 16px', color: tokens.text.primary }}
          >
            {t('periph.placeholder.lab.modalTitle', '物理实验室接入 — 愿景')}
          </Title>

          {/* 正文 */}
          <div data-testid="periph-placeholder-lab-modal-body">
            <Paragraph style={{ color: tokens.text.secondary, marginBottom: 12 }}>
              {t(
                'periph.placeholder.lab.modalP1',
                '物理实验室外设模块旨在打通 AI Agent 与真实科学仪器之间的连接通道。目标场景包括培养箱状态监控、显微镜图像捕获、PCR 仪进程读取等。Agent 将能够直接查询仪器当前状态、根据实验协议自动推进步骤、并将测量数据实时写入工作区。',
              )}
            </Paragraph>
            <Paragraph style={{ color: tokens.text.secondary, marginBottom: 12 }}>
              {t(
                'periph.placeholder.lab.modalP2',
                '技术路线:仪器命令将通过插件 nodeInvokePolicies 机制注册为受策略管控的调用单元,确保每一条仪器操作指令在执行前均经过权限审查与人工确认(Human-in-Loop),防止自动化操作引发实验安全风险。',
              )}
            </Paragraph>
            <Paragraph style={{ color: tokens.text.secondary, marginBottom: 0 }}>
              {t(
                'periph.placeholder.lab.modalP3',
                '在外设子系统中,物理实验室仪器的 kind 字段预留为 lab-instrument,driver 枚举位 lab-instrument 已在数据库 schema 中占位。正式上线时将通过 driver 层扩展接入,工具面与 RPC 结构保持不变。',
              )}
            </Paragraph>
          </div>

          {/* 底注 */}
          <div
            data-testid="periph-placeholder-lab-modal-note"
            style={{
              marginTop: 20,
              paddingTop: 12,
              borderTop: `1px solid ${tokens.border.default}`,
              textAlign: 'center',
            }}
          >
            <Text style={{ fontSize: 12, color: GREY }}>
              {t('periph.placeholder.stayTuned', '敬请期待')}
            </Text>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 具身科研智能卡 — EmbodiedPlaceholderCard
// ─────────────────────────────────────────────────────────────────────────────

export function EmbodiedPlaceholderCard() {
  const { t } = useTranslation();
  const theme = useConfigStore((s) => s.theme);
  const tokens = getThemeTokens(theme);
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* ── 卡体 ──────────────────────────────────────────────────────────── */}
      <div
        data-testid="periph-placeholder-embodied"
        onClick={() => setOpen(true)}
        style={{
          opacity: 0.5,
          cursor: 'pointer',
          border: `1px solid ${tokens.border.default}`,
          borderRadius: 8,
          overflow: 'hidden',
          background: tokens.bg.surface,
          userSelect: 'none',
        }}
      >
        {/* 灰色状态条 */}
        <div
          data-testid="periph-placeholder-embodied-strip"
          style={{ height: 4, background: GREY }}
        />

        {/* 卡片主体 */}
        <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* 标题行 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RobotOutlined
              style={{ fontSize: 18, color: GREY, flexShrink: 0 }}
            />
            <Text strong style={{ fontSize: 14, color: tokens.text.primary, flex: 1 }}>
              {t('periph.placeholder.embodied.title', '具身科研智能')}
            </Text>
            {/* 即将推出 Tag */}
            <Tag
              data-testid="periph-placeholder-embodied-tag"
              color="default"
              style={{ fontSize: 11, borderRadius: 4, color: GREY }}
            >
              {t('periph.placeholder.comingSoon', '即将推出')}
            </Tag>
          </div>

          {/* 简介文案 */}
          <Text style={{ fontSize: 12, color: tokens.text.muted }}>
            {t(
              'periph.placeholder.embodied.hint',
              '面向机械臂、移动平台、人形机器人等具身设备接入,让 Agent 拥有物理执行能力。',
            )}
          </Text>
        </div>
      </div>

      {/* ── Modal 愿景简介 ────────────────────────────────────────────────── */}
      <Modal
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        title={null}
        width={540}
        centered
      >
        <div style={{ padding: '8px 4px' }}>
          {/* 标题 */}
          <Title
            data-testid="periph-placeholder-embodied-modal-title"
            level={4}
            style={{ margin: '0 0 16px', color: tokens.text.primary }}
          >
            {t('periph.placeholder.embodied.modalTitle', '具身科研智能 — 愿景')}
          </Title>

          {/* 正文 */}
          <div data-testid="periph-placeholder-embodied-modal-body">
            <Paragraph style={{ color: tokens.text.secondary, marginBottom: 12 }}>
              {t(
                'periph.placeholder.embodied.modalP1',
                '具身科研智能模块旨在赋予 AI Agent 物理执行能力。目标设备包括机械臂、轮式移动平台与人形机器人等,覆盖实验室巡检、样品取放、操作台直接操控一体化场景——从感知到执行在同一 Agent 循环中闭合。',
              )}
            </Paragraph>
            <Paragraph style={{ color: tokens.text.secondary, marginBottom: 12 }}>
              {t(
                'periph.placeholder.embodied.modalP2',
                '技术路线:具身设备将对接 OpenClaw nodes 体系(role:node + node.invoke),通过 oc-node driver 接入外设子系统。每台具身设备在 OC 节点图中注册为独立节点,Agent 调用 node.invoke 发送指令,执行结果回写观测时间线。配对接入须经审批流程,防止未经授权的物理操作。',
              )}
            </Paragraph>
            <Paragraph style={{ color: tokens.text.secondary, marginBottom: 0 }}>
              {t(
                'periph.placeholder.embodied.modalP3',
                '在演进路线上,具身科研智能与摄像头桥同属一条演进线:摄像头桥已实现"agent 请求一帧 → 桥接 → 视觉查证"闭环,具身模块将在此基础上扩展为"agent 下指令 → oc-node → 物理执行 → 状态回传"链路。kind 预留为 embodied,driver 枚举位 oc-node 已在 schema 中占位。',
              )}
            </Paragraph>
          </div>

          {/* 底注 */}
          <div
            data-testid="periph-placeholder-embodied-modal-note"
            style={{
              marginTop: 20,
              paddingTop: 12,
              borderTop: `1px solid ${tokens.border.default}`,
              textAlign: 'center',
            }}
          >
            <Text style={{ fontSize: 12, color: GREY }}>
              {t('periph.placeholder.stayTuned', '敬请期待')}
            </Text>
          </div>
        </div>
      </Modal>
    </>
  );
}
