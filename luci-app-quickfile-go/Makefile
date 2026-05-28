include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-quickfile-go
PKG_VERSION:=2.0.1
PKG_RELEASE:=73
PKG_LICENSE:=Apache-2.0 MIT

PKG_BUILD_DEPENDS:=golang/host
PKG_BUILD_PARALLEL:=1
PKG_USE_MIPS16:=0

GO_PKG:=quickfile-go

# Performance/size: drop symbol table and DWARF debug info from the Go binary.
GO_PKG_LDFLAGS:=-s -w

include $(INCLUDE_DIR)/package.mk
include $(TOPDIR)/feeds/packages/lang/golang/golang-package.mk

define Package/luci-app-quickfile-go
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=QuickFile-Go
  DEPENDS:=+luci-base +rpcd
endef

define Package/luci-app-quickfile-go/description
  LuCI file manager powered by a small Go backend with LuCI-session verification.
endef

define Build/Prepare
	$(call Build/Prepare/Default)
	$(CP) ./src/* $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(call GoPackage/Build/Compile)
endef

define Package/luci-app-quickfile-go/install
	# Backend binary
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(GO_PKG_BUILD_BIN_DIR)/quickfile-go $(1)/usr/bin/quickfile-go-api

	# LuCI frontend
	$(INSTALL_DIR) $(1)/www/luci-static/resources/view
	$(INSTALL_DATA) ./htdocs/luci-static/resources/view/quickfile-go.js $(1)/www/luci-static/resources/view/quickfile-go.js

	# Optional local frontend resources (Monaco/xterm.js can be placed under htdocs/luci-static/resources/quickfile-go/)
	if [ -d ./htdocs/luci-static/resources/quickfile-go ]; then \
		$(INSTALL_DIR) $(1)/www/luci-static/resources/quickfile-go; \
		$(CP) ./htdocs/luci-static/resources/quickfile-go/* $(1)/www/luci-static/resources/quickfile-go/; \
	fi

	# LuCI menu
	$(INSTALL_DIR) $(1)/usr/share/luci/menu.d
	$(INSTALL_DATA) ./root/usr/share/luci/menu.d/luci-app-quickfile-go.json $(1)/usr/share/luci/menu.d/luci-app-quickfile-go.json

	# LuCI ACL
	$(INSTALL_DIR) $(1)/usr/share/rpcd/acl.d
	$(INSTALL_DATA) ./root/usr/share/rpcd/acl.d/luci-app-quickfile-go.json $(1)/usr/share/rpcd/acl.d/luci-app-quickfile-go.json

	# UCI config
	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./root/etc/config/quickfile-go $(1)/etc/config/quickfile-go

	# procd service
	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./root/etc/init.d/quickfile-go $(1)/etc/init.d/quickfile-go
endef

define Package/luci-app-quickfile-go/conffiles
/etc/config/quickfile-go
endef

define Package/luci-app-quickfile-go/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/quickfile-go enable >/dev/null 2>&1 || true
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null || true
	# Detach restart so self-upgrades launched from QuickFile-Go can finish returning
	# the install log before the backend process is replaced.
	( sleep 2; /etc/init.d/quickfile-go restart >/dev/null 2>&1 || true ) >/dev/null 2>&1 </dev/null &
}
exit 0
endef

define Package/luci-app-quickfile-go/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	/etc/init.d/quickfile-go stop >/dev/null 2>&1 || true
	/etc/init.d/quickfile-go disable >/dev/null 2>&1 || true
}
exit 0
endef

define Package/luci-app-quickfile-go/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || {
	rm -f /tmp/luci-indexcache /tmp/luci-modulecache/* 2>/dev/null || true
}
exit 0
endef

$(eval $(call GoBinPackage,luci-app-quickfile-go))
$(eval $(call BuildPackage,luci-app-quickfile-go))
