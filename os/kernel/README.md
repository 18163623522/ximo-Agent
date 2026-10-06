# 内核定制预案 — 阶段 3 才执行（阶段 1 使用 Debian 官方内核）

## 现状
阶段 1 镜像直接使用 `linux-image-amd64`（Debian 官方内核），零内核工作量。
"用 Linux 内核二次开发"的内核部分按计划推迟到阶段 3，理由：内核裁剪的收益
（体积/启动速度）远低于其维护成本（每个 Debian 内核更新都要重放配置），而
Agent OS 的核心价值（审计/回滚/沙箱）全部在用户态 + 内核开关层面即可达成。

## 阶段 3 的内核工作清单（预案）

### 1. 配置裁剪（不做源码补丁）
- 取 Debian 基线：`/boot/config-$(uname -r)` 作为起点，用 `scripts/kconfig/merge_config.sh` 叠加差分
- 必开（确认已开）：
  - `CONFIG_SECURITY_LANDLOCK=y`     # 工具进程文件系统沙箱
  - `CONFIG_BPF_SYSCALL=y` + `CONFIG_DEBUG_INFO_BTF=y`  # eBPF 审计（CO-RE）
  - `CONFIG_AUDIT=y` + `CONFIG_AUDITSYSCALL=y`          # 系统调用审计
  - `CONFIG_BLK_CGROUP=y`                            # 任务级 IO 限流
- 裁剪方向（桌面服务器形态用不到的）：蓝牙系列、Wi-Fi 驱动子集、
  大量文件系统（只留 ext4/btrfs/xfs）、老旧总线驱动
- 预期收益：镜像 -300MB 级、启动 -2~5s；非硬需求

### 2. 内核级审计管线
- eBPF（libbpf + CO-RE）跟踪 execve/openat/connect → 按 task cgroup 归组
- 事件落盘为任务时间线，经 cockpit-link 推给驾驶舱（协议 v1 新增 audit.event）

### 3. 可选补丁（仅当需要）
- Landlock 规则热更新增强（上游已够用，大概率不需要）
- 实时性（PREEMPT_RT）仅当出现"Agent 控制硬件外设"的需求

## 工作流（届时）
```
os/kernel/config/            # 差分片段（merge_config 输入）
os/kernel/build.sh           # 拉 Debian 内核源码 → merge_config → make bindeb-pkg
```
构建产物以 .deb 形式进 mkosi（Packages= 加本地 deb 或自建 APT 源）。
