/**
 * init-script — WSL 内初始化脚本的构建与部署
 *
 * 内嵌 bash 初始化脚本：安装 Xvfb/XFCE/xdotool/ffmpeg 等依赖、启动虚拟桌面、
 * 拉起 ffmpeg MJPEG 实时画面流，并以 base64 方式部署到 WSL 内。
 * 脚本内容可按 display/streamPort 参数化构建，部署逻辑本身无状态
 * （是否已部署的标记由 AgentWorkspaceManager 持有）。
 */

import { DISPLAY, WSL_STREAM_PORT, execWslRaw } from './wsl-exec'

/** 初始化脚本在 WSL 内的部署路径 */
export const WSL_INIT_SCRIPT = '/tmp/agent-workspace-init.sh'

/** 构建初始化脚本内容 — display/streamPort 由调用方注入（与 wsl-exec 常量一致） */
export function buildInitScript(display: string, streamPort: number): string {
  return `#!/bin/bash
set -e
export DEBIAN_FRONTEND=noninteractive

# 检测并安装依赖
NEED_INSTALL=0
for pkg in xvfb openbox xdotool x11-utils imagemagick x11-apps xterm ffmpeg xfce4 xfce4-terminal dbus-x11 xclip wmctrl fonts-noto-cjk pulseaudio; do
  if ! dpkg -s "$pkg" >/dev/null 2>&1; then
    NEED_INSTALL=1
    break
  fi
done

if [ "$NEED_INSTALL" -eq 1 ]; then
  apt-get update -qq 2>/dev/null
  apt-get install -y -qq xvfb openbox xdotool x11-utils imagemagick x11-apps xterm ffmpeg xfce4 xfce4-terminal dbus-x11 xclip wmctrl fonts-noto-cjk pulseaudio 2>/dev/null || true
fi

# 浏览器 — Debian 仓库包名是 firefox-esr（firefox 无候选，装了也静默失败）
apt-get install -y -qq firefox-esr 2>/dev/null || true

# 清理旧进程（重启/自愈/改分辨率重跑脚本时保证干净状态）
pkill -f "Xvfb ${display}" 2>/dev/null || true
pkill openbox 2>/dev/null || true
pkill xfwm4 2>/dev/null || true
pkill xfce4-panel 2>/dev/null || true
pkill xfdesktop 2>/dev/null || true
pkill xterm 2>/dev/null || true
pkill ffmpeg 2>/dev/null || true
sleep 0.5

# 音频 — 尽力启动 PulseAudio（虚拟声卡），避免应用因无音频设备挂起或报错
if command -v pulseaudio >/dev/null 2>&1; then
  pkill -x pulseaudio 2>/dev/null || true
  setsid pulseaudio -D --exit-idle-time=-1 </dev/null >>/tmp/agent-workspace-pulse.log 2>&1 || true
fi

# 分辨率 — 可由 set_resolution 写入配置文件后重跑本脚本生效；无配置用默认
RES=$(cat /tmp/agent-workspace-resolution 2>/dev/null | grep -E '^[0-9]{3,4}x[0-9]{3,4}$') || RES=1280x800
[ -n "$RES" ] || RES=1280x800

# 启动 Xvfb — 完整守护进程化：setsid 脱离会话树 + 三流重定向脱离调用方管道。
# 缺一不可：只 & 后台时子进程继承会话 stdio 管道，execFile 会因等不到 EOF 挂到超时，
# 超时触发会话强拆 → Xvfb 被连带杀掉 → openbox/xterm 报 "X connection broken" 死亡（桌面黑屏）
setsid Xvfb ${display} -screen 0 \${RES}x24 </dev/null >>/tmp/agent-workspace-xvfb.log 2>&1 &
XVFB_PID=$!
sleep 1.5

export DISPLAY=${display}

# XFCE 图形桌面（Windows 风格：底部任务栏 + 应用菜单 + 窗口按钮 + 桌面壁纸）
# 回退链：xfwm4 → openbox；xfce4-terminal → xterm；面板缺失不阻塞
if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)" 2>/dev/null || true
fi

# 持久化会话 dbus 地址 — 后续 exec 经 execWslDisplay source 此文件，
# xfconf/gsettings 等会话级配置才能作用于正在运行的面板
if [ -n "$DBUS_SESSION_BUS_ADDRESS" ]; then
  echo "export DBUS_SESSION_BUS_ADDRESS='$DBUS_SESSION_BUS_ADDRESS'" > /tmp/agent-workspace-env 2>/dev/null || true
fi

# 预置任务栏配置（底部单面板：应用菜单 + 窗口按钮 + 时钟），避免首次运行弹配置向导
PANEL_CFG="/root/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
if command -v xfce4-panel >/dev/null 2>&1 && [ ! -f "$PANEL_CFG" ]; then
  mkdir -p "$(dirname "$PANEL_CFG")" 2>/dev/null || true
  cat > "$PANEL_CFG" << 'PANELEOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="panels" type="empty">
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=10;x=0;y=0"/>
      <property name="size" type="uint" value="34"/>
      <property name="autohide" type="bool" value="false"/>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="4"/>
      </value>
    </property>
    <property name="panel-2" type="empty">
      <property name="autohide" type="bool" value="true"/>
      <property name="plugin-ids" type="array"/>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="applicationsmenu">
      <property name="show-button-title" type="bool" value="true"/>
    </property>
    <property name="plugin-2" type="string" value="tasklist"/>
    <property name="plugin-4" type="string" value="clock"/>
  </property>
</channel>
PANELEOF
fi

if command -v xfwm4 >/dev/null 2>&1; then
  setsid xfwm4 --replace </dev/null >>/tmp/agent-workspace-xfwm4.log 2>&1 &
else
  setsid openbox --sm-disable </dev/null >>/tmp/agent-workspace-openbox.log 2>&1 &
fi
sleep 1

command -v xfdesktop >/dev/null 2>&1 && setsid xfdesktop </dev/null >>/tmp/agent-workspace-xfdesktop.log 2>&1 &
command -v xfce4-panel >/dev/null 2>&1 && setsid xfce4-panel </dev/null >>/tmp/agent-workspace-panel.log 2>&1 &
sleep 1

# 任务栏挪到底部（Windows 风格）— 运行时经 xfconf 设置，面板实时响应；
# 预置 XML 可能被 xfconfd 以格式原因拒绝，此处是保底生效的路径
xfconf-query -c xfce4-panel -p /panels/panel-1/position -s 'p=10;x=0;y=0' 2>/dev/null || true
xfconf-query -c xfce4-panel -p /panels/panel-2/autohide -s 'true' 2>/dev/null || \
  xfconf-query -c xfce4-panel -p /panels/panel-2/autohide -n -t bool -s 'true' 2>/dev/null || true

if command -v xfce4-terminal >/dev/null 2>&1; then
  setsid xfce4-terminal --geometry 100x30+60+60 </dev/null >>/tmp/agent-workspace-xterm.log 2>&1 &
else
  setsid xterm -bg black -fg white -title "Agent Terminal" -geometry 100x30+60+60 </dev/null >>/tmp/agent-workspace-xterm.log 2>&1 &
fi
sleep 1.5

# 启动 ffmpeg MJPEG 实时画面流 — 面板 <img src="wslcam://stream"> 的数据源
setsid ffmpeg -f x11grab -framerate 10 -video_size $RES -i :99 -c:v mjpeg -q:v 5 -f mpjpeg -listen 1 http://127.0.0.1:${streamPort}/stream </dev/null >>/tmp/agent-workspace-ffmpeg.log 2>&1 &
sleep 1.5

# 存活上报（pgrep -x 按进程名，避免匹配到脚本自身的命令行文本）
STATUS=""
pgrep -x Xvfb >/dev/null && STATUS="\${STATUS}xvfb:ok," || STATUS="\${STATUS}xvfb:FAIL,"
if pgrep -x xfwm4 >/dev/null || pgrep -x openbox >/dev/null; then
  STATUS="\${STATUS}wm:ok,"
else
  STATUS="\${STATUS}wm:degraded,"
fi
pgrep -x xfce4-panel >/dev/null && STATUS="\${STATUS}panel:ok," || STATUS="\${STATUS}panel:off,"
if pgrep -x xfce4-terminal >/dev/null || pgrep -x xterm >/dev/null; then
  STATUS="\${STATUS}term:ok,"
else
  STATUS="\${STATUS}term:FAIL,"
fi
pgrep -x ffmpeg >/dev/null && STATUS="\${STATUS}stream:ok" || STATUS="\${STATUS}stream:FAIL"

echo "OK: $STATUS (Xvfb PID=$XVFB_PID)"
echo "$XVFB_PID" > /tmp/agent-workspace-xvfb.pid
`
}

/** 部署初始化脚本到 WSL 内 */
export async function deployInitScript(): Promise<void> {
  const script = buildInitScript(DISPLAY, WSL_STREAM_PORT)

  // base64 传输部署 — 不可用 heredoc：'AGENTEOF' 分隔符引号会在 wsl.exe 参数链中丢失，
  // 变成未加引号的 heredoc，脚本内 $pkg/$PANEL_CFG/$(...) 在部署时就被展开成空值（静默损坏）。
  // base64 载荷只含 [A-Za-z0-9+/=]，任何引号/变量展开层都无法破坏它
  const scriptB64 = Buffer.from(script, 'utf8').toString('base64')
  await execWslRaw(`echo ${scriptB64} | base64 -d > ${WSL_INIT_SCRIPT} && chmod +x ${WSL_INIT_SCRIPT}`)
}
