#!/usr/bin/env node
/*
 * perf.js — 退化/密集输入性能回归（仅 Node 标准库）
 *
 * 运行：node tests/perf.js
 *
 * 同一进程预热后，对 80 条与 200 条完整输入各重复测量并取中位数：
 *   - dup：n 条完全重复线段 (0,0)->(10,0)（正确结果 2 节点/1 边，sources=n）
 *   - fan：n 条线段 (-1000,-i/1000)->(1000,i/1000) 全部交于原点
 * 要求 200/80 中位数之比不超过 12；同时打印拓扑摘要做正确性核对，
 * 不以“没有抛错”代替正确性。
 */
'use strict';
var T = require('../static/topology.js');

function seg(id, ax, ay, bx, by) {
  return { id: id, enabled: true, a: { x: ax, y: ay }, b: { x: bx, y: by } };
}
function draft(name, segs) { return { version: 1, name: name, snapDistance: 0, segments: segs }; }
function dup(n) {
  var s = [];
  for (var i = 0; i < n; i++) s.push(seg('s' + i, 0, 0, 10, 0));
  return draft('dup' + n, s);
}
function fan(n) {
  var s = [];
  for (var i = 0; i < n; i++) s.push(seg('s' + i, -1000, -i, 1000, i));
  return draft('fan' + n, s);
}
function medianMs(fn, reps) {
  fn(); // 预热
  var ts = [];
  for (var k = 0; k < reps; k++) {
    var t0 = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  ts.sort(function (a, b) { return a - b; });
  return ts[Math.floor(reps / 2)];
}

var failures = 0;
function row(label, make, n, expect) {
  var r = T.repair(make(n));
  var okNodes = r.summary.nodes === expect.nodes;
  var okEdges = r.summary.edges === expect.edges;
  var okPaths = r.summary.openPaths === expect.openPaths;
  var okSrc = !expect.sources || r.edges[0].sources.length === expect.sources;
  var ok = okNodes && okEdges && okPaths && okSrc;
  if (!ok) failures++;
  console.log('  ' + label + ' n=' + n + '  ' + medianMs(function () { return T.repair(make(n)); }, 9).toFixed(2) +
    'ms  摘要=' + JSON.stringify(r.summary) +
    (expect.sources ? '  首边sources=' + r.edges[0].sources.length : '') +
    (ok ? '' : '  *** 与预期不符 ***'));
  return medianMs(function () { return T.repair(make(n)); }, 9);
}

console.log('== 退化/密集输入性能（中位数，9 次重复，同进程预热）==');
console.log('[dup] 完全重复线段（正确拓扑：2 节点 / 1 边 / 1 开链，sources 全保留）');
var d80 = row('dup', dup, 80, { nodes: 2, edges: 1, openPaths: 1, sources: 80 });
var d200 = row('dup', dup, 200, { nodes: 2, edges: 1, openPaths: 1, sources: 200 });
console.log('[fan] 全部交于原点（正确拓扑：2n+1 节点 / 2n 边 / 2n 开链，1 个度 2n 分叉）');
var f80 = row('fan', fan, 80, { nodes: 161, edges: 160, openPaths: 160 });
var f200 = row('fan', fan, 200, { nodes: 401, edges: 400, openPaths: 400 });

var rd = d200 / d80, rf = f200 / f80;
console.log('\n== 200/80 中位数耗时比：dup=' + rd.toFixed(2) + '  fan=' + rf.toFixed(2) + '（要求均 <= 12）==');
if (rd > 12 || rf > 12) {
  failures++;
  console.log('性能回归失败');
  process.exit(1);
}
console.log(failures === 0 ? '性能与结构检查通过' : '存在失败');
