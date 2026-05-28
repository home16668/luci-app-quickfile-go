QuickFile-Go local Monaco Editor resources (trimmed edition).

This directory contains a reduced Monaco Editor build for local/offline use.
It keeps the core editor plus common OpenWrt/config/script languages, and removes
large/uncommon resources to reduce firmware size.

Kept examples:
- shell, lua, go, python, php, ruby
- html, css, javascript
- ini/conf, xml, yaml, markdown, sql, dockerfile, c/cpp
- json/html/css workers

Removed examples:
- TypeScript language service worker (large)
- uncommon basic language definitions
- most NLS bundles except zh-cn

If you need the complete Monaco package, replace this directory with a full
Monaco `min/vs` tree under:
  htdocs/luci-static/resources/quickfile-go/monaco/vs/
