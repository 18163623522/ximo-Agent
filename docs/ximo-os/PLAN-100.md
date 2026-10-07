# ximo-OS 适配度 100% 达成方案（PLAN-100）

> 产自 2026-10-07 第三轮评估。前置文档：`DEVELOPMENT-PROMPT.md`（执行纪律）与
> `HANDOFF.md`（环境事实）。本方案回答一个问题：**从当前 ~70% 到 100%，差哪些
> 工作包、每个怎么做、怎么验收、多久做完。**
>
> 「100%」的边界声明：指本方案评分卡六个维度全部达到 100% 且六条 E2E 铁门槛
> 全部通过——即可验证清单的完全关闭。它不承诺「再无 bug」（任何 OS 都不成立），
> 但承诺复盘账目上没有已知的、未关闭的缺口。

---

## 一、评分卡（权重固定，避免口径漂移）

| 维度 | 权重 | 衡量内容 | 当前分 | 100% 证据要求 |
|---|---|---|---|---|
| 大脑 | 30% | Agent 循环/权限/上下文/shim 移植质量 | 92 | C 阶段全项验证 + shim 严格模式下清点全绿 |
| 手眼 | 25% | 主机工具域覆盖与真实可用性 | 85 | D1/D4 E2E + 工具清点 31/31 |
| 桌面 | 20% | desktop-bus 在 WSL1 与**镜像**上的能力 + 接管 | 40 | 铁门槛①⑤通过 |
| OS 系统层 | 15% | 镜像生命周期/CI 可信度/并发/快照 | 55 | 铁门槛②③⑤通过 |
| 驾驶舱联动 | 10% | 协议双向对接完整度 | 85 | 铁门槛①⑥ + 接管 E2E |
| 安全与隔离 | 5% | 沙箱/审计/数据边界 | 35 | 铁门槛③ + 沙箱逃逸测试 |

当前综合 = 0.30×92 + 0.25×85 + 0.15×40 + 0.15×55 + 0.10×85 + 0.05×35 ≈ **70%**
（此前口径未公布权重，估 65–68%；现按固定权重计算，两者是同一实况）。

## 二、六条 E2E 铁门槛（全部通过 = 100% 达成的必要条件）

1. **镜像桌面 E2E**：镜像引导后，Agent 纯 API 完成「app.available → app.launch →
   window.list → key → clipboard.write/read」全链路，零截图。
2. **红灯能力实测**：对三类防线各注入一次破坏（工具工厂改坏 / allow 删条目 /
   mkosi 段落放错），CI 必须全部变红，记录留档。
3. **快照回滚 E2E**：任务把工作区改坏 → 快照回滚 → 内容恢复一致。
4. **浏览器零截图 E2E**：Agent 经 browser 工具完成「搜索并提取结果标题」。
5. **并发隔离 E2E**：两个任务并行，工作区/写白名单互不污染。
6. **权限自证**：主机启动日志打印「工具 × 决策」矩阵，回退触发有告警计数。

---

## 三、工作分解（WBS）——七个工作包

### WP-0　阶段 A 关门【阻塞一切，0.5–1 天】

| # | 任务 | 验证 |
|---|---|---|
| 0.1 | 提交 A3 修复（bus.ts 分类改 err.code + 自愈恢复；两处单测改真实错误形状——**已在工作区，待提交**） | vitest 全绿 + 手动复现脚本通过 |
| 0.2 | 提交 A4（CI 冒烟去 continue-on-error、探 17890、接 verify-image；build-image.sh 加 mkosi summary 断言） | yml lint / shellcheck |
| 0.3 | 提交 A5（tests/host/desktop-bus-xvfb.test.ts + xvfb-integration job） | 本机 skip 正确 |
| 0.4 | push 触发 CI 首跑，盯三个 job：镜像构建 / QEMU 冒烟 / **xvfb-integration 首跑** | CI 全绿（首轮红→修，预算 2–3 轮） |
| 0.5 | **红灯实测（铁门槛②）**：改坏一个工具工厂名 / 删一条 allow / 把 postinstall 放回 [Execution] 段，逐一确认变红后还原 | 三次红灯记录写入 HANDOFF |
| 0.6 | 【用户动作】GitHub 仓库配置 `DEEPSEEK_API_KEY` secret——否则镜像冒烟只验证 health，不验证派任务 | secret 存在且 workflow 能读到 |

**WP-0 后：OS 层 55→62，综合 ~71%。**

### WP-1　镜像桌面栈【桌面 40→75，2–4 天，可与 WP-2 并行】

| # | 任务 | 验证 |
|---|---|---|
| 1.1 | `mkosi.conf` Packages 追加 `xvfb,openbox,xdotool,wmctrl,xclip,ffmpeg,imagemagick`（体积预算 ≤200MB，超了停下问用户） | 本地 `mkosi summary` 断言通过 |
| 1.2 | 新增 `xvfb@.service` 模板单元：托管 Xvfb :99 + openbox；`Restart=always`（会话自愈） | 引导后 `pgrep Xvfb` 在位 |
| 1.3 | `agent-hostd.service` 加 `Wants=xvfb@0.service`/`After=`；display 经 `XIMO_DISPLAY=:99` 环境变量注入 config | 单元依赖链在 debugfs 里可见 |
| 1.4 | firstboot.sh 适配：config 占位时写入 `display: ":99"` | firstboot 幂等性保持 |
| 1.5 | 离线验收清单扩充：X 工具五件套二进制在位、两个单元 enabled、display 配置在位 | `verify-image`/debugfs 脚本更新并通过 |
| 1.6 | CI 镜像级桌面冒烟（铁门槛①）：引导后经 cockpit-link 派纯 API 桌面任务 | 任务 completed 且 chunk 里可见窗口树 |
| 1.7 | 镜像体积实测回写 HANDOFF（内核 500MB 基础上的增量） | 文档更新 |

**风险**：镜像 CI 调试轮次（历史 20 轮教训）；openbox 在无显示管理器下的自启时序。
**WP-1 后：桌面 40→75，OS 层 62→70，综合 ~78%。**

### WP-2　权限与协议可观测【大脑 92→100，1–2 天，可与 WP-1 并行】

| # | 任务 | 验证 |
|---|---|---|
| 2.1 | 主机启动打印「工具 × 决策」矩阵 + 回退触发 warn/计数（铁门槛⑥） | 启动日志含矩阵；单测覆盖 |
| 2.2 | defaultDecision 场景化：host 显式注入 deny 并日志声明；主应用保持 ask | 无人值守下未列入清单的工具=拒绝且**有日志** |
| 2.3 | 三方对账测试（HOST_TOOL_NAMES ↔ lazy-registry ↔ Permission）+ 清理现存死规则（wsl_desktop 全家 / code_execute ask） | 对账测试全绿；Permission 无死规则 |
| 2.4 | `DESKTOP_ACTIONS` 加 `satisfies` 穷举约束 | 漏加数组 → typecheck 红（用临时破坏验证） |
| 2.5 | `hello` 加主机支持 action 列表；未知 desktop action 改回 `desktop.reply(ok:false)`，不再断连 | 协议测试覆盖新/旧主机偏斜 |
| 2.6 | shim 严格模式（主机默认开）+ `store.ts` 主机路径禁明文写 apiKey | 严格模式下 host-verify 29/29 仍绿 |

**WP-2 后：大脑 100，安全 35→55，驾驶舱 85→90，综合 ~84%。**

### WP-3　浏览器 CDP【手眼 85→93，2–4 天】

技术路径已定：**CDP 直连，禁止 playwright**（最小接缝哲学，与 electron-shim 同构）。

| # | 任务 | 验证 |
|---|---|---|
| 3.1 | 镜像 Packages 加 chromium；agent-hostd 增加 browser 会话托管（`--remote-debugging-port=9222 --headless=new`，可配非 headless 走 desktop-bus） | CDP 端口本机可达 |
| 3.2 | 主机侧 CDP 客户端：Node 原生 ws 实现 navigate/click/type/screenshot/evaluate/内容提取六原语（≤400 行/文件，按门面拆） | 单测用 CDP 协议回放 |
| 3.3 | 注册 `browser` 工具域 + Permission 条目（navigate/click/内容提取 allow；download/execute 类 ask） | host-verify 清点数 +2 |
| 3.4 | E2E（铁门槛④）：零截图完成「搜索并提取结果标题」 | 任务 completed 且结果含真实标题 |

**WP-3 后：手眼 85→93，综合 ~88%。**

### WP-4　并发进程池【OS 70→80，1–2 天】

| # | 任务 | 验证 |
|---|---|---|
| 4.1 | runTask 迁入 worker 子进程（child_process fork），主进程只留队列/WS/广播 | 现有 host 测试全绿（接口不变） |
| 4.2 | chdir/写白名单随进程生命周期隔离，消除 task-runner.ts:193-194 的全局残留点 | 崩溃注入测试：worker 异常退出不影响下一个任务 |
| 4.3 | 并发 E2E（铁门槛⑤）：双任务并行，工作区互不污染 | 集成测试断言两工作区内容独立 |
| 4.4 | 任务取消级联到 worker（AbortSignal 跨进程传递） | cancel 后 worker 退出、终态 cancelled |

**WP-4 后：OS 层 70→80，安全 55→70，综合 ~90%。**

### WP-5　人工接管【桌面 75→90，1 天】

| # | 任务 | 验证 |
|---|---|---|
| 5.1 | 协议加 `input.move/click/key/type`（HOST_VERSION→2，遵守版本纪律） | 协议测试 + 双端版本协商 |
| 5.2 | HostClient 发送端 + 桌面面板接现有键鼠 UI（§HANDOFF 中已存在的入口） | 驾驶舱鼠标移动镜像内真实光标 |
| 5.3 | 权限：input.* 默认 ask（有人在场的语义），C1 矩阵可见 | 矩阵含 input.* 行 |

**WP-5 后：桌面 75→90，驾驶舱 90→95，综合 ~92%。**

### WP-6　office_docs 旧格式【手眼 93→97，1 天】

| # | 任务 | 验证 |
|---|---|---|
| 6.1 | 镜像加 LibreOffice headless（**仅转换用途**，主机 Node 运行时不引入依赖） | soffice --version 在镜像内可执行 |
| 6.2 | office_docs 加 `convert` action（.doc/.xls/.ppt → OOXML 再走既有读写） | E2E：.doc 读全文 |
| 6.3 | 复杂排版导出路径：ooxml-helper 生成 → soffice 转 PDF/终稿（声明为 best-effort） | E2E：简单文档导出 PDF |

**WP-6 后：手眼 93→97，综合 ~94%。**

### WP-7　阶段 3：快照 / 沙箱 / 审计【OS 80→95，3–5 天】

| # | 任务 | 验证 |
|---|---|---|
| 7.1 | root 分区改 btrfs + firstboot 建子卷布局（@root/@workspace/@snapshots）。**连锁风险：分区表验收脚本同步改** | 离线验收更新并通过 |
| 7.2 | 任务前后快照打点 + `workspace.rollback` 运维 API（仅 SSH/控制台可达，不进 cockpit-link） | 铁门槛③ |
| 7.3 | 按任务用户沙箱：与 WP-4 进程池**合并设计**——每任务 = 专用系统用户 + 专用 worker 进程 + 独立工作区；权限收口到文件系统层 | 沙箱逃逸测试：任务内写工作区外路径被拒 |
| 7.4 | eBPF 审计最小集：记录每任务的 exec/敏感路径写（bcc 或 llvmbpf 最小脚本，宁缺毋滥） | journal 可按任务 id 查审计流水 |

**WP-7 后：OS 层 80→95，安全 70→95，综合 ~97%。**

### 收尾包　边界声明与账目清零【各项 →100，0.5–1 天】

- 视觉升级路由写进 desktop 工具提示词（API 失败 N 次自动升级 screenshot+vision）——桌面 95→100
- 数据边界声明进 PROTOCOL.md/README（屏幕内容经视觉模型出站到哪个端点）——安全 95→100
- 接管时延/丢帧的已知边界文档化——驾驶舱 95→100
- 六条铁门槛证据汇总进 HANDOFF，适配度自评表归 100

---

## 四、时间线与关键路径

```
周1        WP-0(关门) ──→ WP-1(镜像桌面) ──┐
              └──→ WP-2(权限协议) ─────────┤
周2          WP-3(浏览器CDP) ∥ WP-4(进程池) ┤
周2末~周3    WP-5(接管) → WP-6(office) → WP-7(阶段3) → 收尾
```

- 串行总工期 **11–19 个开发日**；按上表并行压缩为 **2–3 周日历时间**（CI 等待与调试轮次占 30%+）。
- 里程碑：M0=A 关门（综合 ~71%）→ M1=镜像有桌面（~84%，项目立身形态成立）→ M2=浏览器+并发（~90%）→ M3=100%。

## 五、风险与依赖清单

| 风险/依赖 | 影响 | 对策 |
|---|---|---|
| 用户未配 DEEPSEEK_API_KEY secret | 镜像冒烟降级为 health-only，铁门槛①打折 | WP-0 内完成（用户动作） |
| 镜像 CI 调试轮次不可控（历史 20 轮） | WP-1 工期膨胀 | 桌面栈包都是成熟包；坚持 mkosi summary 前置断言 |
| btrfs 分区变更破坏既有验收脚本 | WP-7 连锁返工 | 7.1 与验收脚本同一 PR 内同步改 |
| CDP/LibreOffice 版本行为差异 | WP-3/6 的 E2E 抖动 | 镜像内锁版本；E2E 断言宽松到「结构正确」级 |
| openbox/Xvfb 自启时序 | WP-1 首跑失败 | systemd 依赖链 + Retry；CI 首轮预留 2–3 轮调试 |
| 另一 Agent 会话仍在活动 | 工作区并发改动冲突 | WP-0 提交前 `git status` 核对，逐文件确认归属 |

## 六、执行纪律

全部沿用 `DEVELOPMENT-PROMPT.md` 第三节：阶段门禁（WP-0 阻塞一切）、灭类纪律、
禁新增静默失效、每包末尾跑 typecheck/vitest/host:build、跨会话接力写 HANDOFF。
每个工作包 = 一组独立 commit（`阶段 N：…` / `fix: …`），完成即更新 HANDOFF 完成清单。
