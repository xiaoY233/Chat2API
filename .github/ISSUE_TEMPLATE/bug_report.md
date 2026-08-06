---
name: Bug report
about: Create a report to help us improve
title: "[BUG]"
labels: bug
assignees: xiaoY233

---

# 🐛 Bug Report

## 问题描述
<!-- 简明扼要地描述你遇到了什么问题 -->

## 复现步骤
1. 
2. 
3. 

## 期望行为
<!-- 描述你期望发生什么 -->

## 实际行为
<!-- 描述实际发生了什么 -->

## 截图 / 日志
<!-- 如果适用，添加截图或错误日志帮助说明问题 -->

## 环境信息

### 基本信息
| 项目 | 值 |
|---|---|
| Chat2API 版本 | <!-- 如 v1.2.0，可在 About 页面查看 --> |
| 操作系统及版本 | <!-- 如 macOS 15.3 / Windows 11 23H2 / Ubuntu 24.04 --> |
| 系统架构 | <!-- arm64 / x64 --> |

### 运行环境
| 项目 | 值 |
|---|---|
| Node.js 版本 | <!-- 若从源码构建则填写 --> |
| npm 版本 | <!-- 若从源码构建则填写 --> |

## 相关 Provider 信息
<!-- 请填写出问题时使用的 Provider，可多选 -->

- [ ] DeepSeek
- [ ] GLM
- [ ] Kimi
- [ ] MiniMax
- [ ] Perplexity
- [ ] Qwen (CN)
- [ ] Qwen AI (Global)
- [ ] Z.ai

### Provider 详情
| 项目 | 值 |
|---|---|
| 出问题的 Provider |  |
| 认证方式 | <!-- User Token / Refresh Token / JWT Token / SSO Ticket --> |
| 使用的模型 | <!-- 如 DeepSeek-V3.2, GLM-5, kimi-k2.5 等 --> |

## 代理配置
| 项目 | 值 |
|---|---|
| 代理端口 | <!-- 默认 8080 --> |
| 负载均衡策略 | <!-- Round Robin / Fill First / Failover --> |
| 添加的账号数量 |  |
| 是否启用 API Key 认证 |  |

## 自定义参数（如有）
<!-- 是否配置了自定义 HTTP Headers（如开启 web search、thinking mode、deep research 等） -->

## 请求日志
<!-- 请贴入 `~/.chat2api/logs/` 下的相关日志内容，或 Dashboard 中的请求记录，注意脱敏 Token 等敏感信息 -->
