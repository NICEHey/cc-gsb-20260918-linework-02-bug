'use strict';
// 复现脚本：性能两组输入 + 面积平移问题 + 三份舍入资料
var T = require('./static/topology.js');

function seg(id, ax, ay, bx, by, enabled) {
  return { id: id, enabled: enabled !== false, a: { x: ax, y: ay }, b: { x: bx, y: by } };
}
function draft(name, snap, segments) {
  return { version: 1, name: name, snapDistance: snap, segments: segments };
}

console.log('== 性能：N 条完全重复线段 (0,0)->(10,0) ==');
[40, 80, 120, 160, 200].forEach(function (n) {
  var segs = [];
  for (var i = 0; i < n; i++) segs.push(seg('s' + i, 0, 0, 10, 0));
  var d = draft('dup', 0, segs);
  var t0 = process.hrtime.bigint();
  var r = T.repair(d);
  var t1 = process.hrtime.bigint();
  var ms = Number(t1 - t0) / 1e6;
  console.log('n=' + n + '  ' + ms.toFixed(1) + 'ms  nodes=' + r.summary.nodes +
    ' edges=' + r.summary.edges + ' paths=' + r.paths.length +
    ' edgeSources=' + r.edges[0].sources.length);
});

console.log('\n== 性能：200 条线段全交于原点 (-1000,-i)->(1000,i) ==');
(function () {
  var segs = [];
  for (var i = 0; i < 200; i++) segs.push(seg('s' + i, -1000, -i, 1000, i));
  var d = draft('fan', 0, segs);
  var t0 = process.hrtime.bigint();
  var r = T.repair(d);
  var t1 = process.hrtime.bigint();
  console.log(Number(t1 - t0) / 1e6 + 'ms  nodes=' + r.summary.nodes +
    ' edges=' + r.summary.edges + ' paths=' + r.paths.length);
})();

console.log('\n== 面积：小三角形原点 vs 平移到 (1,1) ==');
(function () {
  var t1 = draft('tri0', 0, [
    seg('a', 0, 0, 0.001, 0), seg('b', 0.001, 0, 0, 0.001), seg('c', 0, 0.001, 0, 0)
  ]);
  var r1 = T.repair(t1);
  var t2 = draft('tri1', 0, [
    seg('a', 1, 1, 1.001, 1), seg('b', 1.001, 1, 1, 1.001), seg('c', 1, 1.001, 1, 1)
  ]);
  var r2 = T.repair(t2);
  console.log('原点三角形 area=' + r1.paths[0].area + ' (期望 0.000001)');
  console.log('平移三角形 area=' + r2.paths[0].area + ' (期望 0.000001)');
})();

console.log('\n== 三份舍入边界资料：k=1, 0.999, 0.998 ==');
[1, 0.999, 0.998].forEach(function (k) {
  var d = draft('k=' + k, 0, [
    seg('base', 0, 0, 0.001, 0),
    seg('l', 0, 0, 1, 2),
    seg('r', 0.001, 0, -k, 2)
  ]);
  var r = T.repair(d);
  var ring = r.paths.filter(function (p) { return p.closed; })[0];
  var expected = k === 1 ? 0 : 0.000001;
  console.log('k=' + k + ' rings=' + r.summary.rings + ' area=' + (ring ? ring.area : null) +
    ' closed=' + (ring ? ring.closed : null) + ' (期望 ' + expected + ')');
});
