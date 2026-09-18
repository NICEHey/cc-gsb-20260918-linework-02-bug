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
 *      每对线段至多产生两个“事件点”，事件由两条线段共享，
 *      线段内按参数排序合并，再在组代表上做固定 1e-9 的传递闭包
 *   5. 按归并点切分小边；完全重合的小边只留一份，记录全部来源原始 ID
 *   6. 构图、统计、提取最大连续链（开链/闭环），闭环按最小编号起点 +
 *      笛卡尔逆时针归一并以 BigInt 有理分数精确计算面积
 *   7. 稳定排序、编号、六位小数输出（内部精度保留到最后一步）
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

  function lexLess(p, q) {
    if (p.x !== q.x) return p.x < q.x;
    return p.y < q.y;
  }

  // 并查集（编号小者为根，保证组代表选择稳定）
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

  // 两个 ×1000 格点分数点的欧氏距离是否 <= 1e-9（世界单位），BigInt 精确判定。
  // 世界差 = Δlattice/1000，条件 (Δx²+Δy²)/1000² <= 1e-18
  //   => (ΔX²+ΔY²)*1e12 <= (D1*D2)²
  function fracWithinEps(f1, f2) {
    var DX = f1.X * f2.D - f2.X * f1.D;
    var DY = f1.Y * f2.D - f2.Y * f1.D;
    var DD = f1.D * f2.D;
    return DX * DX + DY * DY <= DD * DD * 1000000000000n;
  }

  function round6(v) {
    // 避免 -0
    var r = Math.round(v * 1e6) / 1e6;
    return r === 0 ? 0 : r;
  }

  // BigInt 分数点（×1000 格点坐标，分母恒正）；端点/格点处 D=1
  function fracLattice(x, y) { return { X: BigInt(x), Y: BigInt(y), D: 1n }; }
  function fracWorld(f) { return { x: worldX(f), y: worldY(f) }; }
  function worldX(f) { return Number(f.X) / (1000 * Number(f.D)); }
  function worldY(f) { return Number(f.Y) / (1000 * Number(f.D)); }
  // 字典序精确比较（先 x 后 y）
  function fracCmp(a, b) {
    var lx = a.X * b.D, rx = b.X * a.D;
    if (lx !== rx) return lx < rx ? -1 : 1;
    var ly = a.Y * b.D, ry = b.Y * a.D;
    if (ly !== ry) return ly < ry ? -1 : 1;
    return 0;
  }
  function fracLexLess(a, b) { return fracCmp(a, b) < 0; }

  function bgcd(a, b) {
    if (a < 0n) a = -a;
    if (b < 0n) b = -b;
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }
  function fracAdd(aNum, aDen, bNum, bDen) {
    var num = aNum * bDen + bNum * aDen;
    var den = aDen * bDen;
    if (num === 0n) return { num: 0n, den: 1n };
    var g = bgcd(num, den);
    return { num: num / g, den: den / g };
  }
  // 数学 floor 除法（BigInt，除数为正）
  function floorDiv(a, b) {
    var q = a / b;
    if (a % b !== 0n && ((a < 0n) !== (b < 0n))) q -= 1n;
    return q;
  }
  // 坐标（×1000 格点分数 V/D）精确半入到六位小数，输出对应数值。
  // axis: 'X' 或 'Y'
  function round6Frac(f, axis) {
    var V = f[axis];
    // world*1e6 = V*1000/D；roundHalfUp(v)=floor(v+1/2)=floor((2*1000V+D)/(2D))
    var N = floorDiv(V * 2000n + f.D, f.D * 2n);
    var n = Number(N);
    var r = n / 1e6;
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

  function varKeys(o) { return Object.keys(o); }

  // ---------------------------------------------------------------- 修复主管线

  /*
   * 输入已通过 validateDraft 的草稿对象。
   * 返回完整修复结果（页面展示与 topology.json 导出共用这一份）。
   * yieldTick 为 null 时同步执行；否则在成对求交循环中分批 await，
   * 供浏览器在修复期间保持响应（同一份计算、同一份结果）。
   */
  function buildResult(draft, yieldTick) {
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

    var m = survivors.length;

    // 吸附目标全部取自原始端点（三位小数），×1000 后为整数格点；
    // 格点坐标 ≤ 1e7、方向 ≤ 2e7，叉积 ≤ 8e14，BigInt 下精确无误差。
    var lsegs = survivors.map(function (sgm) {
      var ax = Math.round(sgm.a.x * 1000), ay = Math.round(sgm.a.y * 1000);
      var bx = Math.round(sgm.b.x * 1000), by = Math.round(sgm.b.y * 1000);
      return {
        id: sgm.id,
        P: { x: ax, y: ay },
        R: { x: bx - ax, y: by - ay }
      };
    });

    // 4. 交点事件：每对线段至多两个事件，事件由两条线段共享。
    //    每条线段的两个端点先各建一个固定节点；对端接触/共线重叠边界直接复用
    //    这些端点节点，只有线段内部的一般交点才新建节点。
    //    这样 200 条完全重复线段产生 0 个新点，退化输入工作量随之坍缩。
    var dsuEv = new DSU(0);
    var perSeg = [];      // perSeg[i] = [{node, tn,td}] 本地参数事件（分数）
    var nodeAdded = [];   // 每条线段已挂载的节点集合（同节点在一条线上参数唯一）
    var evFrac = [];      // node -> 分数点 {X,Y,D}
    var endNodes = [];    // endNodes[i][0/1] 端点节点
    var dblNode = Object.create(null); // 双精度坐标键 -> 已建节点（同值交点直接复用）
    for (var z = 0; z < m; z++) {
      perSeg.push([]);
      nodeAdded.push(Object.create(null));
      var La = lsegs[z];
      var fA = fracLattice(La.P.x, La.P.y);
      var fB = fracLattice(La.P.x + La.R.x, La.P.y + La.R.y);
      var nA = dsuEv.add(), nB = dsuEv.add();
      evFrac.push(fA, fB);
      endNodes.push([nA, nB]);
      dblNode[worldX(fA) + ',' + worldY(fA)] = nA;
      dblNode[worldX(fB) + ',' + worldY(fB)] = nB;
      attachExisting(z, { n: 0n, d: 1n }, nA);
      attachExisting(z, { n: 1n, d: 1n }, nB);
    }

    function attachExisting(si, t, node) {
      if (nodeAdded[si][node]) return;
      nodeAdded[si][node] = 1;
      perSeg[si].push({ node: node, tn: BigInt(t.n), td: BigInt(t.d) });
    }
    function attachPair(u, v, ev) {
      // 事件点命中某条线段的原端点时复用该端点节点；
      // 否则同 double 坐标的已有内部交点节点直接复用（多线共点），
      // 再否则新建。近而不等的点交给后面的 1e-9 网格闭包。
      var node;
      if (ev.endA >= 0) node = endNodes[u][ev.endA];
      else if (ev.endB >= 0) node = endNodes[v][ev.endB];
      else {
        var wx = worldX(ev.point), wy = worldY(ev.point);
        var dk = wx + ',' + wy;
        if (dblNode[dk] !== undefined) {
          node = dblNode[dk];
        } else {
          node = dsuEv.add();
          evFrac.push(ev.point);
          dblNode[dk] = node;
        }
      }
      attachExisting(u, ev.ta, node);
      attachExisting(v, ev.tb, node);
    }

    function pairStep(u) {
      for (var v = u + 1; v < m; v++) {
        var evs = pairEvents(lsegs[u], lsegs[v]);
        for (var k = 0; k < evs.length; k++) attachPair(u, v, evs[k]);
      }
    }
    if (yieldTick) {
      return runPairLoopAsync().then(finize);
    }
    for (var u = 0; u < m; u++) pairStep(u);
    return finize();

    function runPairLoopAsync() {
      return new Promise(function (resolve) {
        var u = 0;
        function now() {
          return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
        }
        function step() {
          // 自适应时间片：每块最多占用约 8ms 主线程再让出，
          // 小输入一块内做完，不会产生成百上千次调度开销
          var t0 = now();
          do {
            pairStep(u);
            u++;
          } while (u < m && now() - t0 < 8);
          if (u >= m) resolve();
          else setTimeout(step, 0);
        }
        step();
      });
    }

    function finize() {
      // 4b. 全局同点归一：
      //   (a) 双精度精确相等通道：同值 double 有相同最短往返字符串键。
      //       合法坐标 |x|≤1e4 下，两个 double 相等意味着真实坐标差至多
      //       约 1.1e-12（< 1e-9），直接合并安全。200 线共点产生的 ~4 万个
      //       交点事件由此立刻坍缩，无需逐点做大整数约分。
      //   (b) 近点传递闭包：对每个互异 double 点入 1e-9 网格，邻域候选用
      //       BigInt 精确距离判定 union。长 ε 链由并查集自动传递闭包。
      //     每个 1e-9 桶内互异 double 点只有 packing 常数规模，总工作量近线性。
      var dblKeyNode = Object.create(null);
      var uniquePts = []; // [{node,f,wx,wy}]
      for (var n4 = 0; n4 < evFrac.length; n4++) {
        var f = evFrac[n4];
        var wxf = worldX(f), wyf = worldY(f);
        var dkey = wxf + ',' + wyf;
        var prevNode = dblKeyNode[dkey];
        if (prevNode !== undefined) {
          dsuEv.union(n4, prevNode);
        } else {
          dblKeyNode[dkey] = n4;
          uniquePts.push({ node: n4, f: f, wx: wxf, wy: wyf });
        }
      }

      var W = 1 / EPS; // 网格桶宽 1e-9（世界单位）
      var buckets = Object.create(null);
      function bkey(cx, cy) { return cx + ',' + cy; }
      for (var up = 0; up < uniquePts.length; up++) {
        var f = uniquePts[up].f;
        var cx = Math.floor(uniquePts[up].wx * W), cy = Math.floor(uniquePts[up].wy * W);
        // 距离 <=1e-9 时桶号至多相差 1；大坐标下浮点取桶可能有 1 格误差，扫 ±2。
        for (var gx = cx - 2; gx <= cx + 2; gx++) {
          for (var gy = cy - 2; gy <= cy + 2; gy++) {
            var arr = buckets[bkey(gx, gy)];
            if (!arr) continue;
            for (var bi = 0; bi < arr.length; bi++) {
              if (fracWithinEps(f, arr[bi].f)) dsuEv.union(uniquePts[up].node, arr[bi].node);
            }
          }
        }
        var key = bkey(cx, cy);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(uniquePts[up]);
      }

      // 最终组：代表 = 组内字典序最小点（BigInt 精确比较）
      var groups = []; // root -> gid
      var groupFrac = [];
      var nodeOfRoot = Object.create(null);
      for (var n3 = 0; n3 < evFrac.length; n3++) {
        var r2 = dsuEv.find(n3);
        if (!(r2 in nodeOfRoot)) {
          nodeOfRoot[r2] = groups.length;
          groups.push(r2);
          groupFrac.push(null);
        }
        var gid = nodeOfRoot[r2];
        if (groupFrac[gid] === null || fracLexLess(evFrac[n3], groupFrac[gid])) {
          groupFrac[gid] = evFrac[n3];
        }
      }
      function gidOf(node) { return nodeOfRoot[dsuEv.find(node)]; }

      // 5. 切分小边：每条线段沿参数取有序组，相邻组之间一条小边；
      //    完全重合的小边（端点组相同）只留一份，sources 记录全部原始线段。
      var edgeMap = Object.create(null); // "g1-g2" -> {sources}
      function edgeKey(g1, g2) { return g1 < g2 ? g1 + '-' + g2 : g2 + '-' + g1; }
      for (var sg = 0; sg < m; sg++) {
        var chain = [];
        var seenG = Object.create(null);
        var lst = perSeg[sg];
        for (var sp = 0; sp < lst.length; sp++) {
          var g = gidOf(lst[sp].node);
          if (!seenG[g]) { seenG[g] = 1; chain.push({ g: g, tn: lst[sp].tn, td: lst[sp].td }); }
        }
        chain.sort(function (a, b) {
          var lhs = a.tn * b.td, rhs = b.tn * a.td;
          return lhs < rhs ? -1 : lhs > rhs ? 1 : 0;
        });
        for (var ck = 0; ck + 1 < chain.length; ck++) {
          var gA = chain[ck].g, gB = chain[ck + 1].g;
          if (gA === gB) continue; // 归一后两端相同的小边忽略
          var ek = edgeKey(gA, gB);
          if (!edgeMap[ek]) edgeMap[ek] = { a: Math.min(gA, gB), b: Math.max(gA, gB), sources: Object.create(null) };
          edgeMap[ek].sources[lsegs[sg].id] = 1;
        }
      }

      // 数值坐标只用于长度与绘制；节点排序/面积一律走分数精确值
      var groupWorld = groupFrac.map(fracWorld);
      var G = groups.length;

      var rawEdges = Object.keys(edgeMap).map(function (k) {
        var e = edgeMap[k];
        return {
          from: e.a, to: e.b,
          sources: Object.keys(e.sources).sort(unicodeCmp),
          length: dist(groupWorld[e.a].x, groupWorld[e.a].y,
                       groupWorld[e.b].x, groupWorld[e.b].y)
        };
      });

      // 节点按 (x,y) 字典序精确排序编号
      var nodeOrder = [];
      for (var ng = 0; ng < G; ng++) nodeOrder.push(ng);
      nodeOrder.sort(function (a, b) { return fracCmp(groupFrac[a], groupFrac[b]); });
      var nodeId = new Array(G);
      nodeOrder.forEach(function (gid, idx) { nodeId[gid] = idx; });
      var nodeFracById = nodeOrder.map(function (gid) { return groupFrac[gid]; });
      var nodeWorldById = nodeOrder.map(function (gid) { return groupWorld[gid]; });

      var edgesArr = rawEdges.map(function (e) {
        var ia = nodeId[e.from], ib = nodeId[e.to];
        return {
          from: Math.min(ia, ib), to: Math.max(ia, ib),
          sources: e.sources, length: e.length
        };
      });
      edgesArr.sort(function (e1, e2) {
        if (e1.from !== e2.from) return e1.from - e2.from;
        return e1.to - e2.to;
      });

      // 无向图邻接表
      var n = G;
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

      // 6. 路径分解
      var paths = extractPaths(n, adj, edgesArr, nodeFracById);

      // 7. 输出：面积/坐标精确分数保留到最后一步再舍入；长度按完整双精度后舍入
      var outNodes = nodeWorldById.map(function (wp, idx) {
        var ff = nodeFracById[idx];
        return { id: idx, x: round6Frac(ff, 'X'), y: round6Frac(ff, 'Y'), degree: adj[idx].length };
      });
      var outEdges = edgesArr.map(function (e, idx) {
        return { id: idx, from: e.from, to: e.to, sources: e.sources.slice(), length: round6(e.length) };
      });
      var outPaths = paths.map(function (pth, idx) {
        var srcSet = Object.create(null);
        pth.edges.forEach(function (eid) { edgesArr[eid].sources.forEach(function (s) { srcSet[s] = 1; }); });
        var length = 0;
        for (var li = 0; li + 1 < pth.nodes.length; li++) {
          var wa = nodeWorldById[pth.nodes[li]], wb2 = nodeWorldById[pth.nodes[li + 1]];
          length += dist(wa.x, wa.y, wb2.x, wb2.y);
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
          // area*1e6 = |F|/2（F 为 ×1000 格点下的 twice-area 分数），
          // 直接在 BigInt 上半入：roundHalfUp(|F|/2)=floor((|num|+den)/(2den))
          var af = ringAreaFrac(pth.nodes, nodeFracById); // {num,den}，已按方向取正
          var N = floorDiv(af.num + af.den, af.den * 2n);
          var area6 = Number(N) / 1e6;
          out.area = area6 === 0 ? 0 : area6;
        }
        return out;
      });

      var openCount = 0, ringCount = 0;
      outPaths.forEach(function (p) { if (p.closed) ringCount++; else openCount++; });

      diagnostics.sort(function (d1, d2) {
        if (d1.code !== d2.code) return d1.code < d2.code ? -1 : 1;
        var a = d1.sources.join(' '), b = d2.sources.join(' ');
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
  }

  function repair(draft) {
    return buildResult(draft, null);
  }

  // 浏览器用：分批让出事件循环的同一份修复；Node 测试仍走同步 repair()
  function repairAsync(draft) {
    return buildResult(draft, function (cont) { setTimeout(cont, 0); });
  }

  // ---------------------------------------------------------------- 几何：求交

  /*
   * 两条格点线段的全部交点事件。
   * 坐标均为三位小数端点吸附而来，×1000 为整数，分类与参数全部用整数精确给出。
   * 返回 [{t1n,t1d,t2n,t2d,point:{X,Y,D}}]：
   *   t1/t2 为两条线段上的参数（分数，分母恒正，范围 [0,1]）；
   *   point 为 ×1000 格点下的分数点（端点 D=1）。
   * 共线重叠返回重叠区间端点（0/1/2 个）。
   */
  function pairEvents(L1, L2) {
    var P = L1.P, R = L1.R, Q = L2.P, S = L2.R;
    var QPx = Q.x - P.x, QPy = Q.y - P.y;
    var cRS = R.x * S.y - R.y * S.x;       // r × s
    var cQP = QPx * S.y - QPy * S.x;       // (q-p) × s
    var cQPR = QPx * R.y - QPy * R.x;      // (q-p) × r
    // 参数分数（分母取正）
    function tf(num, den) {
      if (den < 0) return { n: -num, d: -den };
      return { n: num, d: den };
    }
    // endA/endB：事件点分别命中 L1/L2 的哪个原端点（0/1），内部点为 -1
    function ev(ta, tb, point, endA, endB) {
      return { ta: ta, tb: tb, point: point, endA: endA, endB: endB };
    }

    if (cRS !== 0) {
      // 非平行：t = cQP/cRS ∈ [0,1]，u = cQPR/cRS ∈ [0,1]
      var inRange = (cQP === 0 || sameSign(cQP, cRS)) && Math.abs(cQP) <= Math.abs(cRS) &&
                    (cQPR === 0 || sameSign(cQPR, cRS)) && Math.abs(cQPR) <= Math.abs(cRS);
      if (!inRange) return [];
      var t1f = tf(cQP, cRS), t2f = tf(cQPR, cRS);
      var hitA = cQP === 0 ? 0 : (cQP === cRS ? 1 : -1);
      var hitB = cQPR === 0 ? 0 : (cQPR === cRS ? 1 : -1);
      if (hitA >= 0) return [ev(t1f, t2f, fracLattice(L1.P.x + (hitA ? L1.R.x : 0), L1.P.y + (hitA ? L1.R.y : 0)), hitA, hitB)];
      if (hitB >= 0) return [ev(t1f, t2f, fracLattice(L2.P.x + (hitB ? L2.R.x : 0), L2.P.y + (hitB ? L2.R.y : 0)), hitA, hitB)];
      // 一般交点：X = (P.x*cRS + R.x*cQP)/cRS。
      // 乘积可达 ~8e14，必须在 BigInt 内相乘，不能先做 Number 乘法。
      // 分母统一取正，cRS<0 时分子同步取负。
      var Px = BigInt(P.x), Py = BigInt(P.y), Rx = BigInt(R.x), Ry = BigInt(R.y);
      var dRS = BigInt(cRS), dQP = BigInt(cQP);
      var Nx = Px * dRS + Rx * dQP;
      var Ny = Py * dRS + Ry * dQP;
      if (dRS < 0n) { dRS = -dRS; Nx = -Nx; Ny = -Ny; }
      return [ev(t1f, t2f, { X: Nx, Y: Ny, D: dRS }, -1, -1)];
    }

    // 平行不共线
    if (cQPR !== 0) return [];

    // 共线：在 L1 方向上的整数投影
    var d = R.x * R.x + R.y * R.y;
    var e0 = QPx * R.x + QPy * R.y;                 // L2.a 在 L1 上的投影
    var e1 = e0 + S.x * R.x + S.y * R.y;            // L2.b 的投影
    var lo = Math.max(0, Math.min(e0, e1));
    var hi = Math.min(d, Math.max(e0, e1));
    if (lo > hi) return [];
    var dotSR = S.x * R.x + S.y * R.y;              // 非零（共线且非退化）
    function evAt(k) {
      // k 为 L1 方向上的整数投影；事件点落在哪个原端点就标注哪个端点
      var isA0 = k === 0, isA1 = k === d;
      var isB0 = k === e0, isB1 = k === e1;
      var endA = isA0 ? 0 : (isA1 ? 1 : -1);
      var endB = isB0 ? 0 : (isB1 ? 1 : -1);
      var px, py;
      if (isA0) { px = P.x; py = P.y; }
      else if (isA1) { px = P.x + R.x; py = P.y + R.y; }
      else if (isB0) { px = Q.x; py = Q.y; }
      else if (isB1) { px = Q.x + S.x; py = Q.y + S.y; }
      if (endA >= 0 || endB >= 0) {
        return ev(tf(k, d), tf(k - e0, dotSR), fracLattice(px, py), endA, endB);
      }
      // 理论上不会到达：重叠区间端点必为四条原端点之一。
      // 仍以 BigInt 精确构造分数 (P*d + R*k)/d，避免 Number 乘积溢出。
      var bK = BigInt(k), bD = BigInt(d);
      return ev(tf(k, d), tf(k - e0, dotSR), {
        X: BigInt(P.x) * bD + BigInt(R.x) * bK,
        Y: BigInt(P.y) * bD + BigInt(R.y) * bK,
        D: bD
      }, -1, -1);
    }
    if (lo === hi) return [evAt(lo)];
    return [evAt(lo), evAt(hi)];
  }

  function sameSign(a, b) { return (a > 0 && b > 0) || (a < 0 && b < 0); }

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
   *  - 非 2 度节点上的每条半边为起点，只穿过 2 度节点，到下一个非 2 度节点停止。
   *  - 剩余未使用边全部处于纯 2 度分量，即闭环；从其中编号最小节点出发绕一整圈。
   */
  function extractPaths(n, adj, edgesArr, nodeFracById) {
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
        paths.push(normalizePath(chain.nodes, chain.edges, closed, nodeFracById));
      }
    }

    // 纯 2 度分量：闭环
    for (var e = 0; e < edgesArr.length; e++) {
      if (used[e]) continue;
      var e0 = edgesArr[e];
      var start = Math.min(e0.from, e0.to);
      var chain = walk(start, e);
      paths.push(normalizePath(chain.nodes, chain.edges, true, nodeFracById));
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
  function normalizePath(nodeSeq, edgeSeq, closed, nodeFracById) {
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

    // 逆时针：从最小节点出发，格点 twice-area 应为正（y 向上，CCW 为正）；
    // 用 BigInt 分数判定符号，近平移/小环也不会被浮点误差翻转。
    var areaF = ringTwiceAreaFrac(ring, nodeFracById);
    if (areaF.num < 0n) {
      // 保持最小节点在首位，反转其余访问顺序
      ring = [ring[0]].concat(ring.slice(1).reverse());
      ringEdges = ringEdges.slice().reverse();
    }

    return {
      nodes: ring.concat([ring[0]]),
      edges: ringEdges,
      closed: true
    };
  }

  // 格点分数坐标下的 twice-area 分数 F = Σ (X_i Y_j − X_j Y_i)/(D_i D_j)
  function ringTwiceAreaFrac(ringNodes, nodeFracById) {
    var num = 0n, den = 1n;
    for (var i = 0; i < ringNodes.length; i++) {
      var a = nodeFracById[ringNodes[i]];
      var b = nodeFracById[ringNodes[(i + 1) % ringNodes.length]];
      var termNum = a.X * b.Y - b.X * a.Y;
      var termDen = a.D * b.D;
      var s = fracAdd(num, den, termNum, termDen);
      num = s.num; den = s.den;
    }
    return { num: num, den: den };
  }

  // 闭环面积分数（已按归一方向取正），调用方保证路径已 CCW 归一；
  // 这里独立重算符号并取绝对值，不依赖调用次序。
  function ringAreaFrac(pathNodes, nodeFracById) {
    var ring = pathNodes.slice(0, pathNodes.length - 1);
    var f = ringTwiceAreaFrac(ring, nodeFracById);
    if (f.num < 0n) f.num = -f.num;
    return f; // |F|（分母为正）
  }

  function unicodeCmp(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  return {
    EPS: EPS,
    validateDraft: validateDraft,
    repair: repair,
    repairAsync: repairAsync,
    // 供测试直接调用
    _pairEvents: pairEvents,
    _ringTwiceAreaFrac: ringTwiceAreaFrac
  };
});
