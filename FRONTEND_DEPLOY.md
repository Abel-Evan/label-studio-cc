# 本地服务启动

  ```bash
  make run-dev
  ```

# 前端代码更新部署流程（修改 web 源码后）

> 适用场景：修改了 `web/` 下的前端源码，需要重新构建并让浏览器访问到最新页面。
> 运行环境：Label Studio 通过 Django（`runserver` / `label-studio` CLI，端口 8099）提供前端静态资源，`/react-app/` 路径由 `core/urls.py` 路由到 `static_serve.py` 提供，绕过了 nginx。

## 流程口诀

> **改源码 → `bun run build` → `collectstatic` → 重启服务 → 清浏览器/SW 缓存**

四步（尤其**重启服务**和**清缓存**）少一步，就可能出现「文件明明更新了，浏览器还在请求旧 hash → 404」。

---

## 步骤

### ① 构建前端

```bash
cd web
bun run build
```

- 产出新的 `web/dist/apps/labelstudio/main-<新hash>.js` 等资源。
- 同时把 `manifest.json` 写入 `label_studio/core/static/js/manifest.json`。

### ② 同步静态资源（collectstatic）

必须在**装有 Django 的环境**里执行（在容器内、用 `poetry` 环境）：

```bash
docker exec -it label-studio-anystreaming   /bin/bash
cd /home/disk/cch/label-studio-cc
poetry run python label_studio/manage.py collectstatic --noinput
```

- 把 `label_studio/core/static/`（含新 `manifest.json`）复制到 `STATIC_ROOT` = `label_studio/core/static_build/`。
- ⚠️ 如果直接用宿主机 `python3 manage.py ...` 会报 `ModuleNotFoundError: No module named 'django'`，因为宿主机没装 Django。

### ③ 重启服务进程（关键，别漏）

`manifest.json` 是在进程启动时读取一次并常驻内存的（见 `label_studio/core/utils/manifest_assets.py` 的 `_MANIFEST`），不重启不会重新读盘：

```bash
pkill -f "label-studio"
cd /home/disk/cch/label-studio-cc && bash start.sh
```

### ④ 清理浏览器缓存

浏览器可能缓存了引用旧 hash 的 HTML / Service Worker：

- 强制刷新：`Ctrl + Shift + R`（或 `Ctrl + F5`）
- 若仍不对：DevTools → **Application** → **Service Workers → Unregister** → **Clear site data**
- 或直接开**无痕窗口**访问

---

## 验证是否成功

```bash
# 1. 查看 STATIC_ROOT 里的 manifest 指向哪个 hash
cat label_studio/core/static_build/js/manifest.json

# 2. 确认该 hash 的文件在 dist 里真实存在
ls web/dist/apps/labelstudio/ | grep "main-"
```

两边 hash 一致，且浏览器请求的也是这个新 hash，即部署成功。

---

## 常见问题排查

| 现象 | 原因 | 解决 |
|------|------|------|
| 页面请求 `main-<旧hash>.js` 返回 404 | `collectstatic` 未执行，`static_build/js/manifest.json` 仍是旧的 | 执行步骤 ② |
| 文件已更新、`collectstatic` 也跑了，仍请求旧 hash | 服务进程未重启，内存里的 `_MANIFEST` 仍是旧的 | 执行步骤 ③ |
| 服务器端全对了，浏览器还是旧页面 | 浏览器 / Service Worker 缓存了旧 HTML | 执行步骤 ④ |
| `python3 manage.py` 报 `No module named 'django'` | 在无 Django 的宿主机环境执行 | 进容器用 `poetry run python ...` |
