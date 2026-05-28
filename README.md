# QuickFile-Go

QuickFile-Go 是一个基于 Go 后端和 LuCI 前端的 OpenWrt 文件管理插件。

## 特点

- 不依赖 nginx 代理。
- 不依赖原版 quickfile 预编译后端，完全开源。
- Go 后端源码在 `src/main.go`，LuCI 前端源码在 `htdocs/luci-static/resources/view/quickfile-go.js`。
- 后端默认自动监听 `lan:8989`，浏览器从 LuCI 页面直接请求 Go API。
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
- 支持后台任务
- 最大上传大小 / 最大编辑大小配置化，`0` 表示不限制
- 诊断信息接口和 LuCI 设置区
- 当前目录搜索
- 按照大小和时间排序
- 网格 / 列表视图
- 深色 / 浅色模式
- `.tar.gz` / `.tar.xz` / `.zip` 压缩
- `.zip` / `.tar.gz` / `.tgz` / `.tar.xz` / `.txz` / `.tar` / 单文件 `.gz` 解压



说明：

- `enabled`: 是否启动 quickfile-go 服务。
- `listen_addr`: 监听地址，默认 `lan`。
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
- 只在X86架构openwrt 25.12.2测试过，其它版本请自行测试

<img width="1547" height="880" alt="image" src="https://github.com/user-attachments/assets/741449e3-2595-4c16-acbf-c515d9d883a6" />
<img width="1641" height="767" alt="image" src="https://github.com/user-attachments/assets/e00d9cda-18a1-47d4-a73f-2312aaa392a0" />
<img width="1639" height="759" alt="image" src="https://github.com/user-attachments/assets/d531a33b-90c5-4a6a-9ba3-8703db88ded3" />
