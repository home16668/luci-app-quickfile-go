package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

const (
	appVersion            = "2.0.1-r73"
	defaultListen         = "192.168.1.1:8989"
	maxMultipartMem       = int64(16 << 20) // Spill larger uploads to a temp file instead of keeping them in memory.
	maxCommandOutput      = 256 << 10       // Keep terminal/API responses bounded.
	defaultCmdTimeout     = 30 * time.Second
	defaultFileOpTimeout  = 30 * time.Minute
	maxWSFrameBytes       = 64 << 10
	uploadCopyBufferSize  = 1 << 20 // 1 MiB buffer improves large-file throughput on x86/PVE targets.
	remoteCopyBufferSize  = 1 << 20
	archiveCopyBufferSize = 1 << 20
)

type APIResponse struct {
	Code int         `json:"code"`
	Msg  string      `json:"msg"`
	Data interface{} `json:"data,omitempty"`
}

type FileEntry struct {
	Name  string `json:"name"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	Time  int64  `json:"time"`
	Mode  string `json:"mode,omitempty"`
	Perm  string `json:"perm,omitempty"`
	Owner string `json:"owner,omitempty"`
	Group string `json:"group,omitempty"`
}

type server struct {
	enableExec     bool
	listen         string
	maxUploadBytes int64 // 0 means unlimited.
	maxEditBytes   int64 // 0 means unlimited.
	startTime      time.Time

	tasksMu     sync.Mutex
	tasks       map[string]*TaskInfo
	taskCancels map[string]context.CancelFunc
}

type TaskInfo struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Status     string `json:"status"`
	Progress   int    `json:"progress"`
	Current    int64  `json:"current"`
	Total      int64  `json:"total"`
	Message    string `json:"message"`
	Path       string `json:"path,omitempty"`
	Error      string `json:"error,omitempty"`
	Created    int64  `json:"created"`
	Updated    int64  `json:"updated"`
	Cancelable bool   `json:"cancelable,omitempty"`
}

var luciSessionCache = struct {
	sync.Mutex
	items map[string]time.Time
}{items: make(map[string]time.Time)}

func main() {
	listen := flag.String("listen", defaultListen, "HTTP listen address")
	enableExec := flag.Bool("enable-exec", true, "enable the built-in LuCI terminal endpoint after LuCI session verification")
	maxUploadMB := flag.Int64("max-upload-mb", 0, "maximum upload size in MiB; 0 means unlimited")
	maxEditMB := flag.Int64("max-edit-mb", 0, "maximum read/write editor file size in MiB; 0 means unlimited")
	flag.Parse()

	s := &server{
		enableExec:     *enableExec,
		listen:         *listen,
		maxUploadBytes: mibToBytes(*maxUploadMB),
		maxEditBytes:   mibToBytes(*maxEditMB),
		startTime:      time.Now(),
		tasks:          make(map[string]*TaskInfo),
		taskCancels:    make(map[string]context.CancelFunc),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api", s.handleAPI)
	mux.HandleFunc("/term", s.handleTerminalWS)

	h := recoverMiddleware(mux)
	srv := &http.Server{
		Addr:              *listen,
		Handler:           h,
		ReadHeaderTimeout: 5 * time.Second,
		// Do not set ReadTimeout/WriteTimeout: large uploads/downloads and slow router storage may legitimately take longer.
		IdleTimeout: 60 * time.Second,
	}

	log.Printf("quickfile-go-api %s listening on %s (terminal=%v max_upload=%s max_edit=%s)", appVersion, *listen, *enableExec, bytesLimitText(s.maxUploadBytes), bytesLimitText(s.maxEditBytes))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("quickfile-go-api stopped: %v", err)
	}
}

func mibToBytes(mib int64) int64 {
	if mib <= 0 {
		return 0
	}
	if mib > 1024*1024 {
		mib = 1024 * 1024
	}
	return mib << 20
}

func bytesToMiB(n int64) int64 {
	if n <= 0 {
		return 0
	}
	return n >> 20
}

func bytesLimitText(n int64) string {
	if n <= 0 {
		return "unlimited"
	}
	return fmt.Sprintf("%dMiB", bytesToMiB(n))
}

func recoverMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				log.Printf("panic while handling %s: %v", r.URL.String(), v)
				jsonRes(w, http.StatusInternalServerError, "服务内部错误", fmt.Sprint(v))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *server) handleAPI(w http.ResponseWriter, r *http.Request) {
	originOK := setCORS(w, r)
	if r.Method == http.MethodOptions {
		if !originOK {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if !s.authorized(r) {
		jsonRes(w, http.StatusUnauthorized, "未授权", "请先登录 LuCI，再打开 QuickFile-Go。")
		return
	}

	action := r.URL.Query().Get("action")
	switch action {
	case "diagnose":
		requireMethod(w, r, http.MethodGet, func() { s.diagnose(w, r) })
	case "config_get":
		requireMethod(w, r, http.MethodGet, func() { s.configGet(w, r) })
	case "config_set":
		requireMethod(w, r, http.MethodPost, func() { s.configSet(w, r) })
	case "list":
		requireMethod(w, r, http.MethodGet, func() { s.list(w, r) })
	case "stat":
		requireMethod(w, r, http.MethodGet, func() { s.statFile(w, r) })
	case "chmod":
		requireMethod(w, r, http.MethodPost, func() { s.chmod(w, r) })
	case "task":
		requireMethod(w, r, http.MethodGet, func() { s.taskStatus(w, r) })
	case "task_list":
		requireMethod(w, r, http.MethodGet, func() { s.taskList(w, r) })
	case "task_cancel":
		requireMethod(w, r, http.MethodPost, func() { s.taskCancel(w, r) })
	case "remote_download_start":
		requireMethod(w, r, http.MethodPost, func() { s.remoteDownloadStart(w, r) })
	case "download":
		requireMethod(w, r, http.MethodGet, func() { s.download(w, r) })
	case "read":
		requireMethod(w, r, http.MethodGet, func() { s.readFile(w, r) })
	case "create":
		requireMethod(w, r, http.MethodPost, func() { s.create(w, r) })
	case "copy":
		requireMethod(w, r, http.MethodPost, func() { s.copy(w, r) })
	case "move":
		requireMethod(w, r, http.MethodPost, func() { s.move(w, r) })
	case "rename":
		requireMethod(w, r, http.MethodPost, func() { s.rename(w, r) })
	case "compress":
		requireMethod(w, r, http.MethodPost, func() { s.compress(w, r) })
	case "extract":
		requireMethod(w, r, http.MethodPost, func() { s.extract(w, r) })
	case "upload":
		requireMethod(w, r, http.MethodPost, func() { s.upload(w, r) })
	case "delete":
		requireMethod(w, r, http.MethodPost, func() { s.delete(w, r) })
	case "install":
		requireMethod(w, r, http.MethodPost, func() { s.install(w, r) })
	case "write":
		requireMethod(w, r, http.MethodPost, func() { s.writeFile(w, r) })
	default:
		jsonRes(w, http.StatusNotFound, "未知操作", action)
	}
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string, next func()) {
	if r.Method != method {
		jsonRes(w, http.StatusMethodNotAllowed, "请求方法不允许", r.Method)
		return
	}
	next()
}

func jsonRes(w http.ResponseWriter, httpStatus int, msg string, data interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(httpStatus)
	_ = json.NewEncoder(w).Encode(APIResponse{Code: httpStatus, Msg: msg, Data: data})
}

func ok(w http.ResponseWriter, data interface{}) {
	jsonRes(w, http.StatusOK, "success", data)
}

func fail(w http.ResponseWriter, status int, msg string, err error) {
	if err == nil {
		jsonRes(w, status, msg, nil)
		return
	}
	jsonRes(w, status, msg, err.Error())
}

func setCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	if !sameHost(origin, r.Host) {
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, X-LuCI-Session")
	w.Header().Set("Vary", "Origin")
	return true
}

func sameHost(origin, requestHost string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return false
	}
	return strings.EqualFold(u.Hostname(), hostOnly(requestHost))
}

func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return strings.Trim(h, "[]")
	}
	return strings.Trim(hostport, "[]")
}

func (s *server) authorized(r *http.Request) bool {
	if origin := r.Header.Get("Origin"); origin != "" && !sameHost(origin, r.Host) {
		return false
	}
	if origin := r.Header.Get("Origin"); origin == "" {
		if ref := r.Header.Get("Referer"); ref != "" && !sameHost(ref, r.Host) {
			return false
		}
	}

	for _, token := range sessionTokensFromRequest(r) {
		if validLuCISession(token) {
			return true
		}
	}
	return false
}

func sessionTokensFromRequest(r *http.Request) []string {
	var tokens []string
	if token := strings.TrimSpace(r.Header.Get("X-LuCI-Session")); token != "" {
		tokens = append(tokens, token)
	}
	if token := strings.TrimSpace(r.URL.Query().Get("sid")); token != "" {
		tokens = append(tokens, token)
	}
	for _, c := range r.Cookies() {
		if strings.HasPrefix(c.Name, "sysauth") && c.Value != "" {
			tokens = append(tokens, c.Value)
		}
	}
	return tokens
}

func isLoopbackRemote(remote string) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func validLuCISession(token string) bool {
	if strings.ContainsAny(token, "\x00\n\r\t") || len(token) > 256 {
		return false
	}
	now := time.Now()
	luciSessionCache.Lock()
	if exp, ok := luciSessionCache.items[token]; ok && exp.After(now) {
		luciSessionCache.Unlock()
		return true
	}
	luciSessionCache.Unlock()

	payload, _ := json.Marshal(map[string]string{"ubus_rpc_session": token})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ubus", "call", "session", "get", string(payload))
	out, err := cmd.Output()
	if err != nil || len(out) == 0 {
		return false
	}
	var obj map[string]interface{}
	if err := json.Unmarshal(out, &obj); err != nil {
		return false
	}
	if _, hasError := obj["error"]; hasError {
		return false
	}
	valid := false
	for _, key := range []string{"ubus_rpc_session", "timeout", "expires", "acls", "data", "values"} {
		if _, ok := obj[key]; ok {
			valid = true
			break
		}
	}
	if valid {
		luciSessionCache.Lock()
		if len(luciSessionCache.items) > 128 {
			for k, exp := range luciSessionCache.items {
				if exp.Before(now) {
					delete(luciSessionCache.items, k)
				}
			}
		}
		luciSessionCache.items[token] = now.Add(30 * time.Second)
		luciSessionCache.Unlock()
	}
	return valid
}

func (s *server) diagnose(w http.ResponseWriter, r *http.Request) {
	listenAddr, listenPort := splitListen(s.listen)
	data := map[string]interface{}{
		"version":          appVersion,
		"running":          true,
		"pid":              os.Getpid(),
		"uptime_seconds":   int64(time.Since(s.startTime).Seconds()),
		"listen":           s.listen,
		"listen_addr":      listenAddr,
		"listen_port":      listenPort,
		"terminal_enabled": s.enableExec,
		"max_upload_mb":    bytesToMiB(s.maxUploadBytes),
		"max_edit_mb":      bytesToMiB(s.maxEditBytes),
		"limits": map[string]string{
			"upload": bytesLimitText(s.maxUploadBytes),
			"edit":   bytesLimitText(s.maxEditBytes),
		},
		"tools": map[string]string{
			"shell": firstExistingShell(),
			"xz":    lookPathText("xz"),
			"apk":   lookPathText("apk"),
			"opkg":  lookPathText("opkg"),
			"ubus":  lookPathText("ubus"),
			"uci":   lookPathText("uci"),
		},
	}
	ok(w, data)
}

func (s *server) configGet(w http.ResponseWriter, r *http.Request) {
	listenAddr, listenPort := splitListen(s.listen)
	cfg := map[string]string{
		"enabled":         uciGet("enabled", "1"),
		"listen_addr":     uciGet("listen_addr", listenAddr),
		"listen_port":     uciGet("listen_port", listenPort),
		"enable_terminal": uciGet("enable_terminal", boolToUCI(s.enableExec)),
		"max_upload_mb":   uciGet("max_upload_mb", fmt.Sprintf("%d", bytesToMiB(s.maxUploadBytes))),
		"max_edit_mb":     uciGet("max_edit_mb", fmt.Sprintf("%d", bytesToMiB(s.maxEditBytes))),
	}
	ok(w, cfg)
}

func (s *server) configSet(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	enabled := normalizeBoolForm(r.FormValue("enabled"), true)
	listenAddr := strings.TrimSpace(r.FormValue("listen_addr"))
	if listenAddr == "" {
		listenAddr = "auto"
	}
	if listenAddr != "auto" && listenAddr != "localhost" {
		ip := net.ParseIP(listenAddr)
		if ip == nil || ip.To4() == nil {
			fail(w, http.StatusBadRequest, "监听地址无效", fmt.Errorf("当前设置页支持 auto、localhost 或 IPv4: %s", listenAddr))
			return
		}
	}
	listenPort, err := normalizePort(r.FormValue("listen_port"))
	if err != nil {
		fail(w, http.StatusBadRequest, "监听端口无效", err)
		return
	}
	enableTerminal := normalizeBoolForm(r.FormValue("enable_terminal"), true)
	maxUploadMB, err := normalizeLimitMB(r.FormValue("max_upload_mb"))
	if err != nil {
		fail(w, http.StatusBadRequest, "最大上传大小无效", err)
		return
	}
	maxEditMB, err := normalizeLimitMB(r.FormValue("max_edit_mb"))
	if err != nil {
		fail(w, http.StatusBadRequest, "最大编辑大小无效", err)
		return
	}

	cfg := map[string]string{
		"enabled":         boolToUCI(enabled),
		"listen_addr":     listenAddr,
		"listen_port":     listenPort,
		"enable_terminal": boolToUCI(enableTerminal),
		"max_upload_mb":   maxUploadMB,
		"max_edit_mb":     maxEditMB,
	}
	if err := uciSaveConfig(cfg); err != nil {
		fail(w, http.StatusInternalServerError, "保存配置失败", err)
		return
	}
	if normalizeBoolForm(r.FormValue("restart"), false) {
		go func() {
			time.Sleep(350 * time.Millisecond)
			_ = exec.Command("/etc/init.d/quickfile-go", "restart").Run()
		}()
		ok(w, "配置已保存，服务正在重启")
		return
	}
	ok(w, "配置已保存，重启 quickfile-go 后生效")
}

func splitListen(listen string) (string, string) {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		idx := strings.LastIndex(listen, ":")
		if idx > 0 && idx < len(listen)-1 {
			return listen[:idx], listen[idx+1:]
		}
		return "0.0.0.0", "8989"
	}
	if host == "" {
		host = "0.0.0.0"
	}
	return strings.Trim(host, "[]"), port
}

func lookPathText(name string) string {
	p, err := exec.LookPath(name)
	if err != nil {
		return "missing"
	}
	return p
}

func boolToUCI(v bool) string {
	if v {
		return "1"
	}
	return "0"
}

func normalizeBoolForm(v string, def bool) bool {
	v = strings.ToLower(strings.TrimSpace(v))
	switch v {
	case "1", "true", "yes", "on", "enabled":
		return true
	case "0", "false", "no", "off", "disabled":
		return false
	case "":
		return def
	default:
		return def
	}
}

func normalizePort(v string) (string, error) {
	v = strings.TrimSpace(v)
	var port uint64
	if _, err := fmt.Sscanf(v, "%d", &port); err != nil || port == 0 || port > 65535 {
		return "", fmt.Errorf("端口必须是 1-65535")
	}
	return fmt.Sprintf("%d", port), nil
}

func normalizeLimitMB(v string) (string, error) {
	v = strings.TrimSpace(v)
	if v == "" {
		return "0", nil
	}
	var n uint64
	if _, err := fmt.Sscanf(v, "%d", &n); err != nil || n > 1048576 {
		return "", fmt.Errorf("大小必须是 0-1048576 MiB，0 表示不限制")
	}
	return fmt.Sprintf("%d", n), nil
}

func uciGet(option, def string) string {
	out, err := exec.Command("uci", "-q", "get", "quickfile-go.main."+option).Output()
	if err != nil {
		return def
	}
	v := strings.TrimSpace(string(out))
	if v == "" {
		return def
	}
	return v
}

func uciSaveConfig(cfg map[string]string) error {
	if _, err := exec.LookPath("uci"); err != nil {
		return writeUCIConfigFile(cfg)
	}
	var batch strings.Builder
	batch.WriteString("set quickfile-go.main='quickfile-go'\n")
	for _, key := range []string{"enabled", "listen_addr", "listen_port", "enable_terminal", "max_upload_mb", "max_edit_mb"} {
		batch.WriteString(fmt.Sprintf("set quickfile-go.main.%s='%s'\n", key, shellSingleQuoteEscape(cfg[key])))
	}
	batch.WriteString("commit quickfile-go\n")
	cmd := exec.Command("uci", "batch")
	cmd.Stdin = strings.NewReader(batch.String())
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v\n%s", err, out)
	}
	return nil
}

func shellSingleQuoteEscape(v string) string {
	return strings.ReplaceAll(v, "'", "'\\''")
}

func writeUCIConfigFile(cfg map[string]string) error {
	var b strings.Builder
	b.WriteString("config quickfile-go 'main'\n")
	for _, key := range []string{"enabled", "listen_addr", "listen_port", "enable_terminal", "max_upload_mb", "max_edit_mb"} {
		b.WriteString(fmt.Sprintf("\toption %s '%s'\n", key, shellSingleQuoteEscape(cfg[key])))
	}
	return os.WriteFile("/etc/config/quickfile-go", []byte(b.String()), 0600)
}

func (s *server) list(w http.ResponseWriter, r *http.Request) {
	dir, err := cleanAbs(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		fail(w, http.StatusForbidden, "无法读取目录", err)
		return
	}
	files := make([]FileEntry, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		owner, group := ownerGroup(info)
		files = append(files, FileEntry{
			Name:  e.Name(),
			IsDir: e.IsDir(),
			Size:  info.Size(),
			Time:  info.ModTime().Unix(),
			Mode:  info.Mode().String(),
			Perm:  fmt.Sprintf("%04o", uint32(info.Mode().Perm())),
			Owner: owner,
			Group: group,
		})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].IsDir != files[j].IsDir {
			return files[i].IsDir
		}
		return strings.ToLower(files[i].Name) < strings.ToLower(files[j].Name)
	})
	ok(w, files)
}

func (s *server) statFile(w http.ResponseWriter, r *http.Request) {
	path, err := cleanAbs(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	info, err := os.Lstat(path)
	if err != nil {
		fail(w, http.StatusNotFound, "文件不存在", err)
		return
	}
	ok(w, fileInfoMap(path, info))
}

func (s *server) chmod(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	path, err := cleanAbs(r.FormValue("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	modeText := strings.TrimSpace(r.FormValue("mode"))
	if len(modeText) != 3 && len(modeText) != 4 {
		fail(w, http.StatusBadRequest, "权限格式错误，请输入如 644、755 或 0000", nil)
		return
	}
	for _, ch := range modeText {
		if ch < '0' || ch > '7' {
			fail(w, http.StatusBadRequest, "权限格式错误，请输入八进制权限", nil)
			return
		}
	}
	v, err := strconv.ParseUint(modeText, 8, 32)
	if err != nil || v > 07777 {
		fail(w, http.StatusBadRequest, "权限格式错误，请输入如 644、755 或 0000", err)
		return
	}
	if err := os.Chmod(path, os.FileMode(v)); err != nil {
		fail(w, http.StatusForbidden, "修改权限失败", err)
		return
	}
	ok(w, nil)
}

func ownerGroup(info os.FileInfo) (string, string) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st == nil {
		return "", ""
	}
	return strconv.FormatUint(uint64(st.Uid), 10), strconv.FormatUint(uint64(st.Gid), 10)
}

func fileInfoMap(path string, info os.FileInfo) map[string]interface{} {
	owner, group := ownerGroup(info)
	kind := "file"
	if info.IsDir() {
		kind = "directory"
	} else if info.Mode()&os.ModeSymlink != 0 {
		kind = "symlink"
	}
	return map[string]interface{}{
		"path":  path,
		"name":  filepath.Base(path),
		"type":  kind,
		"isDir": info.IsDir(),
		"size":  info.Size(),
		"time":  info.ModTime().Unix(),
		"mtime": info.ModTime().Format(time.RFC3339),
		"mode":  info.Mode().String(),
		"perm":  fmt.Sprintf("%04o", uint32(info.Mode().Perm())),
		"owner": owner,
		"group": group,
	}
}

func (s *server) download(w http.ResponseWriter, r *http.Request) {
	path, err := cleanAbs(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		fail(w, http.StatusNotFound, "文件不存在", err)
		return
	}
	if info.IsDir() {
		fail(w, http.StatusBadRequest, "目录不能直接下载", nil)
		return
	}
	name := filepath.Base(path)
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
	http.ServeFile(w, r, path)
}

func (s *server) readFile(w http.ResponseWriter, r *http.Request) {
	path, err := cleanAbs(r.URL.Query().Get("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		fail(w, http.StatusNotFound, "文件不存在", err)
		return
	}
	if info.IsDir() {
		fail(w, http.StatusBadRequest, "不能读取目录", nil)
		return
	}
	if s.maxEditBytes > 0 && info.Size() > s.maxEditBytes {
		fail(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("文件超过 %d MiB，已拒绝直接编辑", bytesToMiB(s.maxEditBytes)), nil)
		return
	}
	content, err := os.ReadFile(path)
	if err != nil {
		fail(w, http.StatusForbidden, "读取失败", err)
		return
	}
	ok(w, string(content))
}

func (s *server) writeFile(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	path, err := cleanAbs(r.FormValue("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	content := r.FormValue("content")
	if s.maxEditBytes > 0 && int64(len(content)) > s.maxEditBytes {
		fail(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("内容超过 %d MiB", bytesToMiB(s.maxEditBytes)), nil)
		return
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		fail(w, http.StatusForbidden, "保存失败", err)
		return
	}
	ok(w, nil)
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	path, err := cleanAbs(r.FormValue("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	if r.FormValue("isDir") == "true" {
		if err := os.MkdirAll(path, 0755); err != nil {
			fail(w, http.StatusForbidden, "创建文件夹失败", err)
			return
		}
		ok(w, nil)
		return
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		fail(w, http.StatusForbidden, "创建文件失败", err)
		return
	}
	_ = f.Close()
	ok(w, nil)
}

func (s *server) copy(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	src, dst, err := srcDstFromForm(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	t := s.startFileCopyTask("copy", "复制", src, dst, false)
	ok(w, t)
}

func (s *server) move(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	src, dst, err := srcDstFromForm(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	t := s.startFileCopyTask("move", "移动", src, dst, true)
	ok(w, t)
}

func (s *server) rename(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	src, dst, err := srcDstFromForm(r)
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	if err := os.Rename(src, dst); err != nil {
		fail(w, http.StatusInternalServerError, "重命名失败", err)
		return
	}
	ok(w, dst)
}

func (s *server) compress(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	srcPath, err := cleanAbs(r.FormValue("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	if _, err := os.Lstat(srcPath); err != nil {
		fail(w, http.StatusNotFound, "源文件不存在", err)
		return
	}
	format, err := normalizeArchiveFormat(r.FormValue("format"))
	if err != nil {
		fail(w, http.StatusBadRequest, "压缩格式不支持", err)
		return
	}
	dest := uniquePath(srcPath + "." + archiveExt(format))
	t := s.newTask("compress", "准备压缩")
	ctx, cancel := context.WithCancel(context.Background())
	s.setTaskCancel(t.ID, cancel)
	go func() {
		defer s.clearTaskCancel(t.ID)
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "running"
			t.Progress = 5
			t.Message = "正在压缩 " + filepath.Base(srcPath)
		})
		select {
		case <-ctx.Done():
			s.markTaskCancelled(t.ID)
			return
		default:
		}
		if err := createArchive(ctx, srcPath, dest, format); err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				s.markTaskCancelled(t.ID)
				return
			}
			s.updateTask(t.ID, func(t *TaskInfo) { t.Status = "error"; t.Error = err.Error(); t.Message = "压缩失败" })
			return
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			_ = os.Remove(dest)
			s.markTaskCancelled(t.ID)
			return
		}
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "done"
			t.Progress = 100
			t.Path = dest
			t.Message = "已压缩到 " + dest
		})
	}()
	ok(w, t)
}

func (s *server) extract(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	path, err := cleanAbs(r.FormValue("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	destDir := filepath.Dir(path)
	t := s.newTask("extract", "准备解压")
	ctx, cancel := context.WithCancel(context.Background())
	s.setTaskCancel(t.ID, cancel)
	go func() {
		defer s.clearTaskCancel(t.ID)
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "running"
			t.Progress = 5
			t.Message = "正在解压 " + filepath.Base(path)
		})
		select {
		case <-ctx.Done():
			s.markTaskCancelled(t.ID)
			return
		default:
		}
		if err := extractArchive(ctx, path, destDir); err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				s.markTaskCancelled(t.ID)
				return
			}
			s.updateTask(t.ID, func(t *TaskInfo) { t.Status = "error"; t.Error = err.Error(); t.Message = "解压失败" })
			return
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			s.markTaskCancelled(t.ID)
			return
		}
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "done"
			t.Progress = 100
			t.Path = destDir
			t.Message = "已解压到 " + destDir
		})
	}()
	ok(w, t)
}

func (s *server) upload(w http.ResponseWriter, r *http.Request) {
	// Stream multipart uploads directly to the target filesystem.
	// Do not use ParseMultipartForm/FormFile here: for multi-GB uploads Go would
	// first spill the file to os.TempDir() (often /tmp tmpfs on OpenWrt), then copy
	// it again, causing disk/RAM exhaustion and long connection timeouts.
	if s.maxUploadBytes > 0 {
		// Allow multipart framing overhead in addition to the configured file payload limit.
		r.Body = http.MaxBytesReader(w, r.Body, s.maxUploadBytes+maxMultipartMem)
	}

	destDirRaw := strings.TrimSpace(r.URL.Query().Get("path"))
	var destDir string
	if destDirRaw != "" {
		var err error
		destDir, err = cleanAbs(destDirRaw)
		if err != nil {
			fail(w, http.StatusBadRequest, "路径错误", err)
			return
		}
	}

	mr, err := r.MultipartReader()
	if err != nil {
		fail(w, http.StatusBadRequest, "上传请求格式错误", err)
		return
	}

	uploaded := false
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fail(w, http.StatusBadRequest, "读取上传数据失败", err)
			return
		}

		name := part.FormName()
		if name == "path" && destDir == "" {
			b, err := io.ReadAll(io.LimitReader(part, 4096))
			_ = part.Close()
			if err != nil {
				fail(w, http.StatusBadRequest, "读取上传路径失败", err)
				return
			}
			destDir, err = cleanAbs(string(b))
			if err != nil {
				fail(w, http.StatusBadRequest, "路径错误", err)
				return
			}
			continue
		}

		if name != "file" {
			_, _ = io.Copy(io.Discard, part)
			_ = part.Close()
			continue
		}
		if destDir == "" {
			_ = part.Close()
			fail(w, http.StatusBadRequest, "缺少上传目标路径", nil)
			return
		}
		if err := s.saveUploadedPart(destDir, part); err != nil {
			_ = part.Close()
			var status = http.StatusInternalServerError
			if errors.Is(err, errUploadTooLarge) {
				status = http.StatusRequestEntityTooLarge
			} else if errors.Is(err, errBadUploadName) {
				status = http.StatusBadRequest
			} else if errors.Is(err, errUploadWriteForbidden) {
				status = http.StatusForbidden
			}
			fail(w, status, friendlyUploadError(err), nil)
			return
		}
		_ = part.Close()
		uploaded = true
	}
	if !uploaded {
		fail(w, http.StatusBadRequest, "没有收到文件", nil)
		return
	}
	ok(w, nil)
}

var (
	errUploadTooLarge       = errors.New("上传文件超过大小限制")
	errBadUploadName        = errors.New("上传文件名非法")
	errUploadWriteForbidden = errors.New("无法写入目标目录或文件")
)

func friendlyUploadError(err error) string {
	if err == nil {
		return "上传失败"
	}
	if errors.Is(err, errUploadTooLarge) {
		return err.Error()
	}
	if errors.Is(err, errBadUploadName) {
		return "上传失败：文件名非法，请检查文件名是否包含 /、\\ 或空字符"
	}
	s := strings.ToLower(err.Error())
	if strings.Contains(s, "no space left") {
		return "上传失败：目标磁盘空间不足，请换到 /mnt 下空间更大的目录"
	}
	if strings.Contains(s, "permission denied") || strings.Contains(s, "operation not permitted") {
		return "上传失败：权限不足，无法写入当前目录"
	}
	if strings.Contains(s, "no such file") || strings.Contains(s, "not a directory") {
		return "上传失败：目标目录不存在或不是目录"
	}
	if strings.Contains(s, "file exists") {
		return "上传失败：目标文件已存在或无法覆盖"
	}
	if strings.Contains(s, "unexpected eof") || strings.Contains(s, "connection reset") || strings.Contains(s, "broken pipe") {
		return "上传失败：连接中断或上传未完成"
	}
	return "上传失败：" + err.Error()
}

func (s *server) saveUploadedPart(destDir string, part *multipart.Part) error {
	name, err := safeName(part.FileName())
	if err != nil {
		return fmt.Errorf("%w: %v", errBadUploadName, err)
	}
	if info, err := os.Stat(destDir); err != nil {
		return fmt.Errorf("%w: %v", errUploadWriteForbidden, err)
	} else if !info.IsDir() {
		return fmt.Errorf("%w: 目标不是目录", errUploadWriteForbidden)
	}
	dest := filepath.Join(destDir, name)
	if err := ensureNoSymlinkInPath(destDir, dest); err != nil {
		return fmt.Errorf("%w: %v", errUploadWriteForbidden, err)
	}

	tmp, err := os.CreateTemp(destDir, ".quickfile-upload-*.part")
	if err != nil {
		return fmt.Errorf("%w: %v", errUploadWriteForbidden, err)
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmpName)
		}
	}()

	var written int64
	buf := make([]byte, uploadCopyBufferSize)
	for {
		n, readErr := part.Read(buf)
		if n > 0 {
			written += int64(n)
			if s.maxUploadBytes > 0 && written > s.maxUploadBytes {
				_ = tmp.Close()
				return fmt.Errorf("%w: 超过 %d MiB", errUploadTooLarge, bytesToMiB(s.maxUploadBytes))
			}
			if _, err := tmp.Write(buf[:n]); err != nil {
				_ = tmp.Close()
				return fmt.Errorf("%w: %v", errUploadWriteForbidden, err)
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			_ = tmp.Close()
			return readErr
		}
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("%w: %v", errUploadWriteForbidden, err)
	}
	if err := os.Chmod(tmpName, 0644); err != nil {
		return fmt.Errorf("%w: %v", errUploadWriteForbidden, err)
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return fmt.Errorf("%w: %v", errUploadWriteForbidden, err)
	}
	ok = true
	return nil
}

func (s *server) remoteDownloadStart(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	rawURL := strings.TrimSpace(r.FormValue("url"))
	if rawURL == "" {
		fail(w, http.StatusBadRequest, "URL 不能为空", nil)
		return
	}
	destDir, err := cleanAbs(r.FormValue("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	info, err := os.Stat(destDir)
	if err != nil || !info.IsDir() {
		fail(w, http.StatusBadRequest, "目标目录不存在", err)
		return
	}
	name := strings.TrimSpace(r.FormValue("name"))
	t := s.newTask("remote_download", "准备下载")
	ctx, cancel := context.WithCancel(context.Background())
	s.setTaskCancel(t.ID, cancel)
	go func() {
		defer s.clearTaskCancel(t.ID)
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "running"
			t.Message = "正在连接"
		})
		dest, err := downloadRemoteFileWithTask(ctx, rawURL, destDir, name, func(current, total int64, msg string) {
			s.updateTask(t.ID, func(t *TaskInfo) {
				t.Current = current
				t.Total = total
				if total > 0 {
					t.Progress = int(current * 100 / total)
					if t.Progress > 99 {
						t.Progress = 99
					}
				}
				if msg != "" {
					t.Message = msg
				}
			})
		})
		if err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				s.markTaskCancelled(t.ID)
				return
			}
			s.updateTask(t.ID, func(t *TaskInfo) {
				t.Status = "error"
				t.Error = err.Error()
				t.Message = "下载失败"
			})
			return
		}
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "done"
			t.Progress = 100
			t.Path = dest
			t.Message = "已下载到 " + dest
		})
	}()
	ok(w, t)
}

func (s *server) taskStatus(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.URL.Query().Get("id"))
	if id == "" {
		fail(w, http.StatusBadRequest, "任务 ID 不能为空", nil)
		return
	}
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	t, found := s.tasks[id]
	if !found {
		fail(w, http.StatusNotFound, "任务不存在", nil)
		return
	}
	cp := *t
	ok(w, cp)
}

func (s *server) newTask(taskType, message string) *TaskInfo {
	now := time.Now()
	sum := sha1.Sum([]byte(fmt.Sprintf("%d-%s", now.UnixNano(), taskType)))
	id := base64.RawURLEncoding.EncodeToString(sum[:])[:16]
	t := &TaskInfo{ID: id, Type: taskType, Status: "queued", Message: message, Created: now.Unix(), Updated: now.Unix()}
	s.tasksMu.Lock()
	s.tasks[id] = t
	// Keep the in-memory task table bounded without dropping running/cancellable jobs.
	// Older versions could evict an active job from the UI while its cancel function remained alive.
	if len(s.tasks) > 100 {
		var oldestID string
		var oldest int64 = now.Unix()
		for id, task := range s.tasks {
			if task.Status == "running" || task.Status == "queued" || task.Status == "cancelling" || task.Cancelable {
				continue
			}
			if task.Updated <= oldest {
				oldest = task.Updated
				oldestID = id
			}
		}
		if oldestID != "" {
			delete(s.tasks, oldestID)
			delete(s.taskCancels, oldestID)
		}
	}
	s.tasksMu.Unlock()
	return t
}

func (s *server) updateTask(id string, fn func(*TaskInfo)) {
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	if t, ok := s.tasks[id]; ok {
		fn(t)
		t.Updated = time.Now().Unix()
	}
}

func (s *server) taskList(w http.ResponseWriter, r *http.Request) {
	s.tasksMu.Lock()
	items := make([]TaskInfo, 0, len(s.tasks))
	for _, t := range s.tasks {
		cp := *t
		items = append(items, cp)
	}
	s.tasksMu.Unlock()
	sort.Slice(items, func(i, j int) bool { return items[i].Updated > items[j].Updated })
	ok(w, items)
}

func (s *server) taskCancel(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	id := strings.TrimSpace(firstNonEmpty(r.FormValue("id"), r.URL.Query().Get("id")))
	if id == "" {
		fail(w, http.StatusBadRequest, "任务 ID 不能为空", nil)
		return
	}
	s.tasksMu.Lock()
	cancel, okCancel := s.taskCancels[id]
	_, okTask := s.tasks[id]
	s.tasksMu.Unlock()
	if !okTask {
		fail(w, http.StatusNotFound, "任务不存在", nil)
		return
	}
	if okCancel && cancel != nil {
		cancel()
	}
	s.updateTask(id, func(t *TaskInfo) {
		if t.Status == "done" || t.Status == "error" || t.Status == "cancelled" {
			return
		}
		t.Status = "cancelling"
		t.Message = "正在取消任务，部分归档/系统命令会在安全点结束"
	})
	ok(w, map[string]string{"id": id, "status": "cancelling"})
}

func (s *server) setTaskCancel(id string, cancel context.CancelFunc) {
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	if s.taskCancels == nil {
		s.taskCancels = make(map[string]context.CancelFunc)
	}
	s.taskCancels[id] = cancel
	if t, ok := s.tasks[id]; ok {
		t.Cancelable = true
		t.Updated = time.Now().Unix()
	}
}

func (s *server) clearTaskCancel(id string) {
	s.tasksMu.Lock()
	defer s.tasksMu.Unlock()
	delete(s.taskCancels, id)
	if t, ok := s.tasks[id]; ok {
		t.Cancelable = false
		t.Updated = time.Now().Unix()
	}
}

func (s *server) markTaskCancelled(id string) {
	s.updateTask(id, func(t *TaskInfo) {
		t.Status = "cancelled"
		t.Progress = 0
		t.Message = "任务已取消"
	})
}

func (s *server) startFileCopyTask(taskType, title, src, dst string, move bool) *TaskInfo {
	t := s.newTask(taskType, "准备"+title)
	ctx, cancel := context.WithCancel(context.Background())
	s.setTaskCancel(t.ID, cancel)
	go func() {
		defer s.clearTaskCancel(t.ID)
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "running"
			t.Progress = 1
			t.Message = "正在统计文件大小"
		})

		total, err := measureCopySize(src, dst)
		if err != nil {
			s.updateTask(t.ID, func(t *TaskInfo) {
				t.Status = "error"
				t.Error = err.Error()
				t.Message = title + "失败"
			})
			return
		}

		// Same-filesystem move can be completed atomically and quickly.
		// Cross-device moves fall back to recursive copy + delete with byte progress.
		if move {
			if err := os.Rename(src, dst); err == nil {
				s.updateTask(t.ID, func(t *TaskInfo) {
					t.Status = "done"
					t.Progress = 100
					t.Current = total
					t.Total = total
					t.Path = filepath.Dir(dst)
					t.Message = "已移动到 " + dst
				})
				return
			} else if !errors.Is(err, syscall.EXDEV) {
				// Some filesystems return other errors when target exists or permissions fail; do not hide them.
				if ctx.Err() != nil {
					s.markTaskCancelled(t.ID)
					return
				}
				s.updateTask(t.ID, func(t *TaskInfo) {
					t.Status = "error"
					t.Error = err.Error()
					t.Message = "移动失败"
				})
				return
			}
		}

		var copied int64
		progress := func(current, total int64, msg string) {
			if total <= 0 {
				total = 1
			}
			pct := int(current * 100 / total)
			if pct < 1 {
				pct = 1
			}
			if pct > 99 {
				pct = 99
			}
			s.updateTask(t.ID, func(t *TaskInfo) {
				t.Current = current
				t.Total = total
				t.Progress = pct
				if msg != "" {
					t.Message = msg
				}
			})
		}
		err = copyRecursiveWithProgress(ctx, src, dst, total, &copied, progress)
		if err != nil {
			_ = os.RemoveAll(dst)
			if errors.Is(ctx.Err(), context.Canceled) {
				s.markTaskCancelled(t.ID)
				return
			}
			s.updateTask(t.ID, func(t *TaskInfo) {
				t.Status = "error"
				t.Error = err.Error()
				t.Message = title + "失败"
			})
			return
		}

		if move {
			if err := os.RemoveAll(src); err != nil {
				s.updateTask(t.ID, func(t *TaskInfo) {
					t.Status = "error"
					t.Error = err.Error()
					t.Message = "移动失败：复制完成但删除源文件失败"
				})
				return
			}
		}

		msg := "已复制到 " + dst
		if move {
			msg = "已移动到 " + dst
		}
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "done"
			t.Progress = 100
			t.Current = total
			t.Total = total
			t.Path = filepath.Dir(dst)
			t.Message = msg
		})
	}()
	return t
}

func (s *server) startCommandTask(taskType, title string, args []string, refreshPath string, doneMsg func() string) *TaskInfo {
	t := s.newTask(taskType, "准备"+title)
	ctx, cancel := context.WithCancel(context.Background())
	s.setTaskCancel(t.ID, cancel)
	go func() {
		defer s.clearTaskCancel(t.ID)
		if len(args) == 0 {
			s.updateTask(t.ID, func(t *TaskInfo) { t.Status = "error"; t.Error = "空命令"; t.Message = title + "失败" })
			return
		}
		s.updateTask(t.ID, func(t *TaskInfo) {
			t.Status = "running"
			t.Progress = 10
			t.Message = "正在" + title + "，大文件/目录可能需要较长时间"
		})
		cmd := exec.CommandContext(ctx, args[0], args[1:]...)
		var out bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &out
		if err := cmd.Run(); err != nil {
			if errors.Is(ctx.Err(), context.Canceled) {
				s.markTaskCancelled(t.ID)
				return
			}
			s.updateTask(t.ID, func(t *TaskInfo) {
				t.Status = "error"
				t.Error = strings.TrimSpace(out.String() + "\n" + err.Error())
				t.Message = title + "失败"
			})
			return
		}
		msg := title + "完成"
		if doneMsg != nil {
			msg = doneMsg()
		}
		s.updateTask(t.ID, func(t *TaskInfo) { t.Status = "done"; t.Progress = 100; t.Path = refreshPath; t.Message = msg })
	}()
	return t
}

func (s *server) delete(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	path, err := cleanAbs(firstNonEmpty(r.FormValue("path"), r.URL.Query().Get("path")))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	if protectedDeletePath(path) {
		fail(w, http.StatusBadRequest, "拒绝删除关键路径", fmt.Errorf("%s", path))
		return
	}
	if err := os.RemoveAll(path); err != nil {
		fail(w, http.StatusForbidden, "删除失败", err)
		return
	}
	ok(w, nil)
}

func (s *server) install(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxMultipartMem); err != nil {
		fail(w, http.StatusBadRequest, "参数错误", err)
		return
	}
	pkgPath, err := cleanAbs(r.FormValue("path"))
	if err != nil {
		fail(w, http.StatusBadRequest, "路径错误", err)
		return
	}
	if _, err := os.Stat(pkgPath); err != nil {
		fail(w, http.StatusNotFound, "安装包不存在", err)
		return
	}

	ext := strings.ToLower(filepath.Ext(pkgPath))
	if ext != ".apk" && ext != ".ipk" {
		fail(w, http.StatusBadRequest, "只支持安装 .apk / .ipk", nil)
		return
	}

	if r.FormValue("stream") == "1" {
		s.installStream(w, r, pkgPath, ext)
		return
	}

	var out []byte
	switch ext {
	case ".apk":
		out, err = installAPK(pkgPath)
	case ".ipk":
		out, err = installIPK(pkgPath)
	}
	if err != nil {
		fail(w, http.StatusInternalServerError, "安装失败", fmt.Errorf("%v\n%s", err, out))
		return
	}
	ok(w, string(out))
}

func (s *server) installStream(w http.ResponseWriter, r *http.Request, pkgPath string, ext string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		fail(w, http.StatusInternalServerError, "当前 Web 服务不支持实时日志输出", nil)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	var emitMu sync.Mutex
	emit := func(text string) {
		emitMu.Lock()
		defer emitMu.Unlock()
		_, _ = io.WriteString(w, text)
		flusher.Flush()
	}
	emitf := func(format string, args ...interface{}) {
		emit(fmt.Sprintf(format, args...))
	}

	emitf("QuickFile-Go %s 软件包安装日志\n", appVersion)
	emitf("文件名: %s\n", filepath.Base(pkgPath))
	emitf("完整路径: %s\n", pkgPath)
	emit("提示: 这是 root 权限安装操作，会修改系统软件包/依赖。\n\n")

	var err error
	switch ext {
	case ".apk":
		err = installAPKStream(r.Context(), pkgPath, emit)
	case ".ipk":
		err = installIPKStream(r.Context(), pkgPath, emit)
	default:
		err = errors.New("只支持安装 .apk / .ipk")
	}

	if err != nil {
		emitf("\n[QuickFile-Go] 安装失败: %v\n", err)
		emit("__QF_INSTALL_STATUS__:FAIL\n")
		return
	}
	emit("\n[QuickFile-Go] 安装成功。\n")
	emit("__QF_INSTALL_STATUS__:OK\n")
}

func (s *server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	if !s.enableExec {
		http.Error(w, "terminal disabled", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && !sameHost(origin, r.Host) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if !s.authorized(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	conn, err := acceptWebSocket(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer conn.Close()

	workDir := "/"
	if p := r.URL.Query().Get("path"); p != "" {
		if cleaned, err := cleanAbs(p); err == nil {
			if st, err := os.Stat(cleaned); err == nil && st.IsDir() {
				workDir = cleaned
			} else {
				workDir = filepath.Dir(cleaned)
			}
		}
	}

	cols, rows := parseTerminalSize(r.URL.Query().Get("cols"), r.URL.Query().Get("rows"))
	ptyFile, slaveFile, err := openPTY(cols, rows)
	if err != nil {
		_ = writeWSFrame(conn, wsOpcodeText, []byte("\r\n[QuickFile-Go] 打开 PTY 失败: "+err.Error()+"\r\n"))
		return
	}
	defer ptyFile.Close()
	defer slaveFile.Close()

	shell := firstExistingShell()
	cmd := exec.Command(shell)
	cmd.Dir = workDir
	cmd.Env = terminalEnv(cols, rows)
	cmd.Stdin = slaveFile
	cmd.Stdout = slaveFile
	cmd.Stderr = slaveFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		_ = writeWSFrame(conn, wsOpcodeText, []byte("\r\n[QuickFile-Go] 启动 shell 失败: "+err.Error()+"\r\n"))
		return
	}
	_ = slaveFile.Close()

	done := make(chan struct{})
	var writeMu sync.Mutex
	go func() {
		defer close(done)
		buf := make([]byte, 4096)
		for {
			n, err := ptyFile.Read(buf)
			if n > 0 {
				writeMu.Lock()
				werr := writeWSFrame(conn, wsOpcodeBinary, buf[:n])
				writeMu.Unlock()
				if werr != nil {
					return
				}
			}
			if err != nil {
				return
			}
		}
	}()

	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			op, payload, err := readWSFrame(conn)
			if err != nil {
				return
			}
			switch op {
			case wsOpcodeText, wsOpcodeBinary:
				if tryTerminalControl(payload, ptyFile) {
					continue
				}
				if len(payload) > 0 {
					_, _ = ptyFile.Write(payload)
				}
			case wsOpcodeClose:
				writeMu.Lock()
				_ = writeWSFrame(conn, wsOpcodeClose, nil)
				writeMu.Unlock()
				return
			case wsOpcodePing:
				writeMu.Lock()
				_ = writeWSFrame(conn, wsOpcodePong, payload)
				writeMu.Unlock()
			}
		}
	}()

	select {
	case <-done:
	case <-readDone:
	}
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	_ = ptyFile.Close()
	_, _ = cmd.Process.Wait()
}

const (
	wsOpcodeText   = 1
	wsOpcodeBinary = 2
	wsOpcodeClose  = 8
	wsOpcodePing   = 9
	wsOpcodePong   = 10
)

func acceptWebSocket(w http.ResponseWriter, r *http.Request) (net.Conn, error) {
	if !headerContains(r.Header.Get("Connection"), "upgrade") || !strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		return nil, errors.New("not a websocket upgrade request")
	}
	key := strings.TrimSpace(r.Header.Get("Sec-WebSocket-Key"))
	if key == "" {
		return nil, errors.New("missing Sec-WebSocket-Key")
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		return nil, errors.New("http hijacking is not supported")
	}
	conn, rw, err := hj.Hijack()
	if err != nil {
		return nil, err
	}
	acceptRaw := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	accept := base64.StdEncoding.EncodeToString(acceptRaw[:])
	_, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n")
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if err := rw.Flush(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
}

func headerContains(value, needle string) bool {
	needle = strings.ToLower(needle)
	for _, part := range strings.Split(value, ",") {
		if strings.ToLower(strings.TrimSpace(part)) == needle {
			return true
		}
	}
	return false
}

func readWSFrame(conn net.Conn) (byte, []byte, error) {
	var hdr [2]byte
	if _, err := io.ReadFull(conn, hdr[:]); err != nil {
		return 0, nil, err
	}
	opcode := hdr[0] & 0x0f
	masked := hdr[1]&0x80 != 0
	length := uint64(hdr[1] & 0x7f)
	switch length {
	case 126:
		var b [2]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return 0, nil, err
		}
		length = uint64(binary.BigEndian.Uint16(b[:]))
	case 127:
		var b [8]byte
		if _, err := io.ReadFull(conn, b[:]); err != nil {
			return 0, nil, err
		}
		length = binary.BigEndian.Uint64(b[:])
	}
	if length > maxWSFrameBytes {
		return 0, nil, errors.New("websocket frame too large")
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(conn, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, length)
	if length > 0 {
		if _, err := io.ReadFull(conn, payload); err != nil {
			return 0, nil, err
		}
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

func writeWSFrame(conn net.Conn, opcode byte, payload []byte) error {
	header := []byte{0x80 | opcode}
	l := len(payload)
	switch {
	case l < 126:
		header = append(header, byte(l))
	case l <= 65535:
		header = append(header, 126, byte(l>>8), byte(l))
	default:
		header = append(header, 127)
		var b [8]byte
		binary.BigEndian.PutUint64(b[:], uint64(l))
		header = append(header, b[:]...)
	}
	if _, err := conn.Write(header); err != nil {
		return err
	}
	if l > 0 {
		_, err := conn.Write(payload)
		return err
	}
	return nil
}

type winsize struct {
	Row    uint16
	Col    uint16
	Xpixel uint16
	Ypixel uint16
}

func openPTY(cols, rows uint16) (*os.File, *os.File, error) {
	ptmx, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, nil, err
	}
	unlock := 0
	if err := ioctl(ptmx.Fd(), syscall.TIOCSPTLCK, uintptr(unsafe.Pointer(&unlock))); err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	var ptyNum uint32
	if err := ioctl(ptmx.Fd(), syscall.TIOCGPTN, uintptr(unsafe.Pointer(&ptyNum))); err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	if cols > 0 && rows > 0 {
		_ = setPTYSize(ptmx, cols, rows)
	}
	slaveName := fmt.Sprintf("/dev/pts/%d", ptyNum)
	slave, err := os.OpenFile(slaveName, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		_ = ptmx.Close()
		return nil, nil, err
	}
	return ptmx, slave, nil
}

func ioctl(fd uintptr, req uintptr, arg uintptr) error {
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, req, arg)
	if errno != 0 {
		return errno
	}
	return nil
}

func setPTYSize(f *os.File, cols, rows uint16) error {
	if cols == 0 {
		cols = 80
	}
	if rows == 0 {
		rows = 24
	}
	ws := winsize{Row: rows, Col: cols}
	return ioctl(f.Fd(), syscall.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

func parseTerminalSize(colsText, rowsText string) (uint16, uint16) {
	cols := parseUint16Default(colsText, 100)
	rows := parseUint16Default(rowsText, 30)
	return cols, rows
}

func parseUint16Default(text string, def uint16) uint16 {
	var v uint64
	_, err := fmt.Sscanf(strings.TrimSpace(text), "%d", &v)
	if err != nil || v == 0 || v > 500 {
		return def
	}
	return uint16(v)
}

func tryTerminalControl(payload []byte, ptyFile *os.File) bool {
	const prefix = "__QF_RESIZE__:"
	text := string(payload)
	if !strings.HasPrefix(text, prefix) {
		return false
	}
	parts := strings.Split(strings.TrimSpace(strings.TrimPrefix(text, prefix)), ":")
	if len(parts) != 2 {
		return true
	}
	cols := parseUint16Default(parts[0], 100)
	rows := parseUint16Default(parts[1], 30)
	_ = setPTYSize(ptyFile, cols, rows)
	return true
}

func firstExistingShell() string {
	for _, sh := range []string{"/bin/ash", "/bin/sh"} {
		if _, err := os.Stat(sh); err == nil {
			return sh
		}
	}
	return "/bin/sh"
}

func terminalEnv(cols, rows uint16) []string {
	env := os.Environ()
	add := map[string]string{
		"TERM":    "xterm-256color",
		"SHELL":   firstExistingShell(),
		"HOME":    "/root",
		"COLUMNS": fmt.Sprintf("%d", cols),
		"LINES":   fmt.Sprintf("%d", rows),
	}
	for k, v := range add {
		env = appendOrReplaceEnv(env, k, v)
	}
	return env
}

func appendOrReplaceEnv(env []string, key, value string) []string {
	prefix := key + "="
	for i, item := range env {
		if strings.HasPrefix(item, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

func cleanAbs(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("路径不能为空")
	}
	if strings.ContainsRune(path, '\x00') {
		return "", errors.New("路径包含非法字符")
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("必须使用绝对路径")
	}
	return filepath.Clean(path), nil
}

func safeName(name string) (string, error) {
	name = strings.TrimSpace(strings.ReplaceAll(name, "\\", "/"))
	base := filepath.Base(name)
	if base == "" || base == "." || base == ".." || base != name {
		return "", errors.New("文件名不能包含路径")
	}
	if strings.ContainsRune(base, '\x00') || strings.Contains(base, "/") {
		return "", errors.New("文件名包含非法字符")
	}
	return base, nil
}

func srcDstFromForm(r *http.Request) (string, string, error) {
	src, err := cleanAbs(r.FormValue("src"))
	if err != nil {
		return "", "", err
	}
	dst, err := cleanAbs(r.FormValue("dst"))
	if err != nil {
		return "", "", err
	}
	return src, dst, nil
}

func protectedDeletePath(path string) bool {
	switch path {
	case "/", "/bin", "/boot", "/dev", "/etc", "/lib", "/overlay", "/proc", "/rom", "/sbin", "/sys", "/tmp", "/usr", "/var", "/www":
		return true
	default:
		return false
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func runCommand(timeout time.Duration, dir string, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	out, err := cmd.CombinedOutput()
	if len(out) > maxCommandOutput {
		out = append([]byte("[output truncated]\n"), out[len(out)-maxCommandOutput:]...)
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return out, fmt.Errorf("命令超时")
	}
	return out, err
}

func normalizeArchiveFormat(format string) (string, error) {
	format = strings.ToLower(strings.TrimSpace(format))
	format = strings.ReplaceAll(format, " ", "")
	switch format {
	case "", "tar.gz", "tgz":
		return "tar.gz", nil
	case "tar.xz", "txz":
		return "tar.xz", nil
	case "zip":
		return "zip", nil
	default:
		return "", fmt.Errorf("unsupported archive format: %s", format)
	}
}

func archiveExt(format string) string {
	switch format {
	case "tar.xz":
		return "tar.xz"
	case "zip":
		return "zip"
	default:
		return "tar.gz"
	}
}

func createArchive(ctx context.Context, src, dest, format string) error {
	switch format {
	case "tar.gz":
		return createTarGz(ctx, src, dest)
	case "tar.xz":
		return createTarXz(ctx, src, dest)
	case "zip":
		return createZip(ctx, src, dest)
	default:
		return fmt.Errorf("unsupported archive format: %s", format)
	}
}

func createTarGz(ctx context.Context, src, dest string) error {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	gz := gzip.NewWriter(out)
	defer gz.Close()

	tw := tar.NewWriter(gz)
	defer tw.Close()

	return writeTarEntries(ctx, src, tw, dest)
}

func createTarXz(ctx context.Context, src, dest string) error {
	if _, err := exec.LookPath("xz"); err != nil {
		return errors.New("系统缺少 xz 命令，无法创建 tar.xz；请先安装 xz 工具")
	}

	tmp, err := os.CreateTemp(filepath.Dir(dest), ".quickfile-*.tar")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	_ = tmp.Close()
	defer os.Remove(tmpName)

	if err := createTar(ctx, src, tmpName); err != nil {
		return err
	}

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	xzCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(xzCtx, "xz", "-z", "-c", tmpName)
	cmd.Stdout = out
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		if errors.Is(xzCtx.Err(), context.DeadlineExceeded) {
			return errors.New("xz 压缩超时")
		}
		return fmt.Errorf("%v\n%s", err, stderr.String())
	}
	return nil
}

func createTar(ctx context.Context, src, dest string) error {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()
	tw := tar.NewWriter(out)
	defer tw.Close()
	return writeTarEntries(ctx, src, tw, dest)
}

func writeTarEntries(ctx context.Context, src string, tw *tar.Writer, skipPath string) error {
	parent := filepath.Dir(src)
	return filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if skipPath != "" && filepath.Clean(path) == filepath.Clean(skipPath) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode()
		if mode&os.ModeDevice != 0 || mode&os.ModeNamedPipe != 0 || mode&os.ModeSocket != 0 {
			return nil
		}

		link := ""
		if mode&os.ModeSymlink != 0 {
			link, _ = os.Readlink(path)
		}
		hdr, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(parent, path)
		if err != nil {
			return err
		}
		hdr.Name = filepath.ToSlash(rel)
		if err := tw.WriteHeader(hdr); err != nil {
			return err
		}
		if !mode.IsRegular() {
			return nil
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := copyWithContext(ctx, tw, in)
		closeErr := in.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func createZip(ctx context.Context, src, dest string) error {
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	defer out.Close()

	zw := zip.NewWriter(out)
	defer zw.Close()

	parent := filepath.Dir(src)
	return filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if walkErr != nil {
			return walkErr
		}
		if filepath.Clean(path) == filepath.Clean(dest) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		mode := info.Mode()
		if mode&os.ModeSymlink != 0 || mode&os.ModeDevice != 0 || mode&os.ModeNamedPipe != 0 || mode&os.ModeSocket != 0 {
			return nil
		}
		rel, err := filepath.Rel(parent, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if info.IsDir() {
			if !strings.HasSuffix(name, "/") {
				name += "/"
			}
			_, err := zw.CreateHeader(&zip.FileHeader{Name: name})
			return err
		}
		if !mode.IsRegular() {
			return nil
		}
		hdr, err := zip.FileInfoHeader(info)
		if err != nil {
			return err
		}
		hdr.Name = name
		hdr.Method = zip.Deflate
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			return err
		}
		in, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := copyWithContext(ctx, w, in)
		closeErr := in.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func extractArchive(ctx context.Context, path, destDir string) error {
	lower := strings.ToLower(path)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return extractZip(ctx, path, destDir)
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return err
		}
		defer gz.Close()
		return extractTar(ctx, gz, destDir)
	case strings.HasSuffix(lower, ".tar.xz"), strings.HasSuffix(lower, ".txz"):
		return extractTarXz(ctx, path, destDir)
	case strings.HasSuffix(lower, ".tar"):
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		return extractTar(ctx, f, destDir)
	case strings.HasSuffix(lower, ".gz"):
		return extractSingleGzip(ctx, path, destDir)
	default:
		return errors.New("不支持的压缩格式")
	}
}

func extractTarXz(ctx context.Context, path, destDir string) error {
	if _, err := exec.LookPath("xz"); err != nil {
		return errors.New("系统缺少 xz 命令，无法解压 tar.xz；请先安装 xz 工具")
	}
	xzCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(xzCtx, "xz", "-dc", path)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	tarErr := extractTar(ctx, stdout, destDir)
	if tarErr != nil {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		return tarErr
	}
	waitErr := cmd.Wait()
	if waitErr != nil {
		if errors.Is(xzCtx.Err(), context.DeadlineExceeded) {
			return errors.New("xz 解压超时")
		}
		return fmt.Errorf("%v\n%s", waitErr, stderr.String())
	}
	return nil
}

func extractZip(ctx context.Context, path, destDir string) error {
	zr, err := zip.OpenReader(path)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		target, err := safeJoin(destDir, f.Name)
		if err != nil {
			return err
		}
		if f.FileInfo().IsDir() {
			if err := ensureNoSymlinkInPath(destDir, target); err != nil {
				return err
			}
			if err := os.MkdirAll(target, 0755); err != nil {
				return err
			}
			continue
		}
		if f.FileInfo().Mode()&os.ModeSymlink != 0 {
			continue
		}
		if err := ensureNoSymlinkInPath(destDir, filepath.Dir(target)); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		if err := writeFileFromReader(ctx, target, rc, f.FileInfo().Mode()); err != nil {
			rc.Close()
			return err
		}
		rc.Close()
	}
	return nil
}

func extractTar(ctx context.Context, r io.Reader, destDir string) error {
	tr := tar.NewReader(r)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		target, err := safeJoin(destDir, hdr.Name)
		if err != nil {
			return err
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := ensureNoSymlinkInPath(destDir, target); err != nil {
				return err
			}
			if err := os.MkdirAll(target, os.FileMode(hdr.Mode)&0777); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := ensureNoSymlinkInPath(destDir, filepath.Dir(target)); err != nil {
				return err
			}
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				return err
			}
			if err := writeFileFromReader(ctx, target, tr, os.FileMode(hdr.Mode)&0777); err != nil {
				return err
			}
		default:
			// Skip symlinks, devices, hardlinks and other special entries for router safety.
			continue
		}
	}
}

func extractSingleGzip(ctx context.Context, path, destDir string) error {
	in, err := os.Open(path)
	if err != nil {
		return err
	}
	defer in.Close()
	gz, err := gzip.NewReader(in)
	if err != nil {
		return err
	}
	defer gz.Close()
	name := strings.TrimSuffix(filepath.Base(path), ".gz")
	if name == "" || name == filepath.Base(path) {
		name = filepath.Base(path) + ".out"
	}
	target, err := safeJoin(destDir, name)
	if err != nil {
		return err
	}
	if err := ensureNoSymlinkInPath(destDir, filepath.Dir(target)); err != nil {
		return err
	}
	return writeFileFromReader(ctx, target, gz, 0644)
}

func downloadRemoteFileWithTask(parent context.Context, rawURL, destDir, requestedName string, progress func(current, total int64, msg string)) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", errors.New("URL 无效")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", errors.New("只支持 http/https URL")
	}

	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 30*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "QuickFile-Go/"+appVersion)

	client := &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   15 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			TLSHandshakeTimeout:   15 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
	if progress != nil {
		progress(0, 0, "正在请求")
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("HTTP 状态码: %s", resp.Status)
	}

	name, err := chooseDownloadName(u, resp, requestedName)
	if err != nil {
		return "", err
	}
	dest := uniquePath(filepath.Join(destDir, name))
	tmp, err := os.CreateTemp(destDir, ".quickfile-download-*.part")
	if err != nil {
		return "", err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)

	total := resp.ContentLength
	if progress != nil {
		progress(0, total, "正在下载 "+name)
	}
	var current int64
	buf := make([]byte, remoteCopyBufferSize)
	lastReport := time.Now()
	for {
		select {
		case <-ctx.Done():
			_ = tmp.Close()
			return "", ctx.Err()
		default:
		}
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := tmp.Write(buf[:n]); err != nil {
				_ = tmp.Close()
				return "", err
			}
			current += int64(n)
			if progress != nil && (time.Since(lastReport) > 500*time.Millisecond || (total > 0 && current == total)) {
				progress(current, total, "正在下载 "+name)
				lastReport = time.Now()
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			_ = tmp.Close()
			return "", readErr
		}
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if progress != nil {
		progress(current, total, "正在保存")
	}
	if err := os.Rename(tmpName, dest); err != nil {
		return "", err
	}
	return dest, nil
}

func chooseDownloadName(u *url.URL, resp *http.Response, requestedName string) (string, error) {
	if requestedName != "" {
		return safeName(requestedName)
	}
	if cd := resp.Header.Get("Content-Disposition"); cd != "" {
		if _, params, err := mime.ParseMediaType(cd); err == nil {
			if name := strings.TrimSpace(params["filename"]); name != "" {
				if safe, err := safeName(name); err == nil {
					return safe, nil
				}
			}
		}
	}
	name := strings.TrimSpace(u.EscapedPath())
	if name != "" && name != "/" {
		if unescaped, err := url.PathUnescape(name); err == nil {
			name = unescaped
		}
		name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
		if safe, err := safeName(name); err == nil {
			return safe, nil
		}
	}
	return "download", nil
}

func uniquePath(path string) string {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return path
	}
	dir := filepath.Dir(path)
	base := filepath.Base(path)

	var stem, ext string
	lower := strings.ToLower(base)
	switch {
	case strings.HasSuffix(lower, ".tar.gz"):
		stem, ext = base[:len(base)-len(".tar.gz")], ".tar.gz"
	case strings.HasSuffix(lower, ".tar.xz"):
		stem, ext = base[:len(base)-len(".tar.xz")], ".tar.xz"
	default:
		ext = filepath.Ext(base)
		stem = strings.TrimSuffix(base, ext)
	}
	for i := 1; i <= 9999; i++ {
		candidate := filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
		if _, err := os.Lstat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, time.Now().UnixNano(), ext))
}

func runCommandStream(parent context.Context, timeout time.Duration, dir string, name string, emit func(string), args ...string) error {
	if parent == nil {
		parent = context.Background()
	}
	if emit == nil {
		emit = func(string) {}
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, name, args...)
	if dir != "" {
		cmd.Dir = dir
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	var wg sync.WaitGroup
	copyPipe := func(r io.Reader) {
		defer wg.Done()
		buf := make([]byte, 4096)
		for {
			n, readErr := r.Read(buf)
			if n > 0 {
				emit(string(buf[:n]))
			}
			if readErr != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyPipe(stdout)
	go copyPipe(stderr)
	waitErr := cmd.Wait()
	wg.Wait()

	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("命令超时")
	}
	if err := parent.Err(); err != nil {
		return fmt.Errorf("请求已取消: %v", err)
	}
	return waitErr
}

func installAPKStream(parent context.Context, pkgPath string, emit func(string)) error {
	if _, err := exec.LookPath("apk"); err != nil {
		return errors.New("系统未找到 apk 命令")
	}
	emit("$ apk add --allow-untrusted " + pkgPath + "\n")
	err := runCommandStream(parent, 180*time.Second, "", "apk", emit, "add", "--allow-untrusted", pkgPath)
	if err == nil {
		return nil
	}

	emit("\n首次安装失败，尝试刷新软件源后重试...\n")
	emit("$ apk update\n")
	updErr := runCommandStream(parent, 180*time.Second, "", "apk", emit, "update")
	if updErr != nil {
		return fmt.Errorf("apk add 失败，apk update 也失败: %v", updErr)
	}

	emit("\n$ apk add --allow-untrusted " + pkgPath + "\n")
	retryErr := runCommandStream(parent, 180*time.Second, "", "apk", emit, "add", "--allow-untrusted", pkgPath)
	if retryErr != nil {
		return retryErr
	}
	return nil
}

func installIPKStream(parent context.Context, pkgPath string, emit func(string)) error {
	if _, err := exec.LookPath("opkg"); err != nil {
		return errors.New("系统未找到 opkg 命令")
	}
	emit("$ opkg install " + pkgPath + "\n")
	err := runCommandStream(parent, 180*time.Second, "", "opkg", emit, "install", pkgPath)
	if err == nil {
		return nil
	}

	emit("\n首次安装失败，尝试刷新软件源后重试...\n")
	emit("$ opkg update\n")
	updErr := runCommandStream(parent, 180*time.Second, "", "opkg", emit, "update")
	if updErr != nil {
		return fmt.Errorf("opkg install 失败，opkg update 也失败: %v", updErr)
	}

	emit("\n$ opkg install " + pkgPath + "\n")
	retryErr := runCommandStream(parent, 180*time.Second, "", "opkg", emit, "install", pkgPath)
	if retryErr != nil {
		return retryErr
	}
	return nil
}

func installAPK(pkgPath string) ([]byte, error) {
	if _, err := exec.LookPath("apk"); err != nil {
		return nil, errors.New("系统未找到 apk 命令")
	}
	var log strings.Builder
	log.WriteString("$ apk add --allow-untrusted " + pkgPath + "\n")
	out, err := runCommand(180*time.Second, "", "apk", "add", "--allow-untrusted", pkgPath)
	log.Write(out)
	if err == nil {
		return []byte(log.String()), nil
	}

	log.WriteString("\n首次安装失败，尝试刷新软件源后重试...\n")
	log.WriteString("$ apk update\n")
	upd, updErr := runCommand(180*time.Second, "", "apk", "update")
	log.Write(upd)
	if updErr != nil {
		return []byte(log.String()), fmt.Errorf("apk add 失败，apk update 也失败: %v", updErr)
	}

	log.WriteString("\n$ apk add --allow-untrusted " + pkgPath + "\n")
	retry, retryErr := runCommand(180*time.Second, "", "apk", "add", "--allow-untrusted", pkgPath)
	log.Write(retry)
	if retryErr != nil {
		return []byte(log.String()), retryErr
	}
	return []byte(log.String()), nil
}

func installIPK(pkgPath string) ([]byte, error) {
	if _, err := exec.LookPath("opkg"); err != nil {
		return nil, errors.New("系统未找到 opkg 命令")
	}
	var log strings.Builder
	log.WriteString("$ opkg install " + pkgPath + "\n")
	out, err := runCommand(180*time.Second, "", "opkg", "install", pkgPath)
	log.Write(out)
	if err == nil {
		return []byte(log.String()), nil
	}

	log.WriteString("\n首次安装失败，尝试刷新软件源后重试...\n")
	log.WriteString("$ opkg update\n")
	upd, updErr := runCommand(180*time.Second, "", "opkg", "update")
	log.Write(upd)
	if updErr != nil {
		return []byte(log.String()), fmt.Errorf("opkg install 失败，opkg update 也失败: %v", updErr)
	}

	log.WriteString("\n$ opkg install " + pkgPath + "\n")
	retry, retryErr := runCommand(180*time.Second, "", "opkg", "install", pkgPath)
	log.Write(retry)
	if retryErr != nil {
		return []byte(log.String()), retryErr
	}
	return []byte(log.String()), nil
}

func measureCopySize(src, dst string) (int64, error) {
	src = filepath.Clean(src)
	dst = filepath.Clean(dst)
	info, err := os.Lstat(src)
	if err != nil {
		return 0, err
	}
	if _, err := os.Lstat(dst); err == nil {
		return 0, fmt.Errorf("目标已存在: %s", dst)
	} else if !os.IsNotExist(err) {
		return 0, err
	}
	if info.IsDir() {
		rel, err := filepath.Rel(src, dst)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, "../") && rel != "." {
			return 0, fmt.Errorf("不能复制目录到自身子目录")
		}
	}
	var total int64
	err = filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if total <= 0 {
		total = 1
	}
	return total, nil
}

func copyRecursiveWithProgress(ctx context.Context, src, dst string, total int64, copied *int64, progress func(int64, int64, string)) error {
	info, err := os.Lstat(src)
	if err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if info.IsDir() {
		return filepath.WalkDir(src, func(path string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			rel, err := filepath.Rel(src, path)
			if err != nil {
				return err
			}
			target := dst
			if rel != "." {
				target = filepath.Join(dst, rel)
			}
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			return copySingleEntry(ctx, path, target, info, total, copied, progress)
		})
	}
	return copySingleEntry(ctx, src, dst, info, total, copied, progress)
}

func copySingleEntry(ctx context.Context, src, dst string, info os.FileInfo, total int64, copied *int64, progress func(int64, int64, string)) error {
	mode := info.Mode()
	switch {
	case mode.IsDir():
		if err := os.MkdirAll(dst, mode.Perm()); err != nil {
			return err
		}
		_ = os.Chmod(dst, mode.Perm())
		_ = os.Chtimes(dst, info.ModTime(), info.ModTime())
		return nil
	case mode&os.ModeSymlink != 0:
		linkTarget, err := os.Readlink(src)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
			return err
		}
		return os.Symlink(linkTarget, dst)
	case mode.IsRegular():
		return copyRegularFile(ctx, src, dst, info, total, copied, progress)
	default:
		// Skip device nodes, sockets and FIFOs instead of blocking the task.
		return nil
	}
}

func copyRegularFile(ctx context.Context, src, dst string, info os.FileInfo, total int64, copied *int64, progress func(int64, int64, string)) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	tmp := filepath.Join(filepath.Dir(dst), fmt.Sprintf(".quickfile-copy-%d.part", time.Now().UnixNano()))
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_EXCL|syscall.O_NOFOLLOW, info.Mode().Perm())
	if err != nil {
		return err
	}
	defer func() {
		_ = out.Close()
		if ctx.Err() != nil {
			_ = os.Remove(tmp)
		}
	}()

	buf := make([]byte, uploadCopyBufferSize)
	var lastUpdate time.Time
	for {
		if err := ctx.Err(); err != nil {
			_ = os.Remove(tmp)
			return err
		}
		n, readErr := in.Read(buf)
		if n > 0 {
			written, writeErr := out.Write(buf[:n])
			if writeErr != nil {
				_ = os.Remove(tmp)
				return writeErr
			}
			if written != n {
				_ = os.Remove(tmp)
				return io.ErrShortWrite
			}
			*copied += int64(written)
			if time.Since(lastUpdate) > 500*time.Millisecond {
				lastUpdate = time.Now()
				progress(*copied, total, "正在复制 "+filepath.Base(src))
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			_ = os.Remove(tmp)
			return readErr
		}
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	_ = os.Chmod(tmp, info.Mode().Perm())
	_ = os.Chtimes(tmp, info.ModTime(), info.ModTime())
	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	progress(*copied, total, "正在复制 "+filepath.Base(src))
	return nil
}

func safeJoin(baseDir, name string) (string, error) {
	if strings.ContainsRune(name, '\x00') {
		return "", errors.New("归档包含非法文件名")
	}
	cleanName := filepath.Clean(strings.ReplaceAll(name, "\\", "/"))
	if filepath.IsAbs(cleanName) || cleanName == "." || strings.HasPrefix(cleanName, "../") || cleanName == ".." {
		return "", fmt.Errorf("归档包含不安全路径: %s", name)
	}
	target := filepath.Join(baseDir, cleanName)
	rel, err := filepath.Rel(baseDir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", fmt.Errorf("归档路径越界: %s", name)
	}
	return target, nil
}

func ensureNoSymlinkInPath(baseDir, target string) error {
	baseDir = filepath.Clean(baseDir)
	target = filepath.Clean(target)
	rel, err := filepath.Rel(baseDir, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return fmt.Errorf("目标路径越界: %s", target)
	}
	if rel == "." {
		return nil
	}
	curr := baseDir
	for _, part := range strings.Split(filepath.ToSlash(rel), "/") {
		if part == "" || part == "." {
			continue
		}
		curr = filepath.Join(curr, part)
		info, err := os.Lstat(curr)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("拒绝通过符号链接写入: %s", curr)
		}
	}
	return nil
}

func copyWithContext(ctx context.Context, dst io.Writer, src io.Reader) (int64, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	buf := make([]byte, archiveCopyBufferSize)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return written, err
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			m, writeErr := dst.Write(buf[:n])
			written += int64(m)
			if writeErr != nil {
				return written, writeErr
			}
			if m != n {
				return written, io.ErrShortWrite
			}
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func writeFileFromReader(ctx context.Context, path string, r io.Reader, mode os.FileMode) error {
	if mode == 0 {
		mode = 0644
	}
	flags := os.O_CREATE | os.O_WRONLY | os.O_TRUNC | syscall.O_NOFOLLOW
	out, err := os.OpenFile(path, flags, mode&0777)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = copyWithContext(ctx, out, r)
	return err
}
