/**
 * 工程化编程范式（约束协议 v2.0）
 *
 * 数据文件 — ultra 思考强度时注入主 Agent 系统提示词。
 * 门面模块：按原始顺序拼接同目录分段常量，拼接结果与拆分前逐字一致。
 */

import { GLM_PARADIGM_CORE } from './core'
import { GLM_PARADIGM_WORKFLOW } from './workflow'
import { GLM_PARADIGM_STANDARDS } from './standards'
import { GLM_PARADIGM_ENDURANCE } from './endurance'

export const GLM_PARADIGM_PROMPT =
  GLM_PARADIGM_CORE +
  GLM_PARADIGM_WORKFLOW +
  GLM_PARADIGM_STANDARDS +
  GLM_PARADIGM_ENDURANCE
