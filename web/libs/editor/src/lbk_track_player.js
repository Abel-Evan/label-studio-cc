/**
 * ============================================================================
 * lbk_track_player.js —— 多机位像素位置映射接口（Web/JavaScript 版）
 * ============================================================================
 *
 * 本文件是 include/multi_camera/lbk_track_player.hpp（C++）的 JavaScript
 * 完整移植，功能与数值行为与 C++ 版完全一致，供 Web 前端使用
 * （ESM 模块，无任何第三方依赖，双精度 Number 运算与 C++ double 一致）。
 *
 * 功能描述：
 *   加载多机位相机标定参数（内参 K、畸变系数 dist_coeff、cam2world 外参 RT），
 *   提供"某个机位图像上的地面点 (x, y) 映射到指定机位图像上的位置"能力：
 *
 *     mapPixelBetweenCams(srcCamId, x, y, dstCamId)
 *         源机位像素 (x,y) → 反投影到球场地面平面 Y=0（世界坐标系定义在
 *         球场：原点在中圈地面，X=宽 68m，Z=长 105m，Y=高）→ 正投影到
 *         目标机位，返回映射像素 (x, y)。
 *
 *   投影方向合法性保障（返回错误码而不是错误数据，与 C++ 版一致）：
 *     - 源射线必须朝向地面（与 Y=0 平面相交于相机前方）；
 *     - 源像素与目标投影均执行"往返校验"，误差平方 > 1e-4 判定失败；
 *     - 畸变模型 k1 k2 p1 p2 k3，去畸变采用 50 次定点迭代；
 *     - 正确处理翻转内参约定（fx < 0、K(2,2) = s = -1）。
 *
 * 坐标系约定（与 C++ 版一致）：
 *   - 所有接口的像素坐标均使用标定原生"地图坐标系"：3840 x 2160
 *     （导出常量 MAP_W / MAP_H）；
 *   - 实际视频帧若为其他分辨率（如 1920x1080），请用 imgToMap()/mapToImg()
 *     静态方法换算：mapX = imgX * MAP_W / videoWidth。
 *
 * 返回码约定（与 C++ 版一致，方法返回对象的 ret 字段）：
 *     0    成功
 *     -1   相机不存在（机位号未加载/未注册）
 *     -2   投影失败（射线不指向地面 / 目标点在目标相机不可达 /
 *          往返校验误差超限等）
 *     -3   标定文件加载失败或字段缺失（仅 addCamera/loadCameras）
 *
 * 标定文件格式（proj_undist_<机位号>.txt，每行 "key v1 v2 ..."）：
 *     intrinsic_k             9  个数：3x3 内参（行优先）
 *     cam2world_extrinsic_rt  16 个数：4x4 相机->世界外参（行优先）
 *     dist_coeff              5  个数：k1 k2 p1 p2 k3
 *
 * 浏览器使用示例（本项目 fork：标定内容存在各项目的 description 字段里）：
 *     import { TrackPlayer, MAP_W, MAP_H } from './lbk_track_player.js';
 *     const tp = new TrackPlayer();
 *     // projects: [{ id: 项目id, description: 'intrinsic_k ...\ncam2world_extrinsic_rt ...\ndist_coeff ...' }]
 *     const n = await tp.loadCameras(projects);   // 机位号 = 项目 id
 *     const r = tp.mapPixelBetweenCams(srcProjectId, x, y, dstProjectId);
 *     if (r.ret === 0) console.log(`映射位置: (${r.x}, ${r.y})`);
 *
 * Node.js 使用示例（注入 fs 文本加载器，便于离线/测试）：
 *     import fs from 'node:fs';
 *     const tp = new TrackPlayer({
 *         fetchText: (url) => fs.readFileSync(url, 'utf-8'),
 *     });
 *     await tp.loadCameras('include/multi_camera/calibration');
 *
 * 与 C++ 版的 API 对应关系：
 *     load_cameras()            -> loadCameras()          (async)
 *     add_camera()              -> addCamera()            (async)
 *     remove_camera()           -> removeCamera()
 *     remove_all_cameras()      -> removeAllCameras()
 *     has_camera()              -> hasCamera()
 *     camera_count()            -> cameraCount()
 *     camera_ids()              -> cameraIds()
 *     map_pixel_between_cams()  -> mapPixelBetweenCams()  返回 {ret, x, y}
 *     pixel_to_world_ground()   -> pixelToWorldGround()   返回 {ret, world}
 *     world_to_pixel()          -> worldToPixel()        返回 {ret, x, y}
 *     img_to_map()/map_to_img() -> 静态方法 imgToMap()/mapToImg()
 * ============================================================================
 */

/** 标定原生地图坐标系尺寸（像素） */
export const MAP_W = 3840;
export const MAP_H = 2160;

/** 往返校验误差平方阈值（像素^2 / 米^2，与 C++ 版一致） */
const ROUNDTRIP_ERR2_MAX = 0.0001;

/** 去畸变定点迭代次数（与 C++ 版一致） */
const UNDISTORT_ITERS = 50;

/** 返回码常量 */
export const RET = Object.freeze({
  OK: 0,
  NO_CAMERA: -1,
  PROJ_FAIL: -2,
  FILE_FAIL: -3,
});

/* ---------------------------------------------------------------------------
 * 内部几何工具（模块私有，矩阵用一维行优先数组表示，与 C++ Eigen 逐操作对齐）
 * ------------------------------------------------------------------------- */

/** 解析标定文件文本：每行 "key v1 v2 ..." -> Map(key -> number[]) */
function parseProjFile(text) {
  const data = new Map();
  for (const line of text.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      continue;
    }
    const key = tokens[0];
    const values = [];
    for (let i = 1; i < tokens.length; ++i) {
      values.push(Number(tokens[i]));
    }
    data.set(key, values);
  }
  return data;
}

/** 3x3 矩阵(行优先一维数组) × 3维向量 */
function mulMat3Vec3(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** 3x3 矩阵的转置 × 3维向量 */
function mulMat3TVec3(m, v) {
  return [
    m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
    m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
    m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
  ];
}

/** 畸变模型：归一化坐标 (x,y) -> 加畸变归一化坐标（k1 k2 p1 p2 k3） */
function distortNormalized(x, y, dist) {
  const k1 = dist[0];
  const k2 = dist[1];
  const p1 = dist[2];
  const p2 = dist[3];
  const k3 = dist[4];

  const r2 = x * x + y * y;
  const r4 = r2 * r2;
  const r6 = r4 * r2;
  const radial = 1.0 + k1 * r2 + k2 * r4 + k3 * r6;

  const xd =
    x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x);
  const yd =
    y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y;
  return [xd, yd];
}

/** 像素 -> 去畸变归一化坐标（50 次定点迭代，处理 fx<0、K(2,2)=s 的翻转约定） */
function undistortPixelToNormalized(u, v, cam) {
  const K = cam.K;
  const fx = K[0];
  const fy = K[4];
  const cx = K[2];
  const cy = K[5];
  const s = K[8];

  const xd = (u * s - cx) / fx;
  const yd = (v * s - cy) / fy;

  let x = xd;
  let y = yd;
  for (let i = 0; i < UNDISTORT_ITERS; ++i) {
    const xp = distortNormalized(x, y, cam.dist);
    x += xd - xp[0];
    y += yd - xp[1];
  }
  return [x, y];
}

/** 像素 -> 地面 Y=0 世界点（直接版，失败返回 null） */
function pixelToGroundY0Direct(u, v, cam) {
  const R = cam.R;
  const t = cam.t;

  const xy = undistortPixelToNormalized(u, v, cam);
  const dCam = [xy[0], xy[1], 1.0];
  const dWorld = mulMat3Vec3(R, dCam);

  if (dWorld[1] >= -1e-9) {
    return null; // 射线不朝向地面（朝上/水平）
  }
  const lam = -t[1] / dWorld[1];
  if (lam <= 0.0) {
    return null;
  }

  const P = [
    t[0] + lam * dWorld[0],
    t[1] + lam * dWorld[1],
    t[2] + lam * dWorld[2],
  ];
  P[1] = 0.0;
  return P;
}

/** 世界点 -> 像素（直接版，失败返回 null） */
function projectWorldToPixelDirect(PWorld, cam) {
  const R = cam.R;
  const t = cam.t;
  const K = cam.K;

  const pRel = [PWorld[0] - t[0], PWorld[1] - t[1], PWorld[2] - t[2]];
  const PCam = mulMat3TVec3(R, pRel);
  const Z = PCam[2];
  if (Math.abs(Z) < 1e-12) {
    return null;
  }
  const x = PCam[0] / Z;
  const y = PCam[1] / Z;

  const xyd = distortNormalized(x, y, cam.dist);
  // K * [xd, yd, 1]
  const ph0 = K[0] * xyd[0] + K[1] * xyd[1] + K[2];
  const ph1 = K[3] * xyd[0] + K[4] * xyd[1] + K[5];
  const ph2 = K[6] * xyd[0] + K[7] * xyd[1] + K[8];

  return [ph0 / ph2, ph1 / ph2];
}

/** 像素 -> 地面世界点（往返校验版：误差平方 > 1e-4 返回 null） */
function pixelToGroundY0Checked(u, v, cam) {
  const P = pixelToGroundY0Direct(u, v, cam);
  if (P === null) {
    return null;
  }
  const uv = projectWorldToPixelDirect(P, cam);
  if (uv === null) {
    return null;
  }
  const d = (uv[0] - u) * (uv[0] - u) + (uv[1] - v) * (uv[1] - v);
  if (d > ROUNDTRIP_ERR2_MAX) {
    return null;
  }
  return P;
}

/** 世界点 -> 像素（往返校验版：误差平方 > 1e-4 返回 null） */
function projectWorldToPixelChecked(PWorld, cam) {
  const uv = projectWorldToPixelDirect(PWorld, cam);
  if (uv === null) {
    return null;
  }
  const P = pixelToGroundY0Direct(uv[0], uv[1], cam);
  if (P === null) {
    return null;
  }
  const d =
    (P[0] - PWorld[0]) * (P[0] - PWorld[0]) +
    (P[1] - PWorld[1]) * (P[1] - PWorld[1]) +
    (P[2] - PWorld[2]) * (P[2] - PWorld[2]);
  if (d > ROUNDTRIP_ERR2_MAX) {
    return null;
  }
  return uv;
}

/** 默认文本加载器：浏览器环境用 fetch（Node 等价环境可通过构造参数注入） */
async function defaultFetchText(url) {
  if (typeof fetch !== 'function') {
    throw new Error('当前环境无 fetch，请在构造 TrackPlayer 时注入 fetchText');
  }
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`加载失败 HTTP ${resp.status}: ${url}`);
  }
  return resp.text();
}

/**
 * 多机位像素位置映射器（C++ lbk::TrackPlayer 的 JS 版）。
 */
export class TrackPlayer {
  /**
   * @param {object} [options]
   * @param {function} [options.fetchText] 文本加载器
   *        (url) => Promise<string>；浏览器默认用 fetch，
   *        Node 环境可注入 fs.readFileSync 封装（见文件头示例）。
   */
  constructor(options = {}) {
    /** 机位号 -> 标定参数 {K(9), R(9), t(3), dist(5)} */
    this.cams = new Map();
    this.fetchText = options.fetchText || defaultFetchText;
  }

  /* -----------------------------------------------------------------
   * 机位管理
   * ----------------------------------------------------------------- */

  /**
   * 从项目列表批量加载机位（async），逐个调用 addCamera 注册。
   * 机位号对应项目 id，标定内容取自项目的 description。
   * @param {Array<{id: number, description: string}>} projects 过滤后的项目列表
   * @returns {Promise<number>} 成功加载的机位数量
   */
  async loadCameras(projects) {
    // 原实现：从标定目录扫描 proj_undist_<id>.txt（id=1..maxCamId）加载
    // const dir = String(calibDir).replace(/\/+$/, '');
    // let count = 0;
    // for (let id = 1; id <= maxCamId; ++id) {
    //   const ret = await this.addCamera(
    //     id, `${dir}/proj_undist_${id}.txt`);
    //   if (ret === RET.OK) {
    //     ++count;
    //   }
    // }
    // return count;
    let count = 0;

    for (const project of projects ?? []) {
      const ret = await this.addCamera(project.id, project.description);

      if (ret === RET.OK) {
        ++count;
      }
    }
    return count;
  }

  /**
   * 注册单个机位（async）。
   * @param {number} camId 机位号（对应项目 id）
   * @param {string} content 标定文件内容（取自项目 description，
   *        格式仍为每行 "key v1 v2 ..."，如 intrinsic_k / cam2world_extrinsic_rt / dist_coeff）
   * @returns {Promise<number>} 0 成功；-3 内容为空/字段缺失
   */
  async addCamera(camId, content) {
    // 原实现：把 url 指向的标定文件拉取为文本
    // let text;
    // try {
    //   text = await this.fetchText(url);
    // } catch (e) {
    //   return RET.FILE_FAIL;
    // }
    const text = typeof content === "string" ? content : "";

    if (!text.trim()) {
      return RET.FILE_FAIL; // 项目 description 为空，无标定内容
    }

    let data;
    try {
      data = parseProjFile(text);
    } catch (e) {
      return RET.FILE_FAIL;
    }

    const k = data.get('intrinsic_k');
    const rt = data.get('cam2world_extrinsic_rt');
    const dc = data.get('dist_coeff');
    if (!k || k.length < 9 || !rt || rt.length < 16 || !dc || dc.length < 5) {
      return RET.FILE_FAIL; // 必要字段缺失
    }

    // K: 3x3 行优先
    const K = [k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7], k[8]];
    // RT: 4x4 行优先 -> R(3x3) 与 t(3)
    const R = [
      rt[0], rt[1], rt[2],
      rt[4], rt[5], rt[6],
      rt[8], rt[9], rt[10],
    ];
    const t = [rt[3], rt[7], rt[11]];
    const dist = [dc[0], dc[1], dc[2], dc[3], dc[4]];

    this.cams.set(camId, { K, R, t, dist }); // 同号覆盖
    return RET.OK;
  }

  /** 移除指定机位（不存在时无副作用） */
  removeCamera(camId) {
    this.cams.delete(camId);
  }

  /** 移除全部机位 */
  removeAllCameras() {
    this.cams.clear();
  }

  /** 查询机位是否已注册 */
  hasCamera(camId) {
    return this.cams.has(camId);
  }

  /** 已注册机位数量 */
  cameraCount() {
    return this.cams.size;
  }

  /** 已注册机位号列表（升序） */
  cameraIds() {
    return [...this.cams.keys()].sort((a, b) => a - b);
  }

  /* -----------------------------------------------------------------
   * 核心接口
   * ----------------------------------------------------------------- */

  /**
   * 【核心】机位间像素位置映射。
   *
   * 输入源机位图像上的地面点 (x, y)（地图坐标系 3840x2160，如球员脚底），
   * 输出该地面点在指定目标机位图像上的映射像素位置。
   *
   * @param {number} srcCamId 源机位号
   * @param {number} x 源机位像素 x（地图坐标系）
   * @param {number} y 源机位像素 y（地图坐标系）
   * @param {number} dstCamId 目标机位号
   * @returns {{ret: number, x: number|null, y: number|null}}
   *          ret=0 时 x/y 为映射位置；否则 x/y 为 null
   */
  mapPixelBetweenCams(srcCamId, x, y, dstCamId) {
    const srcCam = this.cams.get(srcCamId);
    const dstCam = this.cams.get(dstCamId);
    if (srcCam === undefined || dstCam === undefined) {
      return { ret: RET.NO_CAMERA, x: null, y: null };
    }

    // 1) 源像素 -> 地面世界坐标（含往返校验）
    const P = pixelToGroundY0Checked(x, y, srcCam);
    if (P === null) {
      return { ret: RET.PROJ_FAIL, x: null, y: null };
    }

    // 2) 世界坐标 -> 目标机位像素（含往返校验）
    const uv = projectWorldToPixelChecked(P, dstCam);
    if (uv === null) {
      return { ret: RET.PROJ_FAIL, x: null, y: null };
    }

    return { ret: RET.OK, x: uv[0], y: uv[1] };
  }

  /**
   * 像素 -> 地面世界坐标（Y=0 平面）。
   * @param {number} camId 机位号
   * @param {number} x 像素 x（地图坐标系）
   * @param {number} y 像素 y（地图坐标系）
   * @returns {{ret: number, world: number[]|null}}
   *          ret=0 时 world=[X, Y, Z]（米，Y 恒为 0）
   */
  pixelToWorldGround(camId, x, y) {
    const cam = this.cams.get(camId);
    if (cam === undefined) {
      return { ret: RET.NO_CAMERA, world: null };
    }
    const P = pixelToGroundY0Checked(x, y, cam);
    if (P === null) {
      return { ret: RET.PROJ_FAIL, world: null };
    }
    return { ret: RET.OK, world: P };
  }

  /**
   * 世界坐标 -> 机位像素。
   * @param {number} camId 机位号
   * @param {number[]|{0:number,1:number,2:number}} world 世界坐标 [X, Y, Z]（米）
   * @returns {{ret: number, x: number|null, y: number|null}}
   */
  worldToPixel(camId, world) {
    if (!Array.isArray(world) && !(world && typeof world[0] === 'number')) {
      return { ret: RET.PROJ_FAIL, x: null, y: null };
    }
    const cam = this.cams.get(camId);
    if (cam === undefined) {
      return { ret: RET.NO_CAMERA, x: null, y: null };
    }
    const uv = projectWorldToPixelChecked(
      [world[0], world[1], world[2]], cam);
    if (uv === null) {
      return { ret: RET.PROJ_FAIL, x: null, y: null };
    }
    return { ret: RET.OK, x: uv[0], y: uv[1] };
  }

  /* -----------------------------------------------------------------
   * 坐标换算辅助（静态）
   * ----------------------------------------------------------------- */

  /** 实际视频坐标 -> 地图坐标（按实际视频分辨率换算） */
  static imgToMap(coordImg, imgPixels, mapPixels) {
    return (coordImg * mapPixels) / imgPixels;
  }

  /** 地图坐标 -> 实际视频坐标（按实际视频分辨率换算） */
  static mapToImg(coordMap, imgPixels, mapPixels) {
    return (coordMap * imgPixels) / mapPixels;
  }
}
