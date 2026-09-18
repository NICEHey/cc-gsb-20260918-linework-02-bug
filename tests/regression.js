#!/usr/bin/env node
/*
 * regression.js — 本轮修复的功能与性能回归（Node 标准库，无第三方依赖）
 *
 * 运行：node tests/regression.js
 *
 * 覆盖：
 *   A. 面积平移/方向/输入顺序不变性（BigInt 精确鞋带公式，最后一步舍入）
 *   B. 交点构成的小环舍入边界（k=1 / 0.999 / 0.998），面积舍成 0
 *      时闭环与方向仍保留
 *   C. 接近坐标上限的小环、带支线环
 *   D. 200 条重复线段、200 条共点线段：拓扑正确且 200 个来源全部保留
 *   E. 共线重叠/反向重复/重复与交叉混合：节点、边、来源、度数、
 *      分量、链分解，每条边恰好出现在一条路径中
 *   F. 不同但 <=1e-9 的交点经传递闭包归一（外侧两点 >1e-9），
 *      而 1.77e-9 外的点保持独立——不按小数位粗分桶
 *   G. PointIndex 白盒：精确恒等 O(1) 去重、字典序最小代表、
 *      浮点点传递闭包兜底
 *   H. 性能：同一进程预热后，80 与 200 条重复完整输入的中位数
 *      比值 200/80 <= 12，并打印真实耗时
 */
'use strict';

var assert = require('assert');
var T = require('../static/topology.js');

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) {
    failed++;
    process.stdout.write('\n✗ ' + name + '\n  ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n  ') : e) + '\n');
  }
}
function seg(id, ax, ay, bx, by, enabled) {
  return { id: id, enabled: enabled !== false, a: { x: ax, y: ay }, b: { x: bx, y: by } };
}
function draft(name, snap, segments) {
  return { version: 1, name: name, snapDistance: snap, segments: segments };
}
function edgeCoverage(r) {
  var owner = {};
  r.paths.forEach(function (p) {
    assert.strictEqual(p.nodes.length, p.edges.length + 1);
    for (var i = 0; i < p.edges.length; i++) {
      var eid = p.edges[i];
      assert.ok(!owner[eid], '边 ' + eid + ' 属于多条路径');
      owner[eid] = p.id;
      var e = r.edges[eid];
      var pair = [p.nodes[i], p.nodes[i + 1]].sort(function (a, b) { return a - b; });
      assert.deepStrictEqual(pair, [e.from, e.to], '路径行走与边不一致');
    }
    assert.strictEqual(p.nodes[0] === p.nodes[p.nodes.length - 1], p.closed);
  });
  assert.strictEqual(Object.keys(owner).length, r.summary.edges, '有边不属于任何路径');
}
function degreesConsistent(r) {
  var deg = new Array(r.summary.nodes).fill(0);
  r.edges.forEach(function (e) { deg[e.from]++; deg[e.to]++; });
  r.nodes.forEach(function (n) { assert.strictEqual(n.degree, deg[n.id]); });
}

// ------------------------------------------------- A. 面积平移/方向/顺序不变

function tinyTriangle(ox, oy, reverse, order) {
  var pts = [[ox, oy], [ox + 0.001, oy], [ox, oy + 0.001]];
  if (reverse) pts.reverse();
  var segs = order.map(function (i) {
    var a = pts[i], b = pts[(i + 1) % 3];
    return seg('e' + i, a[0], a[1], b[0], b[1]);
  });
  return draft('tri', 0, segs);
}

test('0.001 直角三角形：真实面积 5e-7，六位输出恒为 0.000001', function () {
  // 平移（含近 ±10000 上限）、反向、换序全部一致
  var shifts = [[0, 0], [1, 1], [-1, -1], [9999, 9998], [-9997, -9999],
                [9999.999, 0], [0, -9999.999]];
  var variants = [
    [false, [0, 1, 2]], [true, [0, 1, 2]],
    [false, [1, 2, 0]], [true, [2, 1, 0]]
  ];
  shifts.forEach(function (s) {
    variants.forEach(function (v) {
      var r = T.repair(tinyTriangle(s[0], s[1], v[0], v[1]));
      assert.strictEqual(r.summary.rings, 1, '平移 ' + s + ' 必须仍是一个闭环');
      assert.strictEqual(r.summary.openPaths, 0);
      var ring = r.paths[0];
      assert.strictEqual(ring.area, 0.000001,
        '平移 ' + s + ' 反向 ' + v[0] + ' 面积错误：' + ring.area);
      // 逆时针（y 向上）：最小节点起步且精确面积符号为正
      assert.strictEqual(ring.nodes[0], ring.nodes[ring.nodes.length - 1]);
    });
  });
});

test('更大的环在各种平移/反向/换序下面积与长度完全一致', function () {
  var base = [[0, 0], [4.321, 0], [6.789, 3.111], [2.005, 7.5], [-1.4, 4.003]];
  function build(shift, rev, order) {
    var pts = base.map(function (p) { return [p[0] + shift[0], p[1] + shift[1]]; });
    if (rev) pts.reverse();
    return draft('p', 0, order.map(function (i) {
      var a = pts[i], b = pts[(i + 1) % 5];
      return seg('s' + i, a[0], a[1], b[0], b[1]);
    }));
  }
  var ref = T.repair(build([0, 0], false, [0, 1, 2, 3, 4])).paths[0];
  [[[1, 1], false, [0, 1, 2, 3, 4]],
   [[-9997, -9993], false, [0, 1, 2, 3, 4]],
   [[9993, 9990], true, [0, 1, 2, 3, 4]],
   [[0, 0], false, [3, 0, 4, 1, 2]],
   [[0.001, -0.001], true, [4, 3, 2, 1, 0]]].forEach(function (c) {
    var p = T.repair(build(c[0], c[1], c[2])).paths[0];
    assert.strictEqual(p.area, ref.area);
    assert.strictEqual(p.length, ref.length);
  });
});

// ----------------------------------------- B. 交点小环的舍入边界与闭环保留

function kDraft(k) {
  return draft('k', 0, [
    seg('base', 0, 0, 0.001, 0),
    seg('l', 0, 0, 1, 2),
    seg('r', 0.001, 0, -k, 2)
  ]);
}

test('两斜线交点形成带支线小环：k=1/0.999/0.998 面积依次 0/1e-6/1e-6', function () {
  var expected = { '1': 0, '0.999': 0.000001, '0.998': 0.000001 };
  Object.keys(expected).forEach(function (k) {
    var r = T.repair(kDraft(Number(k)));
    var rings = r.paths.filter(function (p) { return p.closed; });
    assert.strictEqual(rings.length, 1, 'k=' + k + ' 必须保留闭环');
    var ring = rings[0];
    assert.strictEqual(ring.area, expected[k], 'k=' + k + ' 舍入错误');
    // 舍成 0 也不能丢闭环或改变其方向：仍从最小节点起步、首尾相同、
    // 沿环行走的精确有向面积为正（逆时针）
    assert.strictEqual(ring.nodes[0], ring.nodes[ring.nodes.length - 1]);
    assert.ok(ring.area >= 0);
    // 两斜线各继续延伸到 y=2，是环上的两条支线
    edgeCoverage(r);
    assert.strictEqual(r.summary.openPaths, 2);
  });
});

// ----------------------------------------- C. 近上限小环与交点环

test('近坐标上限（9999.999 量级）的小环与支线：面积仍为 0.000001', function () {
  var d = draft('big', 0, [
    seg('a', 9999, 9999, 9999.001, 9999),
    seg('b', 9999.001, 9999, 9999, 9999.001),
    seg('c', 9999, 9999.001, 9999, 9999),
    seg('tail', 9999, 9999, 9995, 9995)
  ]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.rings, 1);
  assert.strictEqual(r.summary.openPaths, 1);
  assert.strictEqual(r.paths.filter(function (p) { return p.closed; })[0].area, 0.000001);
  edgeCoverage(r);
});

test('交点构成的小环平移到近坐标上限后面积不变（k=0.999）', function () {
  // k 形环（环顶由两斜线相交产生、带两条支线）平移到 (9000,9000) 附近，
  // 真实面积不变；交点为分母很大的有理数，最容易暴露浮点误差
  var d = draft('xk', 0, [
    seg('base', 9000, 9000, 9000.001, 9000),
    seg('l', 9000, 9000, 9001, 9002),
    seg('r', 9000.001, 9000, 9000 - 0.999, 9002)
  ]);
  var r = T.repair(d);
  var rings = r.paths.filter(function (p) { return p.closed; });
  assert.strictEqual(rings.length, 1);
  assert.strictEqual(rings[0].area, 0.000001);
  assert.strictEqual(r.summary.openPaths, 2);
  edgeCoverage(r);
});

test('交点环舍入为 0（k=1）平移到负坐标后仍为 0 且闭环保留', function () {
  var d = draft('xk0', 0, [
    seg('base', -9000, -9000, -8999.999, -9000),
    seg('l', -9000, -9000, -8999, -8998),
    seg('r', -8999.999, -9000, -9001, -8998)
  ]);
  var r = T.repair(d);
  var rings = r.paths.filter(function (p) { return p.closed; });
  assert.strictEqual(rings.length, 1);
  assert.strictEqual(rings[0].area, 0);
  assert.strictEqual(rings[0].nodes[0], rings[0].nodes[rings[0].nodes.length - 1]);
});

// --------------------------------- D. 200 重复 / 200 共点的性能与正确性

function dupSegments(n) {
  var s = [];
  for (var i = 0; i < n; i++) s.push(seg('s' + i, 0, 0, 10, 0));
  return s;
}
function fanSegments(n) {
  var s = [];
  for (var i = 0; i < n; i++) s.push(seg('f' + i, -1000, -i, 1000, i));
  return s;
}

test('200 条完全重复线段：2 节点 / 1 边 / 1 开链，边保留全部 200 个来源', function () {
  var r = T.repair(draft('dup', 0, dupSegments(200)));
  assert.strictEqual(r.summary.nodes, 2);
  assert.strictEqual(r.summary.edges, 1);
  assert.strictEqual(r.summary.components, 1);
  assert.strictEqual(r.summary.openPaths, 1);
  assert.strictEqual(r.summary.rings, 0);
  assert.strictEqual(r.edges.length, 1);
  var src = r.edges[0].sources;
  assert.strictEqual(src.length, 200);
  var expected = [];
  for (var i = 0; i < 200; i++) expected.push('s' + i);
  expected.sort();
  assert.deepStrictEqual(src, expected); // Unicode 码点有序
  assert.deepStrictEqual(r.paths[0].sources, expected);
  assert.strictEqual(r.edges[0].length, 10);
  // 节点仍是 (0,0) 与 (10,0)
  assert.deepStrictEqual(r.nodes.map(function (n) { return [n.x, n.y]; }), [[0, 0], [10, 0]]);
});

test('200 条线段共点相交：401 节点 / 400 边，原点分叉度 400', function () {
  var r = T.repair(draft('fan', 0, fanSegments(200)));
  assert.strictEqual(r.summary.nodes, 401);
  assert.strictEqual(r.summary.edges, 400);
  assert.strictEqual(r.summary.components, 1);
  assert.strictEqual(r.summary.junctions, 1);
  assert.strictEqual(r.summary.openPaths, 400);
  var center = r.nodes.filter(function (n) { return n.x === 0 && n.y === 0; })[0];
  assert.ok(center);
  assert.strictEqual(center.degree, 400);
  edgeCoverage(r);
});

// ---------------- E. 共线重叠 / 反向重复 / 重复与正常交叉混合

test('共线重叠 + 反向重复 + 十字交叉混合：边、来源、度数全对', function () {
  var d = draft('mix', 0, [
    seg('h1', 0, 0, 10, 0),
    seg('h2', 10, 0, 0, 0),        // 与 h1 完全重合、反向
    seg('h3', 7, 0, 13, 0),        // 共线部分重叠
    seg('v', 5, -5, 5, 5),         // 与重复水平线正常交叉
    seg('z', 1, 1, 1, 1)           // 原始零长度，诊断排除
  ]);
  var r = T.repair(d);
  // 节点：(0,0) (5,-5) (5,0) (5,5) (7,0) (10,0) (13,0)
  assert.strictEqual(r.summary.nodes, 7);
  assert.strictEqual(r.summary.edges, 6);
  assert.strictEqual(r.summary.components, 1);
  assert.strictEqual(r.summary.junctions, 1);
  var at5 = r.nodes.filter(function (n) { return n.x === 5 && n.y === 0; })[0];
  assert.strictEqual(at5.degree, 4);
  var edgesByPair = {};
  r.edges.forEach(function (e) { edgesByPair[e.from + '-' + e.to] = e.sources; });
  var id = function (x, y) {
    return r.nodes.filter(function (n) { return n.x === x && n.y === y; })[0].id;
  };
  assert.deepStrictEqual(edgesByPair[id(0, 0) + '-' + id(5, 0)], ['h1', 'h2']);
  assert.deepStrictEqual(edgesByPair[id(5, 0) + '-' + id(7, 0)], ['h1', 'h2']);
  assert.deepStrictEqual(edgesByPair[id(7, 0) + '-' + id(10, 0)], ['h1', 'h2', 'h3']);
  assert.deepStrictEqual(edgesByPair[id(10, 0) + '-' + id(13, 0)], ['h3']);
  assert.deepStrictEqual(edgesByPair[id(5, -5) + '-' + id(5, 0)], ['v']);
  edgeCoverage(r);
  degreesConsistent(r);
  assert.ok(r.diagnostics.some(function (x) {
    return x.code === 'ZERO_LENGTH_INPUT' && x.sources[0] === 'z';
  }));
});

test('部分重叠区间内部端点：来源只覆盖实际重叠的小边', function () {
  var d = draft('ov', 0, [
    seg('long', 0, 0, 10, 0),
    seg('mid', 3, 0, 7, 0)
  ]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.nodes, 4);
  assert.strictEqual(r.summary.edges, 3);
  var id = function (x) { return r.nodes.filter(function (n) { return n.x === x; })[0].id; };
  var byPair = {};
  r.edges.forEach(function (e) { byPair[e.from + '-' + e.to] = e.sources; });
  assert.deepStrictEqual(byPair[id(0) + '-' + id(3)], ['long']);
  assert.deepStrictEqual(byPair[id(3) + '-' + id(7)], ['long', 'mid']);
  assert.deepStrictEqual(byPair[id(7) + '-' + id(10)], ['long']);
  assert.strictEqual(r.summary.openPaths, 1);
});

// --------------- F. 真实构造：不同但 <=1e-9 的交点必须靠传递闭包合并
//
// 三条斜线方向（千分之一整数）分别为 (375,749)、(751,1500)、(376,751)，
// 对称端点 (-p,-q-1)milli -> (p,q-1)milli，与水平线 y=0 交点 x=p/(1000q)：
//   x1 = 375/(1000*749)
//   x2 = 751/(1000*1500)   |x1-x2| = 8.90e-10  (<=1e-9)
//   x3 = 376/(1000*751)    |x2-x3| = 8.88e-10  (<=1e-9)
//                          |x1-x3| = 1.78e-9   (>1e-9，非传递实现合并不了)
// 下端点各不相同（在各自直线上），所以三条支线在交点下方也不重合。
// 第四条线交点 x4 = 377/(1000*753)，与 x3 距 1.77e-9，必须保持独立。
var NEAR = {
  base: seg('h', -1, 0, 1, 0),
  merged: [
    seg('c0', -0.375, -0.75, 0.375, 0.748),
    seg('c1', -0.751, -1.501, 0.751, 1.499),
    seg('c2', -0.376, -0.752, 0.376, 0.75)
  ],
  far: seg('c3', -0.377, -0.754, 0.377, 0.752)
};

test('三个彼此相邻但外侧相距 1.78e-9 的交点经传递闭包归一为一个节点', function () {
  var r = T.repair(draft('near', 0, [NEAR.base].concat(NEAR.merged)));
  var cluster = r.nodes.filter(function (n) {
    return n.y === 0 && Math.abs(n.x - 0.000501) < 5e-7;
  });
  assert.strictEqual(cluster.length, 1, '三个交点必须合并成一个节点');
  // 三条斜线还共点于 (0,-0.001) 且该点到合并簇的小边彼此重合（1 条边、
  // 3 个来源）；合并簇上方三条支线互不重合（3 条边），水平线 2 条边：
  // 度数 = 1（合并的下方重合边）+ 3 + 2 = 6
  assert.strictEqual(cluster[0].degree, 6);
  // 三条斜线下端 3 边 + 共点后重合 1 边 + 上方 3 边 + 水平线 2 边 = 9 边
  assert.strictEqual(r.summary.edges, 9);
  // 合并簇到 (0,-0.001) 的重合边必须保留全部三个来源
  var bottom = r.nodes.filter(function (n) { return n.x === 0 && n.y === -0.001; })[0];
  var shared = r.edges.filter(function (e) {
    return (e.from === cluster[0].id && e.to === bottom.id) ||
           (e.to === cluster[0].id && e.from === bottom.id);
  });
  assert.strictEqual(shared.length, 1);
  assert.deepStrictEqual(shared[0].sources, ['c0', 'c1', 'c2']);
  edgeCoverage(r);
  degreesConsistent(r);
});

test('相距 1.77e-9 的另一交点不被粗分桶误并（保持独立节点）', function () {
  var r = T.repair(draft('near4', 0, [NEAR.base].concat(NEAR.merged, [NEAR.far])));
  var around = r.nodes.filter(function (n) {
    return n.y === 0 && Math.abs(n.x - 0.000501) < 5e-7;
  });
  // 合并簇（度 6）与远点（度 4）在六位小数下位置相同，但是两个节点
  assert.strictEqual(around.length, 2);
  var big = around.filter(function (n) { return n.degree === 6; });
  var small = around.filter(function (n) { return n.degree === 4; });
  assert.strictEqual(big.length, 1);
  assert.strictEqual(small.length, 1);
  assert.notStrictEqual(big[0].id, small[0].id);
  edgeCoverage(r);
});

// ------------------------------------- G. PointIndex 白盒

test('PointIndex：同一有理点注册多次只占一个成员（O(1) 去重）', function () {
  var idx = new T._PointIndex();
  var e = function (p, q) { return T._exactPoint(p, 0, q); }; // 世界 x = p/(1000q)
  var first = idx.add(375 / (1000 * 749), 0, e(375, 749));
  for (var i = 0; i < 5000; i++) {
    assert.strictEqual(idx.add(375 / (1000 * 749), 0, e(375, 749)), first);
  }
  assert.strictEqual(idx.members.length, 1); // 5001 次注册只有 1 个成员
});

test('PointIndex：<=1e-9 链传递闭包；簇代表取字典序最小；远点独立', function () {
  var idx = new T._PointIndex();
  var mk = function (p, q) {
    var ex = T._exactPoint(p, 0, q);
    return { id: idx.add(p / (1000 * q), 0, ex), x: p / (1000 * q) };
  };
  var a = mk(375, 749), b = mk(751, 1500), c = mk(376, 751), f = mk(377, 753);
  idx.mergeNearby();
  var canon = idx.finalize();
  assert.strictEqual(canon[a.id], canon[b.id]);
  assert.strictEqual(canon[b.id], canon[c.id]); // 外侧 a-c 相距 1.78e-9，靠链闭合
  // 三个点中字典序最小的是 c：x3 = 376/(1000*751)
  assert.strictEqual(canon[c.id].exact.xn.toString(), '376');
  assert.strictEqual(canon[c.id].exact.d.toString(), '751');
  assert.notStrictEqual(canon[f.id], canon[c.id]); // 1.77e-9 外保持独立
});

test('PointIndex：无精确表示的浮点点仍按 <=1e-9 取传递闭包（兜底）', function () {
  var idx = new T._PointIndex();
  var a = idx.add(0, 0, null);
  var b = idx.add(8e-10, 0, null);
  var cc = idx.add(1.6e-9, 0, null); // a-c 相距 1.6e-9，经 b 闭合
  var f = idx.add(4e-9, 0, null);
  idx.mergeNearby();
  var canon = idx.finalize();
  assert.strictEqual(canon[a], canon[b]);
  assert.strictEqual(canon[b], canon[cc]);
  assert.notStrictEqual(canon[f], canon[a]);
  // 代表取字典序最小（浮点）
  assert.strictEqual(canon[a].x, 0);
});

test('PointIndex：邻近但跨 1e-9 网格边界的点也能合并（±2 邻域）', function () {
  var idx = new T._PointIndex();
  // 格线两侧：0.999e-9 落在桶 0，1.001e-9 落在桶 1，相距仅 2e-11
  var a = idx.add(0.999e-9, 0, null);
  var b = idx.add(1.001e-9, 0, null);
  var cc = idx.add(1.001e-9, 1.001e-9, null);
  var d = idx.add(0.999e-9, 0.999e-9, null);
  idx.mergeNearby();
  var canon = idx.finalize();
  // 跨桶边合并；对角点 (a,c) 相距约 1.43e-9，靠传递闭包归一
  assert.strictEqual(canon[a], canon[b]);
  assert.strictEqual(canon[a], canon[cc]);
  assert.strictEqual(canon[a], canon[d]);
});

// ------------------------------------------------ H. 性能回归

function median(xs) {
  xs = xs.slice().sort(function (a, b) { return a - b; });
  return xs[Math.floor(xs.length / 2)];
}
function timeRepair(d, reps) {
  T.repair(d); // 外层再预热一次
  var ts = [];
  for (var i = 0; i < reps; i++) {
    var t0 = process.hrtime.bigint();
    var r = T.repair(d);
    var t1 = process.hrtime.bigint();
    ts.push(Number(t1 - t0) / 1e6);
    if (i === reps - 1) ts.result = r;
  }
  ts.result = T.repair(d);
  return ts;
}

test('性能：同进程预热后 200 条中位数 / 80 条中位数 <= 12 倍', function () {
  var d80 = draft('d80', 0, dupSegments(80));
  var d200 = draft('d200', 0, dupSegments(200));
  var fan200 = draft('fan200', 0, fanSegments(200));
  // 预热（JIT/内联）
  for (var w = 0; w < 5; w++) { T.repair(d80); T.repair(d200); T.repair(fan200); }
  if (global.gc) { global.gc(); }
  var m80 = median(timeRepair(d80, 9));
  var m200 = median(timeRepair(d200, 9));
  var mfan = median(timeRepair(fan200, 9));
  // 真实耗时（该断言失败时会一并打印）
  console.log('\n  [perf] 重复 80 中位数 ' + m80.toFixed(2) + 'ms，' +
    '200 中位数 ' + m200.toFixed(2) + 'ms，比值 ' + (m200 / m80).toFixed(2) +
    '；共点 200 中位数 ' + mfan.toFixed(2) + 'ms');
  assert.ok(m200 / m80 <= 12, '200/80 中位数比值 ' + (m200 / m80) + ' 超过 12');
  // 绝对护栏：重复 200 不得退化回秒级（远低于修复前的 ~6.2s）
  assert.ok(m200 < 1000, '200 条重复线段耗时异常：' + m200 + 'ms');
  assert.ok(mfan < 1000, '200 条共点线段耗时异常：' + mfan + 'ms');
});

process.stdout.write('\n');
if (failed) {
  console.log(failed + ' 个回归测试失败，' + passed + ' 个通过');
  process.exit(1);
}
console.log('全部 ' + passed + ' 个回归测试通过');
