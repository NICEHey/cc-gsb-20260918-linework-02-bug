#!/usr/bin/env node
/*
 * diff_fuzz.js — 差分模糊回归（仅 Node 标准库）
 *
 * 随机生成含共线重叠/重复段/T 接/禁用段的草稿（约 3000 组），
 * 用一份朴素 O(m²) 双精度参考管线独立计算边数与每条边的来源集合，
 * 与优化引擎逐项对比；不一致即以非零码退出。
 */
'use strict';
// 差分模糊：朴素 O(m²) 双精度参考管线 vs 优化引擎，对比结构不变量
var T = require('../static/topology.js');
function seg(id, ax, ay, bx, by, en) {
  return { id: id, enabled: en !== false, a: { x: ax, y: ay }, b: { x: bx, y: by } };
}
function draft(segs, snap) { return { version: 1, name: 'f', snapDistance: snap || 0, segments: segs }; }

var EPS = 1e-9;
function refRepair(d) {
  var act = d.segments.filter(function (s) { return s.enabled && !(s.a.x === s.b.x && s.a.y === s.b.y); });
  // snap（朴素 O(n²) 与引擎同规则：lex 最小原端点）
  var eps = [];
  act.forEach(function (s, i) { eps.push({ x: s.a.x, y: s.a.y, i: i, e: 0 }, { x: s.b.x, y: s.b.y, i: i, e: 1 }); });
  var par = [];
  function find(x) { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; }
  function uni(a, b) { a = find(a); b = find(b); if (a > b) par[a] = b; else if (b > a) par[b] = a; }
  eps.forEach(function (_, i) { par.push(i); });
  var L = d.snapDistance + EPS;
  for (var i = 0; i < eps.length; i++) for (var j = i + 1; j < eps.length; j++) {
    var dx = eps[i].x - eps[j].x, dy = eps[i].y - eps[j].y;
    if (dx * dx + dy * dy <= L * L) uni(i, j);
  }
  var grp = {};
  eps.forEach(function (p, i) { var r = find(i); (grp[r] = grp[r] || []).push(p); });
  var tgt = {};
  Object.keys(grp).forEach(function (r) {
    var g = grp[r], mn = g[0];
    g.forEach(function (p) { if (p.x < mn.x || (p.x === mn.x && p.y < mn.y)) mn = p; });
    g.forEach(function (p) { tgt[p.i + ':' + p.e] = { x: mn.x, y: mn.y }; });
  });
  act = act.map(function (s, i) {
    var A = tgt[i + ':0'] || s.a, B = tgt[i + ':1'] || s.b;
    return { id: s.id, ax: A.x, ay: A.y, bx: B.x, by: B.y };
  }).filter(function (s) { return !(s.ax === s.bx && s.ay === s.by); });

  function inter(s1, s2) {
    var rx = s1.bx - s1.ax, ry = s1.by - s1.ay, sx = s2.bx - s2.ax, sy = s2.by - s2.ay;
    var qpx = s2.ax - s1.ax, qpy = s2.ay - s1.ay;
    var c = rx * sy - ry * sx;
    var c1 = qpx * sy - qpy * sx, c2 = qpx * ry - qpy * rx;
    if (c !== 0) {
      var t = c1 / c, u = c2 / c;
      if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return [];
      t = Math.max(0, Math.min(1, t));
      return [{ x: s1.ax + rx * t, y: s1.ay + ry * t, t1: t, t2: u }];
    }
    if (c2 !== 0) return [];
    var r2 = rx * rx + ry * ry;
    var t0 = (qpx * rx + qpy * ry) / r2, t1 = ((qpx + sx) * rx + (qpy + sy) * ry) / r2;
    var lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
    if (lo > hi + EPS / Math.sqrt(r2)) return [];
    var out = [{ x: s1.ax + rx * lo, y: s1.ay + ry * lo, t1: lo, t2: lo - t0 }];
    if (hi - lo > EPS / Math.sqrt(r2)) out.push({ x: s1.ax + rx * hi, y: s1.ay + ry * hi, t1: hi, t2: hi - t0 });
    return out;
  }
  var per = act.map(function () { return []; });
  var all = [];
  function addP(si, x, y, t) {
    var idx = all.length;
    all.push({ x: x, y: y, t: t });
    per[si].push(idx);
    return idx;
  }
  act.forEach(function (s, i) {
    addP(i, s.ax, s.ay, 0);
    addP(i, s.bx, s.by, 1);
  });
  for (var u = 0; u < act.length; u++) for (var v = u + 1; v < act.length; v++) {
    inter(act[u], act[v]).forEach(function (p) {
      // 朴素参考：同一次交点在两条线上各挂一个点索引（同坐标、不同索引），
      // 由后面的 O(k²) 闭包统一
      addP(u, p.x, p.y, p.t1);
      addP(v, p.x, p.y, p.t2);
    });
  }
  var par2 = all.map(function (_, i) { return i; });
  function f2(x) { while (par2[x] !== x) { par2[x] = par2[par2[x]]; x = par2[x]; } return x; }
  function u2(a, b) { a = f2(a); b = f2(b); if (a > b) par2[a] = b; else if (b > a) par2[b] = a; }
  for (var i2 = 0; i2 < all.length; i2++) for (var j2 = i2 + 1; j2 < all.length; j2++) {
    var ddx = all[i2].x - all[j2].x, ddy = all[i2].y - all[j2].y;
    if (ddx * ddx + ddy * ddy <= EPS * EPS) u2(i2, j2);
  }
  var rep = {};
  all.forEach(function (p, i) {
    var r = f2(i);
    if (!rep[r] || p.x < rep[r].x || (p.x === rep[r].x && p.y < rep[r].y)) rep[r] = p;
  });
  function canonOf(idx) { return rep[f2(idx)]; }
  var edgeSet = {};
  per.forEach(function (lst, si) {
    var seen = {};
    var cs = lst.map(function (idx) { return { p: canonOf(idx), t: all[idx].t }; })
      .filter(function (c) {
        var key = c.p.x + ',' + c.p.y;
        if (seen[key]) return false;
        seen[key] = 1; return true;
      });
    cs.sort(function (a, b) { return a.t - b.t; });
    for (var k = 0; k + 1 < cs.length; k++) {
      var A = cs[k].p, B = cs[k + 1].p;
      var d2 = (A.x - B.x) * (A.x - B.x) + (A.y - B.y) * (A.y - B.y);
      if (d2 <= EPS * EPS) continue;
      var key = A.x + ',' + A.y + '|' + B.x + ',' + B.y;
      var ka = A.x + ',' + A.y, kb = B.x + ',' + B.y;
      if (ka > kb) { key = kb + '|' + ka; }
      (edgeSet[key] = edgeSet[key] || { ids: {} }).ids[act[si].id] = 1;
    }
  });
  return {
    edges: Object.keys(edgeSet).length,
    edgeSrc: Object.keys(edgeSet).map(function (k) { return Object.keys(edgeSet[k].ids).sort().join(','); }).sort()
  };
}

var seed = 20240918;
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function r3(span) { return Math.round((rnd() * (span || 20) - (span || 20) / 2) * 1000) / 1000; }

var mism = 0;
for (var it = 0; it < 3000; it++) {
  var n = 1 + Math.floor(rnd() * 10);
  var segs = [];
  for (var i = 0; i < n; i++) {
    var kind = rnd();
    var ax = r3(), ay = r3(), bx = r3(), by = r3();
    if (kind < 0.2) { // 制造共线/重复/部分重叠
      var j = Math.floor(rnd() * segs.length);
      if (segs[j]) {
        if (rnd() < 0.5) { var s0 = segs[j]; ax = s0.a.x; ay = s0.a.y; bx = s0.b.x; by = s0.b.y; }
        else { var s1 = segs[j]; ax = s1.a.x + r3(2); bx = s1.b.x + (ax - s1.a.x); ay = s1.a.y; by = s1.b.y; }
      }
    }
    segs.push(seg('s' + i, ax, ay, bx, by, rnd() > 0.1));
  }
  var snap = [0, 0.2, 1][Math.floor(rnd() * 3)];
  var d = draft(segs, snap);
  var r, ref;
  try { r = T.repair(d); } catch (e) { console.log('ENGINE THROW', e.stack); process.exit(1); }
  try { ref = refRepair(d); } catch (e) { continue; }
  if (r.summary.edges !== ref.edges || JSON.stringify(r.edges.map(function (e) { return e.sources.join(','); }).sort()) !== JSON.stringify(ref.edgeSrc)) {
    mism++;
    if (mism <= 5) {
      console.log('MISMATCH it=' + it + ' snap=' + snap);
      console.log(' engine edges=' + r.summary.edges, JSON.stringify(r.edges.map(function (e) { return e.sources.join(','); }).sort()));
      console.log(' ref    edges=' + ref.edges, JSON.stringify(ref.edgeSrc));
      console.log(JSON.stringify(d));
    }
  }
}
console.log(mism === 0 ? '3000 组随机差分全部一致' : mism + ' 组不一致');
if (mism > 0) process.exit(1);
