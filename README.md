QuickFile-Go
QuickFile-Go 是一个基于 Go 后端和 LuCI 前端的 OpenWrt 文件管理插件。
特点
不依赖 nginx 代理。
不依赖原版 quickfile 预编译后端。
Go 后端源码在 src/main.go，LuCI 前端源码在 htdocs/luci-static/resources/view/quickfile-go.js。
后端默认监听自动 lan:8989，浏览器从 LuCI 页面直接请求 Go API。
后端会校验 LuCI session，未登录 LuCI 时不能调用 API。
高风险操作使用 POST。
下载接口支持 LuCI session token 校验。
CORS 限制为同主机来源，不使用 Access-Control-Allow-Origin: *。
支持 /etc/config/quickfile-go 配置化管理。
已支持功能
浏览目录
上传文件
在线下载 URL 到当前目录
下载文件
新建文件 / 文件夹
删除
重命名
复制 / 剪切 / 粘贴
图片 / 视频预览
Monaco Editor 编辑体验；无法加载 Monaco 时自动回退到内置编辑器
.apk / .ipk 安装
真正实时终端：本地内置 xterm.js + 后端 /term WebSocket + Linux PTY
终端开关配置化
监听地址 / 监听端口配置化
最大上传大小 / 最大编辑大小配置化，0 表示不限制
诊断信息接口和 LuCI 设置区
当前目录搜索
网格 / 列表视图
深色 / 浅色模式
.tar.gz / .tar.xz / .zip 压缩
.zip / .tar.gz / .tgz / .tar.xz / .txz / .tar / 单文件 .gz 解压
<img width="1547" height="880" alt="image" src="https://github.com/user-attachments/assets/741449e3-2595-4c16-acbf-c515d9d883a6" />
<img width="1641" height="767" alt="image" src="https://github.com/user-attachments/assets/e00d9cda-18a1-47d4-a73f-2312aaa392a0" />
<img width="1639" height="759" alt="image" src="https://github.com/user-attachments/assets/d531a33b-90c5-4a6a-9ba3-8703db88ded3" />
