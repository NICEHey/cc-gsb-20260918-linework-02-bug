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
 *   4. 在吸附后线段上求全部交点（端点落内部 / 十字交叉 / 共线重叠端点）
 *   5. 收集全部端点与交点，按欧氏距离 <= 1e-9 取传递闭包并归并
 *   6. 按归并点切分小边；完全重合的小边只留一份，记录全部来源原始 ID
 *   7. 构图、统计、提取最大连续链（开链/闭环），闭环按最小编号起点 +
 *      笛卡尔逆时针归一并计算面积
 *   8. 稳定排序、编号、六位小数输出
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

    // 4 & 5. 收集端点与全部交点；1e-9 同点归并（传递闭包 + 网格哈希）
    var pts = [];
    var dsuP = new DSU(0);
    var GRID = Math.max(EPS, 1e-9);
    var cellBuckets = Object.create(null); // 网格桶，存点索引
    function cellKey(cx, cy) { return cx + ':' + cy; }
    function addPoint(p) {
      var cx = Math.floor(p.x / GRID), cy = Math.floor(p.y / GRID);
      // 始终建点并与所有距离 <= EPS 的旧点 union，保证传递闭包不丢链。
      // 距离恰为一格时两点可能相隔两个桶，故扫描 ±2 邻域。
      var idx = dsuP.add();
      pts.push({ x: p.x, y: p.y });
      for (var gx = cx - 2; gx <= cx + 2; gx++) {
        for (var gy = cy - 2; gy <= cy + 2; gy++) {
          var bucket = cellBuckets[cellKey(gx, gy)];
          if (!bucket) continue;
          for (var bi = 0; bi < bucket.length; bi++) {
            var j = bucket[bi];
            if (dist2(pts[j].x, pts[j].y, p.x, p.y) <= EPS * EPS) dsuP.union(idx, j);
          }
        }
      }
      var key = cellKey(cx, cy);
      if (!cellBuckets[key]) cellBuckets[key] = [];
      cellBuckets[key].push(idx);
      return idx;
    }

    var segPointIds = []; // 每条幸存线段上挂的点索引（端点 + 与之相关的全部交点）
    for (var ss = 0; ss < survivors.length; ss++) {
      var iA = addPoint(survivors[ss].a);
      var iB = addPoint(survivors[ss].b);
      segPointIds.push([iA, iB]);
    }

    // 逐对线段求交点（含 T 接、十字、共线重叠段的端点）。
    // 分类由整数谓词精确给出，交点直接挂到两条线段上，
    // 不再做事后“点在线上”复检（近平行时浮点交点可能偏离直线 >1e-9）。
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

    var pg = Object.create(null);
    var canonReady = false;
    function buildCanon() {
      // 单次遍历：每个并查集根取组内字典序最小的点
      for (var k = 0; k < pts.length; k++) {
        var root = dsuP.find(k);
        var cur = pg[root];
        if (!cur || lexLess(pts[k], cur)) pg[root] = pts[k];
      }
      canonReady = true;
    }
    function canon(pi) {
      if (!canonReady) buildCanon();
      return pg[dsuP.find(pi)];
    }

    // 6. 切分小边：每条幸存线段只取挂在它上面的归并点，按参数排序
    var edgeMap = Object.create(null); // "x,y|x,y"（排序后）-> {a,b,sourceSet}
    function pointKey(p) {
      // 用内部精度坐标构造键；同一点已由 DSU 归并为同一对象
      return p.x + ',' + p.y;
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
      var ax = S.a.x, ay = S.a.y, dx = S.b.x - S.a.x, dy = S.b.y - S.a.y;
      var len2 = dx * dx + dy * dy;
      onSeg.sort(function (r, t) {
        var pr = ((r.x - ax) * dx + (r.y - ay) * dy) / len2;
        var pt = ((t.x - ax) * dx + (t.y - ay) * dy) / len2;
        return pr - pt;
      });
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
      return { a: e.a, b: e.b, sources: sources, length: dist(e.a.x, e.a.y, e.b.x, e.b.y) };
    });

    // 7. 唯一节点：按 (x,y) 排序编号
    var nodeMap = Object.create(null);
    var nodesArr = [];
    rawEdges.forEach(function (e) { [e.a, e.b].forEach(function (p) {
      var k = pointKey(p);
      if (!nodeMap[k]) { nodeMap[k] = p; nodesArr.push(p); }
    }); });
    nodesArr.sort(function (p, q) { return lexLess(p, q) ? -1 : lexLess(q, p) ? 1 : 0; });
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
      return { id: idx, x: round6(p.x), y: round6(p.y), degree: adj[idx].length };
    });
    var outEdges = edgesArr.map(function (e, idx) {
      return { id: idx, from: e.from, to: e.to, sources: e.sources.slice(), length: round6(e.length) };
    });
    var outPaths = paths.map(function (pth, idx) {
      var srcSet = Object.create(null);
      pth.edges.forEach(function (eid) { edgesArr[eid].sources.forEach(function (s) { srcSet[s] = 1; }); });
      var length = 0;
      for (var li = 0; li + 1 < pth.nodes.length; li++) {
        length += dist(nodesArr[pth.nodes[li]].x, nodesArr[pth.nodes[li]].y,
                       nodesArr[pth.nodes[li + 1]].x, nodesArr[pth.nodes[li + 1]].y);
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
      if (pth.closed) out.area = round6(Math.abs(signedArea(pth.nodes, nodesArr)));
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

  // 两线段的全部交点（含端点接触、T 接；共线时返回重叠区间端点）
  function segmentIntersections(s1, s2) {
    var p = s1.a, r = { x: s1.b.x - s1.a.x, y: s1.b.y - s1.a.y };
    var q = s2.a, spr = { x: s2.b.x - s2.a.x, y: s2.b.y - s2.a.y };
    var qp = { x: q.x - p.x, y: q.y - p.y };

    // 整数精确谓词（本阶段坐标均为三位小数；理论上必然成立）
    var P = { x: asInt1000(p.x), y: asInt1000(p.y) };
    var R = { x: asInt1000(r.x), y: asInt1000(r.y) };
    var Q = { x: asInt1000(q.x), y: asInt1000(q.y) };
    var S = { x: asInt1000(spr.x), y: asInt1000(spr.y) };
    var exact = P.x !== null && R.x !== null && Q.x !== null && S.x !== null &&
                P.y !== null && R.y !== null && Q.y !== null && S.y !== null;

    var crossRS, crossQP, crossQPR;
    if (exact) {
      var QP = { x: Q.x - P.x, y: Q.y - P.y };
      crossRS = R.x * S.y - R.y * S.x;
      crossQP = QP.x * S.y - QP.y * S.x;
      crossQPR = QP.x * R.y - QP.y * R.x;
    } else {
      crossRS = r.x * spr.y - r.y * spr.x;
      crossQP = qp.x * spr.y - qp.y * spr.x;
      crossQPR = qp.x * r.y - qp.y * r.x;
    }

    if (crossRS !== 0) {
      // 非平行：t = (q-p)×s / (r×s) ∈ [0,1]，u = (q-p)×r / (r×s) ∈ [0,1]
      var inRange;
      if (exact) {
        inRange = (crossQP === 0 || sameSign(crossQP, crossRS)) &&
          Math.abs(crossQP) <= Math.abs(crossRS) &&
          (crossQPR === 0 || sameSign(crossQPR, crossRS)) &&
          Math.abs(crossQPR) <= Math.abs(crossRS);
      } else {
        var tol = EPS * Math.max(1, Math.abs(crossRS));
        inRange = Math.abs(crossQP) <= Math.abs(crossRS) + tol &&
                  Math.abs(crossQPR) <= Math.abs(crossRS) + tol &&
                  (crossQP === 0 || sameSign(crossQP, crossRS)) &&
                  (crossQPR === 0 || sameSign(crossQPR, crossRS));
      }
      if (!inRange) return [];
      var t = crossQP / crossRS;
      return [{ x: p.x + r.x * t, y: p.y + r.y * t }];
    }

    // 平行：不共线则无交点
    if (crossQPR !== 0) return [];

    // 共线：把端点投影到 s1 方向。整数情形比较整数投影，精确无容差。
    var pt0, pt1;
    if (exact) {
      var d = R.x * R.x + R.y * R.y;
      var e0 = (Q.x - P.x) * R.x + (Q.y - P.y) * R.y;
      var e1 = e0 + S.x * R.x + S.y * R.y;
      var lo = Math.max(0, Math.min(e0, e1));
      var hi = Math.min(d, Math.max(e0, e1));
      if (lo > hi) return [];
      pt0 = projectionPoint(lo, d, p, r, s2, e0, e1, q, spr);
      if (hi === lo) return [pt0];
      pt1 = projectionPoint(hi, d, p, r, s2, e0, e1, q, spr);
      return [pt0, pt1];
    }

    var rlen2 = r.x * r.x + r.y * r.y;
    var t0 = (qp.x * r.x + qp.y * r.y) / rlen2;
    var t1 = ((qp.x + spr.x) * r.x + (qp.y + spr.y) * r.y) / rlen2;
    var flo = Math.max(0, Math.min(t0, t1));
    var fhi = Math.min(1, Math.max(t0, t1));
    if (flo > fhi) return [];
    var out = [{ x: p.x + r.x * flo, y: p.y + r.y * flo }];
    if (fhi - flo > EPS / Math.sqrt(rlen2)) {
      out.push({ x: p.x + r.x * fhi, y: p.y + r.y * fhi });
    }
    return out;
  }

  function sameSign(a, b) { return (a > 0 && b > 0) || (a < 0 && b < 0); }

  // 共线重叠边界：整数投影 k 落在哪个原端点上就复用该端点（保证同点归一精确）
  function projectionPoint(k, d, p, r, s2, e0, e1, q, spr) {
    if (k === 0) return { x: p.x, y: p.y };
    if (k === d) return { x: p.x + r.x, y: p.y + r.y };
    if (k === e0) return { x: q.x, y: q.y };
    if (k === e1) return { x: q.x + spr.x, y: q.y + spr.y };
    var t = k / d;
    return { x: p.x + r.x * t, y: p.y + r.y * t };
  }

  // 点是否落在线段上：三位小数坐标用整数谓词精确判定，否则用欧氏距离 tol
  function pointOnSegment(p, s, tol) {
    var a = s.a, b = s.b;
    var px = asInt1000(p.x), py = asInt1000(p.y);
    var ax = asInt1000(a.x), ay = asInt1000(a.y);
    var bx = asInt1000(b.x), by = asInt1000(b.y);
    if (px !== null && py !== null && ax !== null && ay !== null && bx !== null && by !== null) {
      var dx = bx - ax, dy = by - ay;
      if (dx * (py - ay) - dy * (px - ax) !== 0) return false;
      var dot = (px - ax) * dx + (py - ay) * dy;
      return dot >= 0 && dot <= dx * dx + dy * dy;
    }
    var fx = b.x - a.x, fy = b.y - a.y;
    var ab = Math.sqrt(fx * fx + fy * fy);
    if (ab === 0) return dist(p.x, p.y, a.x, a.y) <= tol;
    if (Math.abs(fx * (p.y - a.y) - fy * (p.x - a.x)) / ab > tol) return false;
    var proj = ((p.x - a.x) * fx + (p.y - a.y) * fy) / ab;
    return proj >= -tol && proj <= ab + tol;
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

    // 逆时针：从最小节点出发，面积应为正（y 向上，CCW 为正）
    var area = signedArea(ring.concat([ring[0]]), nodesArr);
    if (area < 0) {
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
    _signedArea: signedArea
  };
});
