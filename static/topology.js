/*
 * topology.js — 线稿拓扑修复与路径提取核心引擎（无第三方依赖）
 *
 * 同一份文件既被浏览器 <script> 直接加载（挂到 window.Topology），
 * 也被 Node 自测 require（module.exports）。
 *
 * 管线顺序（不可调换）：
 *   1. 报告并排除原始零长度线段（不进入吸附端点集合）
 *   2. 对剩余启用线段的端点建吸附关系（dist <= snapDistance + 1e-9），
 *      取传递闭包；每组统一移到组内按 (x,y) 字典序最小的“原端点”
 *   3. 报告吸附后退化的线段并从交点阶段排除
 *   4. 在吸附后线段上求全部交点（端点落内部 / 十字交叉 / 共线重叠端点），
 *      端点与交点都带千分之一整数 BigInt 精确有理表示
 *   5. 收集全部端点与交点：相同点 O(1) 精确去重；再对“互不相同的点”
 *      按欧氏距离 <= 1e-9 取传递闭包（距离判定亦精确），字典序最小代表
 *   6. 按归并点切分小边；完全重合的小边只留一份，记录全部来源原始 ID
 *   7. 构图、统计、提取最大连续链（开链/闭环），闭环按最小编号起点 +
 *      笛卡尔逆时针归一；面积用 BigInt 精确鞋带公式累加
 *   8. 稳定排序、编号、最后一步六位小数四舍五入输出
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Topology = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EPS = 1e-9;

  // ---------------------------------------------------------------- 基础工具

  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function dist2(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  }

  function dist(ax, ay, bx, by) {
    return Math.sqrt(dist2(ax, ay, bx, by));
  }

  function pointsEqual(p, q) {
    return dist(p.x, p.y, q.x, q.y) <= EPS;
  }

  function lexLess(p, q) {
    if (p.x !== q.x) return p.x < q.x;
    return p.y < q.y;
  }

  // 并查集
  function DSU(n) {
    this.p = new Array(n);
    for (var i = 0; i < n; i++) this.p[i] = i;
  }
  DSU.prototype.add = function () {
    var i = this.p.length;
    this.p.push(i);
    return i;
  };
  DSU.prototype.find = function (x) {
    var root = x;
    while (this.p[root] !== root) root = this.p[root];
    while (this.p[x] !== x) {
      var nx = this.p[x];
      this.p[x] = root;
      x = nx;
    }
    return root;
  };
  DSU.prototype.union = function (a, b) {
    var ra = this.find(a), rb = this.find(b);
    if (ra !== rb) {
      if (ra < rb) this.p[rb] = ra; else this.p[ra] = rb;
    }
  };

  function round6(v) {
    // 避免 -0
    var r = Math.round(v * 1e6) / 1e6;
    return r === 0 ? 0 : r;
  }

  // ---------------------------------------------------------------- 精确有理数
  //
  // 输入坐标至多三位小数：端点的“千分之一整数”坐标是精确整数。
  // 两条线段的交点参数是整数比，交点的千分之一坐标是整数/整数有理数。
  // 面积对大坐标附近的微小环极度敏感（平移后 1e-7 量级面积会被浮点噪声
  // 推过六位舍入边界），所以面积全程用 BigInt 精确累加，最后一步才舍入。

  function gcdBig(a, b) {
    a = a < 0n ? -a : a;
    b = b < 0n ? -b : b;
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  // 精确点：实际坐标 = (xn/(1000*d), yn/(1000*d))，d 恒为正；
  // xn、yn、d 已约去公因子。null 表示只有浮点近似（非三位小数兜底路径）。
  function exactPoint(xn, yn, d) {
    if (d < 0n) { xn = -xn; yn = -yn; d = -d; }
    var g = gcdBig(gcdBig(xn, yn), d);
    if (g > 1n) { xn /= g; yn /= g; d /= g; }
    return { xn: xn, yn: yn, d: d };
  }

  function exactFromMilli(px, py) {
    // 三位小数坐标 -> 千分之一整数
    var ix = asInt1000(px), iy = asInt1000(py);
    if (ix === null || iy === null) return null;
    return { xn: BigInt(ix), yn: BigInt(iy), d: 1n };
  }

  // 精确点对应的最佳浮点近似（一次除法，不夹带浮点求交误差）
  function exactX(p) { return Number(p.exact.xn) / Number(p.exact.d) / 1000; }
  function exactY(p) { return Number(p.exact.yn) / Number(p.exact.d) / 1000; }
  function pointX(p) { return p.exact ? exactX(p) : p.x; }
  function pointY(p) { return p.exact ? exactY(p) : p.y; }

  // 两点距离：有精确表示时坐标差由 BigInt 算出再做一次浮点转换，
  // 避免“两个相近的大坐标浮点相减”造成的有效位损失（大坐标附近的短边）
  function pointDist(p, q) {
    if (p.exact && q.exact) {
      var den = 1000n * p.exact.d * q.exact.d;
      var dxN = p.exact.xn * q.exact.d - q.exact.xn * p.exact.d;
      var dyN = p.exact.yn * q.exact.d - q.exact.yn * p.exact.d;
      var fden = Number(den);
      return Math.hypot(Number(dxN) / fden, Number(dyN) / fden);
    }
    return dist(p.x, p.y, q.x, q.y);
  }

  // 六位小数四舍五入；axis 取 'x'/'y'，有精确表示时走精确除法。
  // 进位规则与旧实现 Math.round 一致：半值朝 +∞（-0.5→-0→0），
  // 即 floor(v + 1/2)，不做 away-from-zero。
  function round6Coord(p, axis) {
    if (!p.exact) return round6(axis === 'y' ? p.y : p.x);
    var e = p.exact;
    var num = (axis === 'y' ? e.yn : e.xn) * 1000n, den = e.d; // coord*1e6
    // floor(num/den + 1/2) = floor((2*num + den)/(2*den))，负数需真 floor
    var units = floorDiv(num * 2n + den, den * 2n);
    var r = Number(units) / 1e6;
    return r === 0 ? 0 : r;
  }

  /*
   * 精确有向面积累加器：Σ (x1*y2 - x2*y1)（未除 2）。
   * 逐项并入并约分，公分母按 LCM 增长——整数求交的分母大量共因，
   * 实际位数很小，且不引入任何浮点噪声。任一点缺精确表示即放弃，
   * 由调用方走浮点兜底。
   */
  function ExactTwiceArea() { this.n = 0n; this.d = 1n; this.failed = false; }
  ExactTwiceArea.prototype.addEdge = function (p, q) {
    if (this.failed || !p.exact || !q.exact) { this.failed = true; return; }
    var e1 = p.exact, e2 = q.exact;
    var num = e1.xn * e2.yn - e2.xn * e1.yn;
    var den = 1000000n * e1.d * e2.d; // (1000*d1)*(1000*d2)，恒正
    var g0 = gcdBig(this.d, den);
    var lcm = (this.d / g0) * den;
    this.n = this.n * (lcm / this.d) + num * (lcm / den);
    this.d = lcm;
    if (this.n !== 0n) {
      var g = gcdBig(this.n < 0n ? -this.n : this.n, this.d);
      if (g > 1n) { this.n /= g; this.d /= g; }
    } else {
      this.d = 1n;
    }
  };
  ExactTwiceArea.prototype.ring = function (nodeSeq, nodesArr) {
    for (var i = 0; i + 1 < nodeSeq.length; i++) {
      this.addEdge(nodesArr[nodeSeq[i]], nodesArr[nodeSeq[i + 1]]);
    }
    return this.failed ? null : this;
  };
  ExactTwiceArea.prototype.sign = function () {
    return this.n < 0n ? -1 : this.n > 0n ? 1 : 0;
  };
  // area = |n|/(2d)，结果 *1e6 后四舍五入（半远离零），输出 /1e6
  ExactTwiceArea.prototype.roundArea6 = function () {
    var num = this.n < 0n ? -this.n : this.n;
    // floor( num*1e6/(2d) + 1/2 ) = floor( (num*1e6 + d) / (2d) )
    var units = (num * 1000000n + this.d) / (this.d * 2n);
    var r = Number(units) / 1e6;
    return r === 0 ? 0 : r;
  };

  function exactRingArea(nodeSeq, nodesArr) {
    return new ExactTwiceArea().ring(nodeSeq, nodesArr);
  }

  // ---------------------------------------------------------------- 点索引
  //
  // 两层归一，保证“重复交点 O(1)，不同但 <=1e-9 的点仍取传递闭包”：
  //   1) 精确恒等：收集阶段，数学上同一点（重复端点、各对线段以整数
  //      算出的同一交点）共享同一个 BigInt 有理键，直接返回既有成员，
  //      不产生任何邻域扫描——重复/共点线段不再退化为近四次方。
  //   2) 邻近闭包：收集完成后，只在“互不相同的精确点”之间做一次网格
  //      邻域扫描，距离 <= EPS 即 union，并查集保证传递闭包完整；
  //      不按小数位分桶，不同节点不会被粗桶错误混并。
  function PointIndex() {
    this.members = [];  // {x,y,exact,cx,cy}，每个都是不同精确点
    this.parent = [];
    this.cells = new Map(); // "cx,cy" -> [memberIndex...]
    this.exactId = new Map(); // "xn/yn/d" -> memberIndex
  }
  PointIndex.prototype._find = function (x) {
    var root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== x) { var nx = this.parent[x]; this.parent[x] = root; x = nx; }
    return root;
  };
  PointIndex.prototype.add = function (x, y, exact) {
    if (exact) {
      var key = exact.xn + '/' + exact.yn + '/' + exact.d;
      var hit = this.exactId.get(key);
      if (hit !== undefined) return hit; // 同一点：O(1)，无扫描
    }
    // 桶号用精确有理数计算 floor(coord/1e-9)=floor(coord*1e6)：
    // 世界坐标 xn/(1000d) ×1e9 = xn*1e6/d，整除即得，无浮点越界风险
    var cx, cy;
    if (exact) {
      cx = floorDiv(exact.xn * 1000000n, exact.d);
      cy = floorDiv(exact.yn * 1000000n, exact.d);
    } else {
      cx = Math.floor(x / EPS);
      cy = Math.floor(y / EPS);
    }
    var id = this.members.length;
    this.members.push({ x: x, y: y, exact: exact, cx: Number(cx), cy: Number(cy) });
    this.parent.push(id);
    if (exact) this.exactId.set(key, id);
    var ck = cx + ',' + cy;
    var bucket = this.cells.get(ck);
    if (!bucket) { bucket = []; this.cells.set(ck, bucket); }
    bucket.push(id);
    return id;
  };
  function floorDiv(a, b) { // b>0
    var q = a / b;
    if (a < 0n && a % b !== 0n) q -= 1n;
    return q;
  }
  // 在不同精确点之间做一次邻近闭包（距离恰为一格时可能相隔两个桶，扫 ±2）
  PointIndex.prototype.mergeNearby = function () {
    for (var id = 0; id < this.members.length; id++) {
      var m = this.members[id];
      for (var gx = m.cx - 2; gx <= m.cx + 2; gx++) {
        for (var gy = m.cy - 2; gy <= m.cy + 2; gy++) {
          var bucket = this.cells.get(gx + ',' + gy);
          if (!bucket) continue;
          for (var bi = 0; bi < bucket.length; bi++) {
            var j = bucket[bi];
            if (j <= id) continue; // 每对点只比一次
            var o = this.members[j];
            if (pointsWithinEPS(m, o)) {
              var r1 = this._find(id), r2 = this._find(j);
              if (r1 !== r2) this.parent[r2] = r1;
            }
          }
        }
      }
    }
  };

  // 欧氏距离 <= 1e-9：两点都有精确表示时按有理数精确判定，无浮点边界歧义。
  // 世界坐标差 dx = Xn/den，den=1000*d1*d2；
  // dx²+dy² <= 1e-18  <=>  (Xn²+Yn²) * 10^18 <= den²。
  function pointsWithinEPS(m, o) {
    if (m.exact && o.exact) {
      var e1 = m.exact, e2 = o.exact;
      var Xn = e1.xn * e2.d - e2.xn * e1.d;
      var Yn = e1.yn * e2.d - e2.yn * e1.d;
      var den = 1000n * e1.d * e2.d;
      var lhs = (Xn * Xn + Yn * Yn) * 1000000000000000000n;
      return lhs <= den * den;
    }
    var dx = o.x - m.x, dy = o.y - m.y;
    return dx * dx + dy * dy <= EPS * EPS;
  }
  /*
   * 冻结索引：每个成员 id 映射到它所属簇的同一个代表点对象
   * {x,y,exact}。簇坐标取组内按 (x,y) 字典序最小的成员；最小成员无
   * 精确表示时借用组内任一精确表示（同点的不同表示数学上相等）。
   */
  PointIndex.prototype.finalize = function () {
    var self = this;
    var groups = new Map();
    for (var id = 0; id < this.members.length; id++) {
      var root = this._find(id);
      var g = groups.get(root);
      if (!g) { g = { best: root, memberIds: [] }; groups.set(root, g); }
      g.memberIds.push(id);
      if (pointLexLess(this.members[id], this.members[g.best])) g.best = id;
    }
    var canon = new Array(this.members.length);
    groups.forEach(function (g) {
      var bm = self.members[g.best];
      var point = { x: bm.x, y: bm.y, exact: bm.exact };
      if (!point.exact) {
        // 字典序最小成员无精确表示时，借用组内任一精确表示（数学上同点）
        for (var j = 0; j < g.memberIds.length; j++) {
          var ex = self.members[g.memberIds[j]].exact;
          if (ex) { point.exact = ex; break; }
        }
      }
      for (var k = 0; k < g.memberIds.length; k++) canon[g.memberIds[k]] = point;
    });
    return canon;
  };

  // 点的 (x,y) 字典序比较：有精确表示时按有理数精确比较
  function pointLexLess(p, q) {
    if (p.exact && q.exact) {
      var cx = p.exact.xn * q.exact.d - q.exact.xn * p.exact.d;
      if (cx !== 0n) return cx < 0n;
      var cy = p.exact.yn * q.exact.d - q.exact.yn * p.exact.d;
      return cy < 0n;
    }
    return lexLess(p, q);
  }

  // ---------------------------------------------------------------- 草稿校验

  /*
   * 整体校验一份草稿对象。返回 {ok, errors:[{path,message}]}。
   * 只读取，不修改调用方数据。失败时调用方不得用其替换草稿。
   */
  function validateDraft(input) {
    var errors = [];
    function err(path, message) { errors.push({ path: path, message: message }); }

    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, errors: [{ path: '$', message: '草稿必须是 JSON 对象' }] };
    }

    var ALLOWED = { version: 1, name: 1, snapDistance: 1, segments: 1 };
    for (var key in input) {
      if (Object.prototype.hasOwnProperty.call(input, key) && !ALLOWED[key]) {
        err('$.' + key, '未知字段，草稿只允许 version / name / snapDistance / segments');
      }
    }

    if (!('version' in input)) err('$.version', '缺失 version');
    else if (input.version !== 1) err('$.version', 'version 必须为数字 1');

    if (!('name' in input)) err('$.name', '缺失 name');
    else if (typeof input.name !== 'string') err('$.name', 'name 必须是字符串');
    else if (input.name.length < 1 || input.name.length > 80) {
      err('$.name', 'name 长度必须为 1～80 个字符');
    }

    if (!('snapDistance' in input)) err('$.snapDistance', '缺失 snapDistance');
    else if (!isFiniteNumber(input.snapDistance) || typeof input.snapDistance !== 'number') {
      err('$.snapDistance', 'snapDistance 必须是数字');
    } else if (input.snapDistance < 0 || input.snapDistance > 10) {
      err('$.snapDistance', 'snapDistance 必须在 0～10 之间');
    } else if (!hasAtMost3Decimals(input.snapDistance)) {
      err('$.snapDistance', 'snapDistance 最多三位小数');
    }

    var segments = input.segments;
    if (!('segments' in input)) {
      err('$.segments', '缺失 segments');
    } else if (!Array.isArray(segments)) {
      err('$.segments', 'segments 必须是数组');
    } else if (segments.length > 200) {
      err('$.segments', 'segments 最多 200 条');
    } else {
      var seenIds = Object.create(null);
      for (var i = 0; i < segments.length; i++) {
        validateSegment(segments[i], '$.segments[' + i + ']', errors, seenIds);
      }
    }

    errors.sort(function (e1, e2) {
      if (e1.path < e2.path) return -1;
      if (e1.path > e2.path) return 1;
      return e1.message < e2.message ? -1 : e1.message > e2.message ? 1 : 0;
    });
    return { ok: errors.length === 0, errors: errors };
  }

  function hasAtMost3Decimals(v) {
    // 用三位小数舍入反推；NaN/Infinity 已在外层挡住
    return Math.abs(v - Math.round(v * 1000) / 1000) <= 1e-9;
  }

  function validateCoord(v, path, errors) {
    if (typeof v === 'boolean') {
      errors.push({ path: path, message: '坐标必须是数字，不能是布尔值' });
      return;
    }
    if (!isFiniteNumber(v)) {
      errors.push({ path: path, message: '必须是有限数字（null、字符串等均不接受）' });
      return;
    }
    if (Math.abs(v) > 10000) {
      errors.push({ path: path, message: '坐标绝对值不能超过 10000' });
    }
    if (!hasAtMost3Decimals(v)) {
      errors.push({ path: path, message: '坐标最多三位小数' });
    }
  }

  function validateSegment(seg, base, errors, seenIds) {
    if (seg === null || typeof seg !== 'object' || Array.isArray(seg)) {
      errors.push({ path: base, message: '线段必须是对象' });
      return;
    }
    var SEG_ALLOWED = { id: 1, enabled: 1, a: 1, b: 1 };
    for (var key in seg) {
      if (Object.prototype.hasOwnProperty.call(seg, key) && !SEG_ALLOWED[key]) {
        errors.push({ path: base + '.' + key, message: '未知字段，线段只允许 id / enabled / a / b' });
      }
    }

    if (!('id' in seg)) errors.push({ path: base + '.id', message: '缺失 id' });
    else if (typeof seg.id !== 'string') {
      errors.push({ path: base + '.id', message: 'id 必须是字符串' });
    } else if (seg.id.length < 1 || seg.id.length > 40) {
      errors.push({ path: base + '.id', message: 'id 长度必须为 1～40 字符' });
    } else if (Object.prototype.hasOwnProperty.call(seenIds, seg.id)) {
      errors.push({ path: base + '.id', message: '重复的线段 id：' + seg.id });
    } else {
      seenIds[seg.id] = 1;
    }

    if (!('enabled' in seg)) {
      errors.push({ path: base + '.enabled', message: '缺失 enabled' });
    } else if (typeof seg.enabled !== 'boolean') {
      errors.push({ path: base + '.enabled', message: 'enabled 必须是布尔值，不能用数字代替' });
    }

    ['a', 'b'].forEach(function (ep) {
      var p = seg[ep];
      var epBase = base + '.' + ep;
      if (!((ep) in seg)) {
        errors.push({ path: epBase, message: '缺失端点 ' + ep });
      } else if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        errors.push({ path: epBase, message: '端点必须是对象 {x,y}' });
      } else {
        var PT_ALLOWED = { x: 1, y: 1 };
        for (var k in p) {
          if (Object.prototype.hasOwnProperty.call(p, k) && !PT_ALLOWED[k]) {
            errors.push({ path: epBase + '.' + k, message: '端点只允许 x / y 字段' });
          }
        }
        if (!('x' in p)) errors.push({ path: epBase + '.x', message: '缺失 x' });
        else validateCoord(p.x, epBase + '.x', errors);
        if (!('y' in p)) errors.push({ path: epBase + '.y', message: '缺失 y' });
        else validateCoord(p.y, epBase + '.y', errors);
      }
    });
  }

  // ---------------------------------------------------------------- 修复主管线

  /*
   * 输入已通过 validateDraft 的草稿对象。
   * 返回完整修复结果（页面展示与 topology.json 导出共用这一份）。
   */
  function repair(draft) {
    var snap = Number(draft.snapDistance);
    var rawSegs = draft.segments;
    var diagnostics = [];

    // 1. 原始零长度：报告并排除（不进入吸附端点集合）
    var zeroIds = [];
    var active = [];
    for (var i = 0; i < rawSegs.length; i++) {
      var s = rawSegs[i];
      if (!s.enabled) continue; // 禁用段保留在草稿中，不参与任何计算
      var pa = s.a, pb = s.b;
      if (pa.x === pb.x && pa.y === pb.y) {
        zeroIds.push(s.id);
      } else {
        active.push({
          id: s.id,
          a: { x: pa.x, y: pa.y },
          b: { x: pb.x, y: pb.y }
        });
      }
    }
    if (zeroIds.length) {
      diagnostics.push({
        code: 'ZERO_LENGTH_INPUT',
        sources: zeroIds.slice().sort(unicodeCmp),
        message: '原始零长度线段：a 与 b 完全相同，已排除且不参与吸附'
      });
    }

    // 2. 端点吸附：距离 <= snap + 1e-9 取传递闭包，
    //    每组移到组内字典序最小的“原端点”坐标（不取平均、不边遍历边改）
    var epList = [];   // {x,y,seg,end:0|1}
    active.forEach(function (sgm, si) {
      epList.push({ x: sgm.a.x, y: sgm.a.y, seg: si, end: 0 });
      epList.push({ x: sgm.b.x, y: sgm.b.y, seg: si, end: 1 });
    });
    var dsuSnap = new DSU(epList.length);
    var snapLimit = snap + EPS;
    var snapLimit2 = snapLimit * snapLimit;
    for (var e1 = 0; e1 < epList.length; e1++) {
      for (var e2 = e1 + 1; e2 < epList.length; e2++) {
        var P = epList[e1], Q = epList[e2];
        if (dist2(P.x, P.y, Q.x, Q.y) <= snapLimit2) dsuSnap.union(e1, e2);
      }
    }
    var snapGroups = Object.create(null);
    for (var e = 0; e < epList.length; e++) {
      var root = dsuSnap.find(e);
      if (!snapGroups[root]) snapGroups[root] = [];
      snapGroups[root].push(epList[e]);
    }
    var snapTarget = Object.create(null); // key "segIdx:end" -> {x,y}
    Object.keys(snapGroups).forEach(function (r) {
      var grp = snapGroups[r];
      var min = grp[0];
      for (var gi = 1; gi < grp.length; gi++) if (lexLess(grp[gi], min)) min = grp[gi];
      var target = { x: min.x, y: min.y };
      for (var gj = 0; gj < grp.length; gj++) {
        snapTarget[grp[gj].seg + ':' + grp[gj].end] = target;
      }
    });
    for (var sk = 0; sk < active.length; sk++) {
      var ta = snapTarget[sk + ':0'];
      var tb = snapTarget[sk + ':1'];
      if (ta) active[sk].a = { x: ta.x, y: ta.y };
      if (tb) active[sk].b = { x: tb.x, y: tb.y };
    }

    // 3. 吸附后退化：报告并从交点阶段排除
    var collapsedIds = [];
    var survivors = [];
    for (var sc = 0; sc < active.length; sc++) {
      if (active[sc].a.x === active[sc].b.x && active[sc].a.y === active[sc].b.y) {
        collapsedIds.push(active[sc].id);
      } else {
        survivors.push(active[sc]);
      }
    }
    if (collapsedIds.length) {
      diagnostics.push({
        code: 'COLLAPSED_AFTER_SNAP',
        sources: collapsedIds.slice().sort(unicodeCmp),
        message: '吸附后两端重合，线段退化，已从交点计算中排除'
      });
    }

    // 幸存线段的端点取自三位小数原端点，带上精确千分之一整数表示
    survivors.forEach(function (sgm) {
      sgm.exA = exactFromMilli(sgm.a.x, sgm.a.y);
      sgm.exB = exactFromMilli(sgm.b.x, sgm.b.y);
    });

    // 4 & 5. 收集端点与全部交点；1e-9 同点归并（传递闭包 + 网格哈希）
    //
    // 第一层：精确恒等。数学上同一点（重复端点、各对线段以整数算出的
    // 同一交点）直接共享同一个 BigInt 键，O(1) 合并，不产生扫描负担——
    // 这是消除“重复/共点交点近四次方”的关键，且不跳过任何一对线段。
    // 第二层：不同但欧氏距离 <= EPS 的精确点进网格桶，逐对 union；
    // 桶中每个点都是不同的精确点（端点间距至少 1e-3，交点由整数求交
    // 得到），扫描量与“真实不同点数”成正比，仍保证传递闭包完整。
    var index = new PointIndex();
    function addPoint(p) { return index.add(p.x, p.y, p.exact || null); }

    var segPointIds = []; // 每条幸存线段上挂的点索引（端点 + 与之相关的全部交点）
    for (var ss = 0; ss < survivors.length; ss++) {
      var iA = addPoint({ x: survivors[ss].a.x, y: survivors[ss].a.y, exact: survivors[ss].exA });
      var iB = addPoint({ x: survivors[ss].b.x, y: survivors[ss].b.y, exact: survivors[ss].exB });
      segPointIds.push([iA, iB]);
    }

    // 逐对线段求交点（含 T 接、十字、共线重叠段的端点）。
    // 分类与交点位置均由千分之一整数（BigInt）精确给出。
    for (var u = 0; u < survivors.length; u++) {
      for (var v = u + 1; v < survivors.length; v++) {
        var xs = segmentIntersections(survivors[u], survivors[v]);
        for (var xi = 0; xi < xs.length; xi++) {
          var pid = addPoint(xs[xi]);
          segPointIds[u].push(pid);
          segPointIds[v].push(pid);
        }
      }
    }

    // 冻结前：不同精确点之间做一次邻近闭包（<=1e-9 传递闭包，固定阈值）
    index.mergeNearby();
    // 冻结：成员 id -> 簇代表点 {x,y,exact}；组内取字典序最小（精确比较）
    var canonById = index.finalize();
    function canon(pi) { return canonById[pi]; }

    // 6. 切分小边：每条幸存线段只取挂在它上面的归并点，按精确参数排序
    var edgeMap = Object.create(null); // "key|key"（端点排序后）-> {a,b,sourceSet}
    function pointKey(p) {
      // 同一点已归一为同一对象；优先用精确有理键，浮点兜底用坐标字符串
      return p.exact ? p.exact.xn + '/' + p.exact.yn + '/' + p.exact.d : p.x + ',' + p.y;
    }
    function orderedPair(p, q) {
      var kp = pointKey(p), kq = pointKey(q);
      return kp <= kq ? [p, q] : [q, p];
    }
    for (var sg = 0; sg < survivors.length; sg++) {
      var S = survivors[sg];
      var onSeg = [];
      var seenOn = Object.create(null);
      for (var sp = 0; sp < segPointIds[sg].length; sp++) {
        var cp = canon(segPointIds[sg][sp]);
        var key = pointKey(cp);
        if (!seenOn[key]) { seenOn[key] = 1; onSeg.push(cp); }
      }
      // 沿线段参数排序：t = (X-A)·R / |R|²，有精确表示时用 BigInt 精确比较
      var Pm = S.exA, Rm = Pm && S.exB ? {
        x: S.exB.xn - S.exA.xn,
        y: S.exB.yn - S.exA.yn
      } : null;
      var ddd = Rm ? Rm.x * Rm.x + Rm.y * Rm.y : 0;
      function tParam(p) {
        // 点的千分之一坐标 = xn/d；t 分子 = (xn - P.x*d)*R.x + (yn-P.y*d)*R.y
        var e = p.exact;
        return {
          n: (e.xn - Pm.xn * e.d) * Rm.x + (e.yn - Pm.yn * e.d) * Rm.y,
          d: e.d * ddd
        };
      }
      if (Rm && onSeg.every(function (p) { return !!p.exact; })) {
        onSeg.sort(function (r, t) {
          var a = tParam(r), b = tParam(t);
          var lhs = a.n * b.d, rhs = b.n * a.d; // a.d,b.d 恒正
          return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
        });
      } else {
        var ax = S.a.x, ay = S.a.y, dx = S.b.x - S.a.x, dy = S.b.y - S.a.y;
        var len2 = dx * dx + dy * dy;
        onSeg.sort(function (r, t) {
          var pr = ((pointX(r) - ax) * dx + (pointY(r) - ay) * dy) / len2;
          var pt = ((pointX(t) - ax) * dx + (pointY(t) - ay) * dy) / len2;
          return pr - pt;
        });
      }
      for (var kk = 0; kk + 1 < onSeg.length; kk++) {
        var u1 = onSeg[kk], u2 = onSeg[kk + 1];
        if (pointsEqual(u1, u2)) continue; // 归一后两端相同的小边忽略
        var pair = orderedPair(u1, u2);
        var ekey = pointKey(pair[0]) + '|' + pointKey(pair[1]);
        if (!edgeMap[ekey]) edgeMap[ekey] = { a: pair[0], b: pair[1], sources: Object.create(null) };
        edgeMap[ekey].sources[S.id] = 1;
      }
    }

    var rawEdges = Object.keys(edgeMap).map(function (k) {
      var e = edgeMap[k];
      var sources = Object.keys(e.sources).sort(unicodeCmp);
      return {
        a: e.a, b: e.b, sources: sources,
        length: pointDist(e.a, e.b)
      };
    });

    // 7. 唯一节点：按 (x,y) 字典序排序编号（精确有理比较，浮点兜底）
    var nodeMap = Object.create(null);
    var nodesArr = [];
    rawEdges.forEach(function (e) { [e.a, e.b].forEach(function (p) {
      var k = pointKey(p);
      if (!nodeMap[k]) { nodeMap[k] = p; nodesArr.push(p); }
    }); });
    nodesArr.sort(function (p, q) {
      if (p.exact && q.exact) {
        var cx = p.exact.xn * q.exact.d - q.exact.xn * p.exact.d;
        if (cx !== 0n) return cx < 0n ? -1 : 1;
        var cy = p.exact.yn * q.exact.d - q.exact.yn * p.exact.d;
        if (cy !== 0n) return cy < 0n ? -1 : 1;
        return 0;
      }
      return lexLess(p, q) ? -1 : lexLess(q, p) ? 1 : 0;
    });
    var nodeId = Object.create(null);
    nodesArr.forEach(function (p, idx) { nodeId[pointKey(p)] = idx; });

    // 边：用排序后的端点编号表示，再按 (from,to) 排序
    var edgesArr = rawEdges.map(function (e) {
      var ia = nodeId[pointKey(e.a)], ib = nodeId[pointKey(e.b)];
      var from = Math.min(ia, ib), to = Math.max(ia, ib);
      return { from: from, to: to, sources: e.sources, length: e.length };
    });
    edgesArr.sort(function (e1, e2) {
      if (e1.from !== e2.from) return e1.from - e2.from;
      return e1.to - e2.to;
    });
    var edgeIdMap = Object.create(null);
    edgesArr.forEach(function (e, idx) { edgeIdMap[e.from + '-' + e.to] = idx; });

    // 无向图邻接表：node -> [{other, edge}]
    var n = nodesArr.length;
    var adj = [];
    for (var ai = 0; ai < n; ai++) adj.push([]);
    edgesArr.forEach(function (e, idx) {
      adj[e.from].push({ other: e.to, edge: idx });
      adj[e.to].push({ other: e.from, edge: idx });
    });

    var components = countComponents(n, adj);
    var endpoints = [], junctions = [];
    for (var ni = 0; ni < n; ni++) {
      if (adj[ni].length === 1) endpoints.push(ni);
      else if (adj[ni].length > 2) junctions.push(ni);
    }

    // 8. 路径分解
    var paths = extractPaths(n, adj, edgesArr, edgeIdMap, nodesArr);

    // 输出数值：长度/面积先按内部精度计算，最后统一六位小数
    var outNodes = nodesArr.map(function (p, idx) {
      return { id: idx, x: round6Coord(p, 'x'), y: round6Coord(p, 'y'), degree: adj[idx].length };
    });
    var outEdges = edgesArr.map(function (e, idx) {
      return { id: idx, from: e.from, to: e.to, sources: e.sources.slice(), length: round6(e.length) };
    });
    var outPaths = paths.map(function (pth, idx) {
      var srcSet = Object.create(null);
      pth.edges.forEach(function (eid) { edgesArr[eid].sources.forEach(function (s) { srcSet[s] = 1; }); });
      var length = 0;
      for (var li = 0; li + 1 < pth.nodes.length; li++) {
        length += pointDist(nodesArr[pth.nodes[li]], nodesArr[pth.nodes[li + 1]]);
      }
      var out = {
        id: idx,
        nodes: pth.nodes.slice(),
        edges: pth.edges.slice(),
        closed: pth.closed,
        length: round6(length),
        area: null,
        sources: Object.keys(srcSet).sort(unicodeCmp)
      };
      if (pth.closed) {
        // 面积：BigInt 精确鞋带公式，最后一步才舍入；无法精确时浮点兜底
        var exact = exactRingArea(pth.nodes, nodesArr);
        out.area = exact ? exact.roundArea6() : round6(Math.abs(signedArea(pth.nodes, nodesArr)));
      }
      return out;
    });

    var openCount = 0, ringCount = 0;
    outPaths.forEach(function (p) { if (p.closed) ringCount++; else openCount++; });

    diagnostics.sort(function (d1, d2) {
      if (d1.code !== d2.code) return d1.code < d2.code ? -1 : 1;
      var a = d1.sources.join(' '), b = d2.sources.join(' ');
      return a < b ? -1 : a > b ? 1 : 0;
    });

    return {
      version: 1,
      name: draft.name,
      snapDistance: draft.snapDistance,
      nodes: outNodes,
      edges: outEdges,
      paths: outPaths,
      summary: {
        nodes: n,
        edges: edgesArr.length,
        components: components,
        endpoints: endpoints.length,
        junctions: junctions.length,
        openPaths: openCount,
        rings: ringCount
      },
      diagnostics: diagnostics
    };
  }

  // ---------------------------------------------------------------- 几何：交点

  // 吸附后的端点全部取自原始端点（三位小数），×1000 后为整数；
  // 坐标 ≤ 10000 -> 整数 ≤ 1e7，叉积 ≤ 1e14 < 2^53，可用整数精确判定
  function asInt1000(v) {
    var k = v * 1000;
    var r = Math.round(k);
    return Math.abs(k - r) <= 1e-6 ? r : null;
  }

  // 两线段的全部交点（含端点接触、T 接；共线时返回重叠区间端点）。
  // 吸附后端点均为三位小数：千分之一坐标是整数，分类谓词与交点位置
  // 全部用 BigInt 精确计算，交点携带 {x,y,exact:{xn,yn,d}}。
  function segmentIntersections(s1, s2) {
    var p = s1.a, spr1 = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
    var q = s2.a, spr2 = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
    var P = { x: asInt1000(p.x), y: asInt1000(p.y) };
    var R = { x: asInt1000(spr1.x), y: asInt1000(spr1.y) };
    var Q = { x: asInt1000(q.x), y: asInt1000(q.y) };
    var S = { x: asInt1000(spr2.x), y: asInt1000(spr2.y) };
    var exact = P.x !== null && R.x !== null && Q.x !== null && S.x !== null &&
                P.y !== null && R.y !== null && Q.y !== null && S.y !== null;
    if (!exact) return segmentIntersectionsFloat(s1, s2);

    var Pn = { x: BigInt(P.x), y: BigInt(P.y) };
    var Rn = { x: BigInt(R.x), y: BigInt(R.y) };
    var Qn = { x: BigInt(Q.x), y: BigInt(Q.y) };
    var Sn = { x: BigInt(S.x), y: BigInt(S.y) };
    var QPn = { x: Qn.x - Pn.x, y: Qn.y - Pn.y };
    var crossRS = Rn.x * Sn.y - Rn.y * Sn.x;
    var crossQP = QPn.x * Sn.y - QPn.y * Sn.x;
    var crossQPR = QPn.x * Rn.y - QPn.y * Rn.x;

    if (crossRS !== 0n) {
      // 非平行：t = (q-p)×s / (r×s) ∈ [0,1]，u 同理；整数谓词精确无容差
      var inRange = bigAbs(crossQP) <= bigAbs(crossRS) &&
        bigAbs(crossQPR) <= bigAbs(crossRS) &&
        (crossQP === 0n || sameSignBig(crossQP, crossRS)) &&
        (crossQPR === 0n || sameSignBig(crossQPR, crossRS));
      if (!inRange) return [];
      var den = crossRS, tn = crossQP;
      var xn = Pn.x * den + Rn.x * tn;
      var yn = Pn.y * den + Rn.y * tn;
      var ex = exactPoint(xn, yn, den); // 内部统一把分母变正并约分
      return [{ x: exactX({ exact: ex }), y: exactY({ exact: ex }), exact: ex }];
    }

    // 平行：不共线则无交点
    if (crossQPR !== 0n) return [];

    // 共线：把端点投影到 s1 方向（千分之一整数点积），精确无容差
    var d = Rn.x * Rn.x + Rn.y * Rn.y;
    var e0 = QPn.x * Rn.x + QPn.y * Rn.y;
    var e1 = e0 + Sn.x * Rn.x + Sn.y * Rn.y;
    var lo = maxBig(0n, minBig(e0, e1));
    var hi = minBig(d, maxBig(e0, e1));
    if (lo > hi) return [];

    function collinearPoint(k) {
      // k 落在哪个原端点上就复用哪个端点（精确恒等去重的关键）
      var exA1 = s1.exA || exactFromMilli(p.x, p.y);
      var exB1 = s1.exB || exactFromMilli(s1.b.x, s1.b.y);
      var exA2 = s2.exA || exactFromMilli(q.x, q.y);
      var exB2 = s2.exB || exactFromMilli(s2.b.x, s2.b.y);
      if (k === 0n) return { x: p.x, y: p.y, exact: exA1 };
      if (k === d) return { x: s1.b.x, y: s1.b.y, exact: exB1 };
      if (k === e0) return { x: q.x, y: q.y, exact: exA2 };
      if (k === e1) return { x: s2.b.x, y: s2.b.y, exact: exB2 };
      var ex2 = exactPoint(Pn.x * d + Rn.x * k, Pn.y * d + Rn.y * k, d);
      return { x: exactX({ exact: ex2 }), y: exactY({ exact: ex2 }), exact: ex2 };
    }

    var pt0 = collinearPoint(lo);
    if (hi === lo) return [pt0];
    return [pt0, collinearPoint(hi)];
  }

  function bigAbs(a) { return a < 0n ? -a : a; }
  function sameSignBig(a, b) { return (a > 0n && b > 0n) || (a < 0n && b < 0n); }
  function minBig(a, b) { return a < b ? a : b; }
  function maxBig(a, b) { return a > b ? a : b; }

  // 非三位小数坐标的理论兜底（正常草稿不会走到）：浮点求交，无精确表示
  function segmentIntersectionsFloat(s1, s2) {
    var p = s1.a, r = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
    var q = s2.a, spr = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
    var qp = { x: q.x - p.x, y: q.y - p.y };
    var crossRS = r.x * spr.y - r.y * spr.x;
    var crossQP = qp.x * spr.y - qp.y * spr.x;
    var crossQPR = qp.x * r.y - qp.y * r.x;

    if (crossRS !== 0) {
      var tol = EPS * Math.max(1, Math.abs(crossRS));
      var inRange = Math.abs(crossQP) <= Math.abs(crossRS) + tol &&
                    Math.abs(crossQPR) <= Math.abs(crossRS) + tol &&
                    (crossQP === 0 || (crossQP > 0) === (crossRS > 0)) &&
                    (crossQPR === 0 || (crossQPR > 0) === (crossRS > 0));
      if (!inRange) return [];
      var t = crossQP / crossRS;
      return [{ x: p.x + r.x * t, y: p.y + r.y * t, exact: null }];
    }
    if (crossQPR !== 0) return [];

    var rlen2 = r.x * r.x + r.y * r.y;
    var t0 = (qp.x * r.x + qp.y * r.y) / rlen2;
    var t1 = ((qp.x + spr.x) * r.x + (qp.y + spr.y) * r.y) / rlen2;
    var flo = Math.max(0, Math.min(t0, t1));
    var fhi = Math.min(1, Math.max(t0, t1));
    if (flo > fhi) return [];
    var out = [{ x: p.x + r.x * flo, y: p.y + r.y * flo, exact: null }];
    if (fhi - flo > EPS / Math.sqrt(rlen2)) {
      out.push({ x: p.x + r.x * fhi, y: p.y + r.y * fhi, exact: null });
    }
    return out;
  }

  // ---------------------------------------------------------------- 图：路径提取

  function countComponents(n, adj) {
    var seen = new Array(n).fill(false);
    var count = 0;
    for (var i = 0; i < n; i++) {
      if (seen[i] || adj[i].length === 0) continue;
      count++;
      var stack = [i];
      seen[i] = true;
      while (stack.length) {
        var v = stack.pop();
        for (var k = 0; k < adj[v].length; k++) {
          var w = adj[v][k].other;
          if (!seen[w]) { seen[w] = true; stack.push(w); }
        }
      }
    }
    return count;
  }

  /*
   * 最大连续链分解，保证每条边恰好属于一条路径：
   *  - 每条边在其两个端点各记一个“半边”；非 2 度端点的半边为起点，
   *    从非 2 度节点出发，只穿过 2 度节点，到下一个非 2 度节点停止。
   *  - 剩余未使用边全部处于纯 2 度分量，即闭环；从其中编号最小节点
   *    出发绕一整圈。
   */
  function extractPaths(n, adj, edgesArr, edgeIdMap, nodesArr) {
    var used = {}; // edge id -> true
    var paths = [];

    function walk(startNode, firstEdge) {
      var nodeSeq = [startNode];
      var edgeSeq = [];
      var prevEdge = -1;
      var cur = startNode;
      var eid = firstEdge;
      while (true) {
        edgeSeq.push(eid);
        used[eid] = true;
        var e = edgesArr[eid];
        var nxt = e.from === cur ? e.to : e.from;
        nodeSeq.push(nxt);
        prevEdge = eid;
        cur = nxt;
        if (adj[cur].length !== 2) break;          // 到达下一个非 2 度节点
        var cont = null;
        for (var k = 0; k < adj[cur].length; k++) {
          if (adj[cur][k].edge !== prevEdge) { cont = adj[cur][k].edge; break; }
        }
        if (cont === null || used[cont]) break;    // 纯环闭合
        eid = cont;
      }
      return { nodes: nodeSeq, edges: edgeSeq };
    }

    // 开链：以每个非 2 度节点上的每条半边为潜在起点
    for (var v = 0; v < n; v++) {
      if (adj[v].length === 2) continue;
      var entries = adj[v].slice().sort(function (x, y) { return x.edge - y.edge; });
      for (var k = 0; k < entries.length; k++) {
        var eid0 = entries[k].edge;
        if (used[eid0]) continue;
        var chain = walk(v, eid0);
        var closed = chain.nodes[0] === chain.nodes[chain.nodes.length - 1];
        paths.push(normalizePath(chain.nodes, chain.edges, closed, nodesArr, edgesArr));
      }
    }

    // 纯 2 度分量：闭环
    for (var e = 0; e < edgesArr.length; e++) {
      if (used[e]) continue;
      var e0 = edgesArr[e];
      var start = Math.min(e0.from, e0.to);
      var chain = walk(start, e);
      // walk 在回到 start 时闭合（start 度为 2，沿唯一未走来边继续直到回到起点）
      var closed = chain.nodes[0] === chain.nodes[chain.nodes.length - 1];
      paths.push(normalizePath(chain.nodes, chain.edges, true, nodesArr, edgesArr));
    }

    // 按节点序列字典序排序
    paths.sort(function (p1, p2) {
      var a = p1.nodes, b = p2.nodes;
      for (var i = 0; i < Math.max(a.length, b.length); i++) {
        if (i >= a.length) return -1;
        if (i >= b.length) return 1;
        if (a[i] !== b[i]) return a[i] - b[i];
      }
      return 0;
    });
    return paths;
  }

  // 闭环：最小节点起步 + 笛卡尔逆时针；开链：从编号较小端开始。
  function normalizePath(nodeSeq, edgeSeq, closed, nodesArr, edgesArr) {
    if (!closed) {
      if (nodeSeq[0] > nodeSeq[nodeSeq.length - 1]) {
        nodeSeq = nodeSeq.slice().reverse();
        edgeSeq = edgeSeq.slice().reverse();
      }
      return { nodes: nodeSeq, edges: edgeSeq, closed: false };
    }

    // nodeSeq 首尾相同；去掉重复尾点再归一
    var ring = nodeSeq.slice(0, nodeSeq.length - 1);
    var ringEdges = edgeSeq.slice();

    // 旋转到最小节点
    var minNode = ring[0];
    var minPos = 0;
    for (var i = 1; i < ring.length; i++) {
      if (ring[i] < minNode) { minNode = ring[i]; minPos = i; }
    }
    ring = ring.slice(minPos).concat(ring.slice(0, minPos));
    ringEdges = ringEdges.slice(minPos).concat(ringEdges.slice(0, minPos));

    // 逆时针：从最小节点出发，精确面积应为正（y 向上，CCW 为正）；
    // 精确表示缺失时退回浮点符号。小环的浮点符号在平移后并不可靠，
    // 这正是面积走 BigInt 精确路径的原因。
    var ringSeq = ring.concat([ring[0]]);
    var exactSign = exactRingArea(ringSeq, nodesArr);
    var orientation = exactSign ? exactSign.sign() : Math.sign(signedArea(ringSeq, nodesArr));
    if (orientation < 0) {
      // 保持最小节点在首位，反转其余访问顺序：
      // [m,a,b,...,z] -> [m,z,...,b,a]；边序列整体反转
      ring = [ring[0]].concat(ring.slice(1).reverse());
      ringEdges = ringEdges.slice().reverse();
    }

    return {
      nodes: ring.concat([ring[0]]),
      edges: ringEdges,
      closed: true
    };
  }

  function signedArea(ringNodes, nodesArr) {
    var twice = 0;
    for (var i = 0; i + 1 < ringNodes.length; i++) {
      var a = nodesArr[ringNodes[i]], b = nodesArr[ringNodes[i + 1]];
      twice += a.x * b.y - b.x * a.y;
    }
    return twice / 2;
  }

  function unicodeCmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  return {
    EPS: EPS,
    validateDraft: validateDraft,
    repair: repair,
    // 供测试直接调用
    _segmentIntersections: segmentIntersections,
    _signedArea: signedArea,
    _PointIndex: PointIndex,
    _exactPoint: function (xn, yn, d) { return exactPoint(BigInt(xn), BigInt(yn), BigInt(d)); }
  };
});
