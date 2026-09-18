#!/usr/bin/env node
/*
 * run_tests.js — 线稿拓扑工作台自测（Node 标准库，无第三方依赖）
 *
 * 运行：node tests/run_tests.js
 *
 * 覆盖：交叉切分、共线重叠去重及来源、传递吸附（不取平均）、
 * 分叉处截断、闭环方向与面积、路径边覆盖不变量、稳定排序、
 * 零长度排除与不充当吸附桥、近闭合阈值边界、校验规则、
 * 编辑后旧结果失效、导入失败不污染草稿、撤销/重做深度、
 * 修复不消耗撤销、草稿导出往返。
 */
'use strict';

var assert = require('assert');
var T = require('../static/topology.js');
var WB = require('../static/workbench.js');
var cases = require('../fixtures/cases.json').cases;

var passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('.'); }
  catch (e) {
    failed++;
    process.stdout.write('\n✗ ' + name + '\n  ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n  ') : e) + '\n');
  }
}
function caseDraft(key, overrides) {
  var d = JSON.parse(JSON.stringify(cases.filter(function (c) { return c.key === key; })[0].draft));
  if (overrides) Object.keys(overrides).forEach(function (k) { d[k] = overrides[k]; });
  return d;
}
function seg(id, ax, ay, bx, by, enabled) {
  return { id: id, enabled: enabled !== false, a: { x: ax, y: ay }, b: { x: bx, y: by } };
}
function draft(name, snap, segments) {
  return { version: 1, name: name, snapDistance: snap, segments: segments };
}

// ---------------------------------------------------------- 1. 交叉切分

test('十字交叉：5 节点、4 边、4 条开链', function () {
  var r = T.repair(caseDraft('cross'));
  assert.strictEqual(r.summary.nodes, 5);
  assert.strictEqual(r.summary.edges, 4);
  assert.strictEqual(r.summary.components, 1);
  assert.strictEqual(r.summary.openPaths, 4);
  assert.strictEqual(r.summary.rings, 0);
  assert.strictEqual(r.summary.junctions, 1);
  assert.strictEqual(r.summary.endpoints, 4);
  // 交点坐标 (0,0) 必须成为唯一中心节点，四条边都连到它
  var center = r.nodes.filter(function (n) { return n.x === 0 && n.y === 0; })[0];
  assert.ok(center, '中心交点缺失');
  r.edges.forEach(function (e) {
    assert.ok(e.from === center.id || e.to === center.id, '每条边都应接触中心交点');
  });
  // 每条开链长度为 5（半段），来源单一
  r.paths.forEach(function (p) {
    assert.strictEqual(p.closed, false);
    assert.strictEqual(p.area, null);
    assert.strictEqual(p.length, 5);
    assert.strictEqual(p.nodes.length, 2);
  });
});

test('斜交切分：交点为非整数坐标，长度内部精度计算后六位输出', function () {
  // y=x 与 y=-x+2 交于 (1,1)；每半段 sqrt(2)
  var d = draft('x', 0, [seg('a', 0, 0, 2, 2), seg('b', 0, 2, 2, 0)]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.nodes, 5);
  assert.strictEqual(r.summary.edges, 4);
  r.edges.forEach(function (e) { assert.ok(Math.abs(e.length - Math.SQRT2) < 1e-6); });
  assert.strictEqual(r.edges[0].length, 1.414214); // 六位小数
});

// ---------------------------------------------------------- 2. 共线重叠

test('共线重叠：4 节点、3 边，中间边保留一份且两个来源', function () {
  var r = T.repair(caseDraft('overlap'));
  assert.strictEqual(r.summary.nodes, 4);
  assert.strictEqual(r.summary.edges, 3);
  assert.strictEqual(r.summary.openPaths, 1);
  assert.deepStrictEqual(r.nodes.map(function (n) { return [n.x, n.y]; }),
    [[0, 0], [5, 0], [10, 0], [15, 0]]);
  assert.deepStrictEqual(r.edges.map(function (e) { return [e.from, e.to, e.sources]; }), [
    [0, 1, ['long']],
    [1, 2, ['long', 'shifted']],
    [2, 3, ['shifted']]
  ]);
  // 整条作为单条开链，来源去重排序
  assert.strictEqual(r.paths.length, 1);
  assert.deepStrictEqual(r.paths[0].nodes, [0, 1, 2, 3]);
  assert.deepStrictEqual(r.paths[0].sources, ['long', 'shifted']);
});

test('完全重合的两条线段：只保留一条边，两个来源', function () {
  var d = draft('dup', 0, [seg('p', 0, 0, 4, 0), seg('q', 0, 0, 4, 0)]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.edges, 1);
  assert.strictEqual(r.summary.nodes, 2);
  assert.deepStrictEqual(r.edges[0].sources, ['p', 'q']);
});

// ---------------------------------------------------------- 3. 传递吸附

test('传递吸附：三点链状近距闭包到字典序最小端点，不取平均', function () {
  var r = T.repair(caseDraft('transitive'));
  // (0,0) 与 (0.3,0) 相距 0.3 > 0.2，本不相邻，但经 (0.15,0) 传递闭包应全合并
  var center = r.nodes.filter(function (n) { return n.x === 0 && n.y === 0; })[0];
  assert.ok(center, '必须归并到 (0,0)');
  assert.strictEqual(r.summary.nodes, 4);
  assert.strictEqual(r.summary.edges, 3);
  assert.strictEqual(center.degree, 3); // 三条支线汇聚
  // 不得出现平均坐标 0.15 / 0.1
  assert.ok(!r.nodes.some(function (n) { return Math.abs(n.x - 0.15) < 1e-6; }));
  assert.ok(!r.nodes.some(function (n) { return Math.abs(n.x - 0.1) < 1e-6; }));
  // collapse 段吸附后退化：被报告且不产生边
  var diag = r.diagnostics.filter(function (x) { return x.code === 'COLLAPSED_AFTER_SNAP'; })[0];
  assert.ok(diag && diag.sources.indexOf('collapse') >= 0);
  assert.ok(!r.edges.some(function (e) { return e.length === 0; }));
});

test('吸附边界：距离 == 阈值（含 1e-9 容差）吸附', function () {
  var d = draft('bound', 0.2, [seg('a', 0, 0, 0, 5), seg('b', 0.2, 0, 5, 0)]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.nodes, 3); // 两端合并
});

test('阈值 0：重合端点才合并，0.15 断口保持分开', function () {
  var d = draft('z', 0, [seg('a', 0, 0, 0, 5), seg('b', 0.15, 0, 5, 0)]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.components, 2);
  assert.strictEqual(r.summary.nodes, 4);
});

// ---------------------------------------------------------- 4. 分叉处截断

test('T 接：端点落在另一线段内部，基段在分叉处切成两条链', function () {
  var r = T.repair(caseDraft('tee'));
  // 禁用段不参与；零长度段被诊断排除
  assert.strictEqual(r.summary.nodes, 4);
  assert.strictEqual(r.summary.edges, 3);
  var j = r.nodes.filter(function (n) { return n.degree > 2; })[0];
  assert.ok(j && j.x === 5 && j.y === 0);
  assert.strictEqual(j.degree, 3);
  assert.deepStrictEqual(r.paths.map(function (p) { return p.nodes; }),
    [[0, 1], [1, 2], [1, 3]]);
  assert.ok(r.diagnostics.some(function (x) {
    return x.code === 'ZERO_LENGTH_INPUT' && x.sources[0] === 'point';
  }));
});

test('闭环带支线：环不被误算为开链，支线独立成链，每条边恰好属于一条路径', function () {
  var r = T.repair(caseDraft('lollipop'));
  assert.strictEqual(r.summary.nodes, 5);
  assert.strictEqual(r.summary.edges, 5);
  assert.strictEqual(r.summary.rings, 1);
  assert.strictEqual(r.summary.openPaths, 1);
  var ring = r.paths.filter(function (p) { return p.closed; })[0];
  var open = r.paths.filter(function (p) { return !p.closed; })[0];
  assert.strictEqual(ring.area, 100);
  assert.strictEqual(ring.length, 40);
  assert.strictEqual(open.length, 5);
  assert.deepStrictEqual(open.sources, ['tail']);
  // 环回到分叉节点本身
  assert.strictEqual(ring.nodes[0], ring.nodes[ring.nodes.length - 1]);
  // 边覆盖不变量：并集为全部边、无重复
  var seen = {};
  r.paths.forEach(function (p) { p.edges.forEach(function (e) {
    assert.ok(!seen[e], '边 ' + e + ' 属于多条路径'); seen[e] = 1;
  }); });
  assert.strictEqual(Object.keys(seen).length, r.summary.edges);
});

// ---------------------------------------------------------- 5. 闭环方向与面积

test('方形闭环：最小节点起步、逆时针、面积 100、末尾重复起点', function () {
  var r = T.repair(caseDraft('square'));
  assert.strictEqual(r.summary.rings, 1);
  var p = r.paths[0];
  assert.strictEqual(p.closed, true);
  assert.strictEqual(p.area, 100);
  // 节点排序：(0,0)=0 (0,10)=1 (10,0)=2 (10,10)=3；CCW 为 0→2→3→1→0
  assert.deepStrictEqual(p.nodes, [0, 2, 3, 1, 0]);
  // edges 与 nodes 行走一致，且每条 edge 自身 from<to
  p.edges.forEach(function (eid, i) {
    var e = r.edges[eid];
    assert.ok(e.from < e.to);
    var pair = [p.nodes[i], p.nodes[i + 1]].sort(function (a, b) { return a - b; });
    assert.deepStrictEqual([e.from, e.to], pair);
  });
});

test('输入按顺时针给边，归一后仍为逆时针且从最小节点起步', function () {
  // (0,0)->(0,10)->(10,10)->(10,0)->(0,0) 顺时针
  var cw = draft('cw', 0, [
    seg('l', 0, 0, 0, 10), seg('t', 0, 10, 10, 10),
    seg('r', 10, 10, 10, 0), seg('b', 10, 0, 0, 0)
  ]);
  var r = T.repair(cw);
  assert.deepStrictEqual(r.paths[0].nodes, [0, 2, 3, 1, 0]);
  assert.strictEqual(r.paths[0].area, 100);
});

test('直角三角形面积 6，开链不显示面积', function () {
  var tri = draft('tri', 0, [
    seg('h', 0, 0, 4, 0), seg('v', 4, 0, 0, 3), seg('d', 0, 3, 0, 0)
  ]);
  var r = T.repair(tri);
  assert.strictEqual(r.paths[0].closed, true);
  assert.strictEqual(r.paths[0].area, 6);
});

test('近闭合样例：阈值 0 为开链，阈值 0.2 成为闭环（面积 100）', function () {
  var open = T.repair(caseDraft('near-close', { snapDistance: 0 }));
  assert.strictEqual(open.summary.rings, 0);
  assert.strictEqual(open.summary.openPaths, 1);
  assert.strictEqual(open.paths[0].area, null);
  var closed = T.repair(caseDraft('near-close', { snapDistance: 0.2 }));
  assert.strictEqual(closed.summary.rings, 1);
  assert.strictEqual(closed.summary.openPaths, 0);
  assert.strictEqual(closed.paths[0].area, 100);
  assert.strictEqual(closed.paths[0].length, 40);
});

test('纯 2 度闭环分量也被提取为路径', function () {
  var r = T.repair(caseDraft('square'));
  r.nodes.forEach(function (n) { assert.strictEqual(n.degree, 2); });
  assert.strictEqual(r.paths.length, 1);
});

// ---------------------------------------------------------- 6. 零长度规则

test('原始零长度线段被诊断、不参与拓扑、不充当传递吸附桥', function () {
  var r = T.repair(caseDraft('zero-bridge'));
  // up 在 (0,0)，down 在 (0.3,0)，零长度点 (0.15,0) 不得桥接两者
  assert.strictEqual(r.summary.components, 2);
  assert.strictEqual(r.summary.edges, 2);
  var diag = r.diagnostics.filter(function (x) { return x.code === 'ZERO_LENGTH_INPUT'; })[0];
  assert.deepStrictEqual(diag.sources, ['point']);
});

test('允许空线稿：全 0 计数与空数组', function () {
  var r = T.repair(draft('空', 0, []));
  assert.strictEqual(r.summary.nodes, 0);
  assert.strictEqual(r.summary.edges, 0);
  assert.strictEqual(r.summary.components, 0);
  assert.deepStrictEqual(r.nodes, []);
  assert.deepStrictEqual(r.edges, []);
  assert.deepStrictEqual(r.paths, []);
  assert.deepStrictEqual(r.diagnostics, []);
});

test('全部禁用：不产生任何几何', function () {
  var d = draft('off', 0, [seg('x', 0, 0, 1, 1, false)]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.nodes, 0);
  assert.deepStrictEqual(r.diagnostics, []);
});

// ---------------------------------------------------------- 7. 稳定排序与输出

test('节点按 (x,y)、边按端点编号、路径按节点序列字典序排序；来源有序', function () {
  var d = draft('ord', 0, [
    seg('s2', 10, 10, 20, 20),
    seg('s1', 0, 0, 1, 1)
  ]);
  var r = T.repair(d);
  for (var i = 1; i < r.nodes.length; i++) {
    var a = r.nodes[i - 1], b = r.nodes[i];
    assert.ok(a.x < b.x || (a.x === b.x && a.y <= b.y));
  }
  for (var j = 1; j < r.edges.length; j++) {
    var e0 = r.edges[j - 1], e1 = r.edges[j];
    assert.ok(e0.from < e1.from || (e0.from === e1.from && e0.to <= e1.to));
    assert.ok(e0.from < e0.to);
  }
  r.edges.forEach(function (e, idx) { assert.strictEqual(e.id, idx); });
  r.paths.forEach(function (p, idx) { assert.strictEqual(p.id, idx); });
});

test('诊断按 code、sources 排序', function () {
  var d = draft('diag', 0.2, [
    seg('z1', 5, 5, 5, 5), seg('z0', 1, 1, 1, 1),
    seg('c1', 0, 0, 0.15, 0), seg('c2', 0.15, 0, 0.3, 0),
    seg('cc', 0, 0, 0.3, 0)
  ]);
  var r = T.repair(d);
  assert.ok(r.diagnostics.length >= 2);
  assert.strictEqual(r.diagnostics[0].code, 'COLLAPSED_AFTER_SNAP');
  assert.strictEqual(r.diagnostics[1].code, 'ZERO_LENGTH_INPUT');
  assert.deepStrictEqual(r.diagnostics[1].sources, ['z0', 'z1']);
});

// ---------------------------------------------------------- 8. 草稿校验

test('校验：布尔不能代数字、数字字符串、null、未知字段、重复 ID 全部拒绝', function () {
  var bad = draft('bad', 0, [
    { id: 'a', enabled: true, a: { x: true, y: 0 }, b: { x: 1, y: 1 } },
    { id: 'a', enabled: 1, a: { x: '1', y: null }, b: { x: 1, y: 1 } },
    { id: 'c', enabled: true, a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, z: 2 }
  ]);
  var v = T.validateDraft(bad);
  assert.strictEqual(v.ok, false);
  var paths = v.errors.map(function (e) { return e.path; });
  assert.ok(paths.indexOf('$.segments[0].a.x') >= 0);
  assert.ok(paths.indexOf('$.segments[1].enabled') >= 0);
  assert.ok(paths.indexOf('$.segments[1].a.x') >= 0);
  assert.ok(paths.indexOf('$.segments[1].a.y') >= 0);
  assert.ok(paths.indexOf('$.segments[1].id') >= 0); // 重复 id 报在第二条
  assert.ok(paths.indexOf('$.segments[2].z') >= 0);
});

test('校验：范围、小数位、数量、顶层字段限制', function () {
  assert.strictEqual(T.validateDraft(draft('n', 10.001, [])).ok, false);
  assert.strictEqual(T.validateDraft(draft('n', -0.001, [])).ok, false);
  assert.strictEqual(T.validateDraft(draft('n', 0.0001, [])).ok, false); // snap 四位小数
  var over = draft('n', 0, []);
  for (var i = 0; i < 201; i++) over.segments.push(seg('s' + i, 0, 0, 1, 1));
  assert.strictEqual(T.validateDraft(over).ok, false);
  assert.strictEqual(T.validateDraft(draft('n', 0, [seg('a', 10000.001, 0, 1, 1)])).ok, false);
  assert.strictEqual(T.validateDraft(draft('n', 0, [seg('a', 10000, 0, -10000, 1)])).ok, true);
  assert.strictEqual(T.validateDraft(draft('n', 0, [seg('a', 1.2345, 0, 1, 1)])).ok, false);
  var extra = draft('n', 0, []); extra.who = 1;
  assert.strictEqual(T.validateDraft(extra).ok, false);
  assert.strictEqual(T.validateDraft(null).ok, false);
  assert.strictEqual(T.validateDraft('x').ok, false);
});

test('校验不修改输入数据', function () {
  var d = draft('n', 0, [seg('a', 1.234500000, 0, 1, 1)]);
  var snapshot = JSON.stringify(d);
  T.validateDraft(d);
  assert.strictEqual(JSON.stringify(d), snapshot);
});

// ---------------------------------------------------------- 9. 工作台状态模型

test('编辑后旧结果失效并禁止导出；重新修复后恢复', function () {
  var wb = WB.create(caseDraft('cross'));
  assert.strictEqual(wb.repair().ok, true);
  assert.strictEqual(wb.stale, false);
  assert.ok(wb.exportTopology());
  wb.setEndpointCoord('horizontal', 'a', 'x', -6);
  assert.strictEqual(wb.stale, true);
  assert.strictEqual(wb.exportTopology(), null);
  assert.strictEqual(wb.repair().ok, true);
  assert.strictEqual(wb.stale, false);
  assert.ok(wb.exportTopology());
});

test('修复本身不消耗撤销记录', function () {
  var wb = WB.create(caseDraft('cross'));
  wb.setSnapDistance(0.1);
  var depth = wb.undoDepth;
  wb.repair();
  wb.repair();
  assert.strictEqual(wb.undoDepth, depth);
});

test('导入失败不污染草稿，也不入撤销栈', function () {
  var wb = WB.create(caseDraft('cross'));
  var before = JSON.stringify(wb.draft);
  var depth = wb.undoDepth;
  var bad = draft('bad', 0, [{ id: 'a', enabled: true, a: { x: false, y: 0 }, b: { x: 1, y: 1 } }]);
  var r = wb.replaceDraft(bad);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length > 0);
  assert.strictEqual(JSON.stringify(wb.draft), before);
  assert.strictEqual(wb.undoDepth, depth);
  // JSON 语法层面的失败（调用方 JSON.parse）也不会进入模型
  assert.throws(function () { JSON.parse('{not json'); });
});

test('成功导入（样例替换）是一次完整可撤销操作，并保留 ID/顺序/启用状态', function () {
  var wb = WB.create(caseDraft('cross'));
  var tee = caseDraft('tee');
  assert.strictEqual(wb.replaceDraft(tee).ok, true);
  assert.strictEqual(wb.draft.segments.length, tee.segments.length);
  assert.strictEqual(wb.stale, true);
  wb.undo();
  assert.strictEqual(wb.draft.name, '十字交叉');
  // 草稿导出再导入：ID、顺序、enabled 完整保留
  var exported = wb.exportDraft();
  var wb2 = WB.create(draft('tmp', 0, []));
  assert.strictEqual(wb2.replaceDraft(exported).ok, true);
  assert.deepStrictEqual(wb2.draft.segments.map(function (s) {
    return [s.id, s.enabled, s.a.x, s.a.y, s.b.x, s.b.y];
  }), exported.segments.map(function (s) {
    return [s.id, s.enabled, s.a.x, s.a.y, s.b.x, s.b.y];
  }));
});

test('撤销/重做：至少 30 次编辑可逐步撤销，重做可恢复', function () {
  var wb = WB.create(draft('h', 0, []));
  for (var i = 0; i < 40; i++) {
    wb.addSegment();
  }
  assert.strictEqual(wb.draft.segments.length, 40);
  for (var k = 0; k < 40; k++) wb.undo();
  assert.strictEqual(wb.draft.segments.length, 0);
  assert.strictEqual(wb.canUndo, false);
  wb.redo();
  assert.strictEqual(wb.draft.segments.length, 1);
  // 新编辑清空重做栈
  wb.addSegment();
  assert.strictEqual(wb.canRedo, false);
});

test('撤销栈超过上限时丢弃最旧记录', function () {
  var wb = WB.create(draft('h', 0, []));
  for (var i = 0; i < 60; i++) wb.addSegment();
  for (var k = 0; k < 50; k++) wb.undo();
  assert.strictEqual(wb.canUndo, false); // 只保留 50 次
  assert.strictEqual(wb.draft.segments.length, 10);
});

test('坐标修改、增删线段、启用切换、吸附距离、改名均为完整操作', function () {
  var wb = WB.create(caseDraft('cross'));
  var id = wb.addSegment();                 // 增
  wb.setEndpointCoord(id, 'b', 'y', 3);     // 改坐标
  wb.toggleEnabled(id, false);              // 禁用
  wb.deleteSegment(id);                     // 删
  wb.setSnapDistance(0.2);                  // 吸附距离
  wb.renameSegment('horizontal', 'h');      // 改名
  assert.strictEqual(wb.undoDepth, 6);
  wb.undo(); assert.strictEqual(!!wb.draft.segments.filter(function (s) { return s.id === 'h'; })[0], false);
  wb.undo(); assert.strictEqual(wb.draft.snapDistance, 0);
  wb.undo(); assert.strictEqual(wb.draft.segments.length, 3); // 删除被撤销，新增段回来
  wb.undo(); assert.strictEqual(wb.draft.segments[2].enabled, true);
  wb.undo(); assert.strictEqual(wb.draft.segments[2].b.y, 0);
  wb.undo(); assert.strictEqual(wb.draft.segments.length, 2); // 新增被撤销
});

test('非法单字段编辑被拒绝且不入栈', function () {
  var wb = WB.create(caseDraft('cross'));
  assert.strictEqual(wb.setEndpointCoord('horizontal', 'a', 'x', true).ok, false);
  assert.strictEqual(wb.setEndpointCoord('horizontal', 'a', 'x', 10001).ok, false);
  assert.strictEqual(wb.setEndpointCoord('horizontal', 'a', 'x', 0.0001).ok, false);
  assert.strictEqual(wb.renameSegment('horizontal', 'vertical').ok, false); // 重名
  assert.strictEqual(wb.undoDepth, 0);
});

// ---------------------------------------------------------- 10. 页面/导出同源不变量

test('全部样例的路径分解不变量：边行走一致、恰好覆盖、图度自洽', function () {
  cases.forEach(function (c) {
    [0, 0.2].forEach(function (snap) {
      var d = caseDraft(c.key, { snapDistance: snap });
      var r = T.repair(d);
      // 邻接度自洽
      var deg = new Array(r.summary.nodes).fill(0);
      r.edges.forEach(function (e) { deg[e.from]++; deg[e.to]++; });
      r.nodes.forEach(function (n) { assert.strictEqual(n.degree, deg[n.id], c.key + ' 度不一致'); });
      // 每条边恰好属于一条路径，且路径相邻节点与边一致
      var edgeOwner = {};
      r.paths.forEach(function (p) {
        for (var i = 0; i < p.edges.length; i++) {
          var eid = p.edges[i];
          assert.ok(!edgeOwner[eid], c.key + ' 边重复归属');
          edgeOwner[eid] = p.id;
          var e = r.edges[eid];
          var pair = [p.nodes[i], p.nodes[i + 1]].sort(function (a, b) { return a - b; });
          assert.deepStrictEqual(pair, [e.from, e.to], c.key + ' 路径行走与边不一致');
        }
        assert.strictEqual(p.nodes.length, p.edges.length + 1);
        assert.strictEqual(p.nodes[0] === p.nodes[p.nodes.length - 1], p.closed);
      });
      assert.strictEqual(Object.keys(edgeOwner).length, r.edges.length, c.key + ' 有边不属于任何路径');
    });
  });
});

test('共线端对端相接（端点落在另一线段端点）：无需吸附即连通', function () {
  var d = draft('meet', 0, [seg('l', 0, 0, 5, 0), seg('r', 5, 0, 10, 0)]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.nodes, 3);
  assert.strictEqual(r.summary.edges, 2);
  assert.strictEqual(r.summary.components, 1);
  assert.strictEqual(r.summary.openPaths, 1);
  assert.strictEqual(r.paths[0].nodes.length, 3);
});

test('新增交点不按吸附距离二次吸附：交点保持精确位置', function () {
  // 两线段交叉，交点距某独立端点很近（< snap=2）但并非同一点，不得合并
  var d = draft('x', 2, [
    seg('a', 0, 0, 10, 10),
    seg('b', 0, 10, 10, 0),       // 交点 (5,5)
    seg('near', 6.5, 5, 9, 5)     // 端点 6.5 距交点 1.5 < snap，但交点阶段阈值固定 1e-9
  ]);
  var r = T.repair(d);
  var atIntersection = r.nodes.filter(function (n) {
    return Math.abs(n.x - 5) < 1e-9 && Math.abs(n.y - 5) < 1e-9;
  });
  var atNear = r.nodes.filter(function (n) {
    return Math.abs(n.x - 6.5) < 1e-9 && Math.abs(n.y - 5) < 1e-9;
  });
  assert.strictEqual(atIntersection.length, 1);
  assert.strictEqual(atNear.length, 1);
  assert.notStrictEqual(atIntersection[0].id, atNear[0].id);
});

test('大坐标（±10000）共线重叠与 T 接：整数谓词精确分类', function () {
  var d = draft('big', 0, [
    seg('long', -10000, 9999.999, 10000, 9999.999),
    seg('tail', 0, 9999.999, 0, -10000)
  ]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.nodes, 4);
  assert.strictEqual(r.summary.edges, 3);
  var j = r.nodes.filter(function (n) { return n.degree === 3; })[0];
  assert.ok(j && j.x === 0 && j.y === 9999.999);
});

test('负坐标象限中的闭环仍归一为最小节点起步、逆时针', function () {
  // 正方形 (-10,-10)-(-5,-5)，顺时针输入
  var d = draft('neg', 0, [
    seg('l', -10, -10, -10, -5),
    seg('t', -10, -5, -5, -5),
    seg('r', -5, -5, -5, -10),
    seg('b', -5, -10, -10, -10)
  ]);
  var r = T.repair(d);
  var p = r.paths[0];
  assert.strictEqual(p.closed, true);
  assert.strictEqual(p.area, 25);
  // 节点按 (x,y)：(-10,-10)=0 (-10,-5)=1 (-5,-10)=2 (-5,-5)=3；CCW: 0→2→3→1→0
  assert.deepStrictEqual(p.nodes, [0, 2, 3, 1, 0]);
});

test('两个独立闭环：分别成环、面积各自计算、不做孔洞相减', function () {
  var d = draft('two', 0, [
    seg('a1', 0, 0, 10, 0), seg('a2', 10, 0, 10, 10),
    seg('a3', 10, 10, 0, 10), seg('a4', 0, 10, 0, 0),
    seg('b1', 20, 0, 24, 0), seg('b2', 24, 0, 24, 4),
    seg('b3', 24, 4, 20, 4), seg('b4', 20, 4, 20, 0)
  ]);
  var r = T.repair(d);
  assert.strictEqual(r.summary.rings, 2);
  assert.strictEqual(r.summary.components, 2);
  var areas = r.paths.map(function (p) { return p.area; }).sort(function (a, b) { return a - b; });
  assert.deepStrictEqual(areas, [16, 100]);
});

test('开链方向：从两端中编号较小的节点起步，无论原始段方向', function () {
  // 段方向从小编号端指向大编号端 / 反向，结果一致
  var d1 = draft('o1', 0, [seg('s', 0, 0, 3, 4)]);
  var d2 = draft('o2', 0, [seg('s', 3, 4, 0, 0)]);
  var p1 = T.repair(d1).paths[0], p2 = T.repair(d2).paths[0];
  assert.deepStrictEqual(p1.nodes, [0, 1]);
  assert.deepStrictEqual(p2.nodes, [0, 1]);
  assert.strictEqual(p1.length, 5);
});

test('导出对象即修复结果：节点/边/路径字段满足格式文档', function () {
  var wb = WB.create(caseDraft('lollipop'));
  wb.repair();
  var topo = wb.exportTopology();
  assert.strictEqual(topo.version, 1);
  topo.nodes.forEach(function (n) {
    assert.ok(Number.isInteger(n.id) && Number.isInteger(n.degree));
    assert.strictEqual(typeof n.x, 'number');
  });
  topo.edges.forEach(function (e) {
    assert.ok(e.from < e.to);
    assert.ok(Array.isArray(e.sources));
  });
  topo.paths.forEach(function (p) {
    assert.strictEqual(p.nodes[0] === p.nodes[p.nodes.length - 1], p.closed);
    if (!p.closed) assert.strictEqual(p.area, null);
    else assert.ok(p.area > 0);
  });
  // 开链从编号较小端开始
  topo.paths.filter(function (p) { return !p.closed; }).forEach(function (p) {
    assert.ok(p.nodes[0] < p.nodes[p.nodes.length - 1]);
  });
});

// ---------------------------------------------------------- 11. 随机模糊不变量

test('随机模糊：1000 个随机草稿全部无异常且图不变量成立', function () {
  var seed = 7;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  function r3() { return Math.round((rnd() * 40 - 20) * 1000) / 1000; }
  var snaps = [0, 0.2, 1, 10];
  for (var it = 0; it < 1000; it++) {
    var n = 1 + Math.floor(rnd() * 7);
    var segs = [];
    for (var i = 0; i < n; i++) {
      segs.push(seg('s' + i, r3(), r3(), r3(), r3(), rnd() > 0.15));
    }
    var dd = draft('fuzz', snaps[Math.floor(rnd() * 4)], segs);
    var r;
    assert.doesNotThrow(function () { r = T.repair(dd); });
    var deg = new Array(r.summary.nodes).fill(0);
    r.edges.forEach(function (e) {
      assert.ok(e.from < e.to);
      deg[e.from]++; deg[e.to]++;
      assert.ok(Math.abs(r.nodes[e.from].x) <= 10000);
    });
    r.nodes.forEach(function (nd) { assert.strictEqual(nd.degree, deg[nd.id]); });
    var owner = {};
    r.paths.forEach(function (p) {
      assert.strictEqual(p.nodes[0] === p.nodes[p.nodes.length - 1], p.closed);
      assert.strictEqual(p.nodes.length, p.edges.length + 1);
      p.edges.forEach(function (eid) {
        assert.ok(!owner[eid]); owner[eid] = 1;
        assert.ok(r.edges[eid].sources.length >= 1);
      });
      if (!p.closed) assert.strictEqual(p.area, null);
      else assert.ok(p.area > 0);
    });
    assert.strictEqual(Object.keys(owner).length, r.summary.edges);
  }
});



process.stdout.write('\n');
if (failed) {
  console.log(failed + ' 个测试失败，' + passed + ' 个通过');
  process.exit(1);
}
console.log('全部 ' + passed + ' 个测试通过');
