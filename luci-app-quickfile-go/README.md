# QuickFile-Go

QuickFile-Go 是一个基于 Go 后端和 LuCI 前端的 OpenWrt 文件管理插件。

## 特点

- 不依赖 nginx 代理。
- 不依赖原版 quickfile 预编译后端。
- Go 后端源码在 `src/main.go`，LuCI 前端源码在 `htdocs/luci-static/resources/view/quickfile-go.js`。
- 后端默认监听 `0.0.0.0:8989`，浏览器从 LuCI 页面直接请求 Go API。
- 后端会校验 LuCI session，未登录 LuCI 时不能调用 API。
- 高风险操作使用 POST。
- 下载接口支持 LuCI session token 校验。
- CORS 限制为同主机来源，不使用 `Access-Control-Allow-Origin: *`。
- 支持 `/etc/config/quickfile-go` 配置化管理。

## 已支持功能

- 浏览目录
- 上传文件
- 在线下载 URL 到当前目录
- 下载文件
- 新建文件 / 文件夹
- 删除
- 重命名
- 复制 / 剪切 / 粘贴
- 图片 / 视频预览
- Monaco Editor 编辑体验；无法加载 Monaco 时自动回退到内置编辑器
- `.apk` / `.ipk` 安装
- 真正实时终端：本地内置 xterm.js + 后端 `/term` WebSocket + Linux PTY
- 终端开关配置化
- 监听地址 / 监听端口配置化
- 最大上传大小 / 最大编辑大小配置化，`0` 表示不限制
- 诊断信息接口和 LuCI 设置区
- 当前目录搜索
- 网格 / 列表视图
- 深色 / 浅色模式
- `.tar.gz` / `.tar.xz` / `.zip` 压缩
- `.zip` / `.tar.gz` / `.tgz` / `.tar.xz` / `.txz` / `.tar` / 单文件 `.gz` 解压

## UCI 配置

默认配置文件：

```sh
/etc/config/quickfile-go
```

默认内容：

```uci
config quickfile-go 'main'
	option enabled '1'
	option listen_addr '0.0.0.0'
	option listen_port '8989'
	option enable_terminal '1'
	option max_upload_mb '0'
	option max_edit_mb '0'
```

说明：

- `enabled`: 是否启动 quickfile-go 服务。
- `listen_addr`: 监听地址，默认 `0.0.0.0`。
- `listen_port`: 监听端口，默认 `8989`。
- `enable_terminal`: 是否启用实时终端。
- `max_upload_mb`: 最大上传大小，单位 MiB，`0` 表示不限制。
- `max_edit_mb`: 最大读取/保存编辑文件大小，单位 MiB，`0` 表示不限制。

修改配置后重启服务：

```sh
/etc/init.d/quickfile-go restart
```

也可以在 LuCI 页面里的 “设置 / 诊断” 区域保存并重启。

## 安全说明

QuickFile-Go 不使用 nginx 反代，因此 API 端口 `8989` 会在路由器上监听。请确保不要把该端口开放到 WAN。

建议：

- 不要添加 WAN 允许访问 `8989` 的防火墙规则。
- 只在可信 LAN 环境使用。
- 保持 LuCI 登录密码强度。
- 不需要终端功能时，把 `enable_terminal` 设置为 `0`。
- 若把监听端口从 `8989` 改成其他端口，当前浏览器会记录新端口；其他浏览器首次访问时仍可能需要在 URL 后加 `?qfport=新端口`。

## Monaco / 终端说明

r43 已内置 Monaco Editor 本地静态资源：

- 编译安装后 Monaco 位于：`/www/luci-static/resources/quickfile-go/monaco/vs/loader.js`
- 编辑器只加载本地 Monaco，不请求 CDN
- Monaco 加载成功时提供代码高亮、行号、搜索、自动布局、`Ctrl+S` 保存
- Monaco 异常或资源缺失时，会自动回退到内置暗色编辑器，不会卡在加载界面

r48 起终端使用本地内置 xterm.js 资源，不请求 CDN。编译安装后资源位于：

```text
/www/luci-static/resources/quickfile-go/xterm/
```

前端终端由 xterm.js 渲染，后端仍然是 `/term` WebSocket + Linux PTY，因此全屏程序、ANSI 显示、复制粘贴体验比早期手写终端更接近原版 quickfile。

终端复制/粘贴支持：

终端标题栏提供“复制 / 粘贴 / 清屏”按钮。


- 鼠标选中文本后可用浏览器菜单或 `Ctrl+C` 复制。
- 无选中文本时，`Ctrl+C` 仍然发送中断信号。
- `Ctrl+V` 或右键菜单粘贴会把剪贴板内容发送到终端。
- `Ctrl+Shift+C / Ctrl+Shift+V` 也支持复制/粘贴。

## 诊断接口

LuCI 页面提供“诊断”按钮。后端接口为：

```text
/api?action=diagnose
```

诊断信息包括：

- 版本号
- 运行状态
- PID
- 运行时间
- 监听地址/端口
- 终端是否启用
- 最大上传/编辑限制
- shell / xz / apk / opkg / ubus / uci 工具是否存在

## tar.xz 说明

`.tar.xz` 压缩/解压通过系统 `xz` 命令完成。如果系统没有 `xz`，操作会返回明确错误。可以在路由器上安装相应 xz 工具包后再使用。

## 编译

放到 OpenWrt 源码树后编译：

```sh
make package/luci-app-quickfile-go/compile V=s
```

如果你的源码树路径是 `package/network/luci-app-quickfile-go`，按实际路径调整 make 目标。

## 安装后清理 LuCI 缓存

```sh
rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null
/etc/init.d/uhttpd restart
```

## 许可证

Apache License 3.0。详见 `LICENSE`。

## 版本说明

### r39/r40 增强与审计

r39 新增上传进度条、在线下载后台任务和进度查询、文件属性接口和属性面板、右键复制路径/修改权限/查看属性，以及列表模式的大小、修改时间、权限、所有者列和排序。

r40 清理旧的同步 `remote_download` 接口和旧的 `exec` 单命令接口；终端只保留 PTY WebSocket 实时终端；同时修复上传错误响应、CORS 重复 header、大文件操作超时等问题。

### r41 大文件上传

r41 将上传接口改为流式写入，避免 Go `ParseMultipartForm` 先把大文件落到 `/tmp`。上传 2GB 这类大文件时，请确认目标目录所在分区空间足够；OpenWrt 的 `/tmp` 通常是内存 tmpfs，不适合保存大文件。

### r43/r44/r45 本地 Monaco 与审计清理

r43 起源码包内置 Monaco Editor 本地静态资源，编译安装后会放到：

```text
/www/luci-static/resources/quickfile-go/monaco/vs/loader.js
```

文件编辑器只加载本地 Monaco，不请求 CDN。Monaco 资源异常时仍会自动回退到内置暗色编辑器。

r44 修复 UCI 配置文件漏打包导致的编译失败。r45 继续清理 README 历史残留、前端重复 CSS、xterm 占位说明，并复核 Makefile、UCI、init 和 Monaco 打包路径。


## Monaco 精简版说明

r46 内置的是精简 Monaco：保留常用配置/脚本语言高亮和核心编辑体验，删除大型 TypeScript worker、多余 NLS 和不常用语言定义，以降低固件体积。若需要完整 Monaco，可替换 `htdocs/luci-static/resources/quickfile-go/monaco/vs/` 为完整 Monaco `min/vs` 树。


## r48

- 内置本地 xterm.js 终端资源。
- 复制、移动、压缩、解压改为后台任务模式。


## r50 后台下载 UI

在线下载会创建后台任务，不再弹出覆盖文件列表的进度遮罩。下载进度请点击右上角“任务”查看，下载期间可以继续浏览、编辑、上传或执行其他文件操作。


## r51 审计修复

r51 进行全量审计后修复：

- 压缩/解压任务支持更及时的取消检查；Go 原生 tar/zip/gzip 读写循环会响应任务取消。
- 修复任务表超过上限时可能误清理正在运行任务的历史问题。现在只清理已结束的旧任务，并同步清理 cancel 句柄。
- 修正 fallback 写入 `/etc/config/quickfile-go` 的权限为 `0600`。
- 同步 README 里关于本地 xterm.js 终端的说明，清理 r38 旧终端描述残留。


## r52 性能优化

- OpenWrt Go 构建加入 `-ldflags "-s -w"`，减少后端二进制符号和调试信息体积。
- 大文件上传/远程下载/归档读写缓冲提升到 1MiB，减少系统调用次数，更适合 x86/PVE 场景。
- 上传进度 UI 做节流，减少大文件上传时浏览器频繁重绘。
- 后台任务轮询间隔降低频率，复制/移动/压缩/解压默认进入后台任务中心，避免遮罩阻塞文件管理页面。
- Monaco/xterm 本地资源带版本参数，浏览器可缓存同版本资源，升级后自动刷新资源。

## r70 安装 UI 与自升级稳定性修复

- 修复通过 QuickFile-Go 安装/升级 QuickFile-Go 自身时，postinst 立即重启后台导致安装日志连接中断的问题；现在重启会延迟并脱离安装命令执行。
- 补齐浅色模式下安装日志弹窗内通用按钮的颜色，避免按钮残留深色块。
- 清理前端注释里的旧版本号残留，降低后续维护误判。


## r71 文件类型图标优化

- 优化文件列表图标：`.txt`、`.apk/.ipk`、压缩包、配置文件、代码文件、PDF、音视频等不再共用同一个默认图标。
- 新增按扩展名生成的彩色文件类型图标，列表中更容易区分软件包、文本、配置、压缩包等文件。
- 保留图片缩略图逻辑，图片仍优先显示真实缩略图。
- 修复部分常见文本/配置文件点击后无动作的问题：新增 `.cfg`、`.leases`、`.list`、`.ts`、`.csv`、`.bash/.zsh` 等自动文本编辑识别。


## r72 文件图标样式重做

- 重做文件图标绘制逻辑，不再只是同一张文件底图 + 不同标签。
- 为不同类别提供明显不同的视觉样式：
  - 软件包：箱子/包裹风格
  - 压缩包：拉链包风格
  - 配置文件：滑杆/配置项风格
  - 代码/脚本：终端窗口风格
  - 文档：文档 + 放大镜风格
  - 文本：多行文本风格
  - 音视频：独立媒体图标风格
- 图片文件仍继续显示真实缩略图。


## r73 图标轮廓优化

- 调整文件类型图标的整体轮廓，不再让大多数图标都基于同一张长方形文件纸。
- 软件包图标（APK/IPK）改为独立的立方体/方盒子风格，更符合“箱子应该是正方形”的视觉预期。
- 压缩包、配置、代码、音频、视频等类别也改为更独立的轮廓样式。
- 文本文档和常规文档继续保留纸张风格，便于和其它类别区分。
