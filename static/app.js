/*
 * app.js — 线稿拓扑工作台视图层（原生 JS，无第三方依赖）
 * 状态、撤销、修复全部委托给 workbench.js 的 Workbench 模型。
 */
(function () {
  'use strict';

  var WB = window.Workbench;
  var STORAGE_KEY = 'lineart-workbench-draft-v1';

  // ------------------------------------------------------------- 全局状态

  var workbench = WB.create(loadSavedDraft());
  var selection = null; // {kind:'segment'|'node'|'edge'|'path', id, extra?:[ids...]}
  var casesCatalog = [];

  // 视图：屏幕坐标 = (originX + wx*scale, originY - wy*scale)，y 向上
  var view = { scale: 30, originX: 0, originY: 0 };
  var showOriginal = true;
  var showRepaired = true;

  var canvas = document.getElementById('canvas');
  var ctx = canvas.getContext('2d');
  var canvasW = 0, canvasH = 0;
  var drag = null;

  // ------------------------------------------------------------- 工具

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function segById(id) {
    var segs = workbench.draft.segments;
    for (var i = 0; i < segs.length; i++) if (segs[i].id === id) return segs[i];
    return null;
  }

  function atMost3(v) { return Math.abs(v - Math.round(v * 1000) / 1000) <= 1e-9; }

  function fmt(n) { return (Math.round(n * 1e6) / 1e6).toFixed(6); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ------------------------------------------------------------- 持久化

  function loadSavedDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      // 刷新只恢复草稿；损坏的存档不恢复
      if (!window.Topology.validateDraft(obj).ok) return null;
      return obj;
    } catch (e) { return null; }
  }
  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(workbench.draft)); } catch (e) { /* 忽略 */ }
    }, 250);
  }

  // 模型变化 -> 全量重绘（表格内联编辑时焦点保持见 renderTable）
  workbench.onChange(function () {
    scheduleSave();
    // 草稿一变，旧结果几何已失效：清掉指向旧节点/边/路径的选择
    if (selection && selection.kind !== 'segment') selection = null;
    renderAll();
  });

  // ------------------------------------------------------------- 修复

  function runRepair() {
    var r = workbench.repair();
    if (!r.ok) {
      showErrors(r.errors, '草稿无法通过校验，请先修正以下字段：');
      return;
    }
    hideErrors();
    if (selection && (selection.kind === 'node' || selection.kind === 'edge' || selection.kind === 'path')) {
      selection = null;
    }
    renderAll();
  }

  // ------------------------------------------------------------- 线段表

  var tbody = document.querySelector('#segTable tbody');

  function renderTable() {
    var draft = workbench.draft;
    setInputValuePreserveFocus('draftName', draft.name);
    setInputValuePreserveFocus('snapDistance', draft.snapDistance);
    document.getElementById('segCount').textContent = '(' + draft.segments.length + '/200)';

    // 行数或 id 序列变化时整表重建（保证行内处理器持有的 id 有效），
    // 其余编辑只逐行同步，避免输入过程中丢焦点
    var rows = tbody.querySelectorAll('tr');
    var currentIds = [];
    for (var ri = 0; ri < rows.length; ri++) currentIds.push(rows[ri].dataset.id);
    var expectedIds = draft.segments.map(function (s) { return s.id; });
    if (currentIds.length !== expectedIds.length ||
        currentIds.some(function (id, i) { return id !== expectedIds[i]; })) {
      tbody.innerHTML = '';
      draft.segments.forEach(function (s) { tbody.appendChild(buildRow(s.id)); });
      rows = tbody.querySelectorAll('tr');
    }
    draft.segments.forEach(function (s, idx) {
      syncRow(rows[idx], s);
    });
  }

  // 正在编辑的输入不被重渲染覆盖
  function setInputValuePreserveFocus(id, value) {
    var el = document.getElementById(id);
    if (document.activeElement === el) return;
    if (el.value !== String(value)) el.value = value;
  }

  function buildRow(segId) {
    var tr = document.createElement('tr');
    tr.dataset.id = segId;

    var tdEn = document.createElement('td');
    tdEn.className = 'c-enable';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.addEventListener('click', function (e) { e.stopPropagation(); });
    cb.addEventListener('change', function () { workbench.toggleEnabled(segId, cb.checked); });
    tdEn.appendChild(cb);
    tr.appendChild(tdEn);

    tr.appendChild(makeCell('text', 'id', { cls: 'id-cell' }));
    tr.appendChild(makeCell('number', 'ax'));
    tr.appendChild(makeCell('number', 'ay'));
    tr.appendChild(makeCell('number', 'bx'));
    tr.appendChild(makeCell('number', 'by'));

    var tdDel = document.createElement('td');
    tdDel.className = 'c-del';
    var btnDel = document.createElement('button');
    btnDel.className = 'del';
    btnDel.type = 'button';
    btnDel.textContent = '✕';
    btnDel.title = '删除线段';
    btnDel.addEventListener('click', function (e) { e.stopPropagation(); workbench.deleteSegment(segId); });
    tdDel.appendChild(btnDel);
    tr.appendChild(tdDel);

    tr.addEventListener('click', function () {
      selection = { kind: 'segment', id: segId };
      renderSelection();
    });
    return tr;
  }

  function makeCell(inputType, field, opts) {
    var td = document.createElement('td');
    var input = document.createElement('input');
    input.type = inputType;
    input.spellcheck = false;
    input.dataset.field = field;
    if (opts && opts.cls) input.className = opts.cls;
    if (inputType === 'number') { input.step = '0.001'; input.min = '-10000'; input.max = '10000'; }

    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('focus', function () {
      var id = input.closest('tr').dataset.id;
      if (!selection || selection.kind !== 'segment' || selection.id !== id) {
        selection = { kind: 'segment', id: id };
        renderSelection();
      }
    });
    input.addEventListener('change', function () {
      var id = input.closest('tr').dataset.id;
      input.classList.remove('invalid');
      if (field === 'id') {
        var r = workbench.renameSegment(id, input.value);
        if (!r.ok) { input.classList.add('invalid'); input.title = r.error; return; }
        input.title = '';
        selection = { kind: 'segment', id: input.value };
        return;
      }
      var num = Number(input.value);
      if (input.value.trim() === '' || typeof num !== 'number' || !isFinite(num) ||
          Math.abs(num) > 10000 || !atMost3(num)) {
        input.classList.add('invalid');
        input.title = '要求有限数字、|值| ≤ 10000、最多三位小数';
        return;
      }
      var end = field[0], axis = field[1];
      var rr = workbench.setEndpointCoord(id, end, axis, num);
      if (!rr.ok) { input.classList.add('invalid'); input.title = rr.error; }
    });
    td.appendChild(input);
    return td;
  }

  function syncRow(tr, s) {
    tr.classList.toggle('disabled-row', !s.enabled);
    tr.classList.toggle('selected', !!(selection && selection.kind === 'segment' &&
      (selection.id === s.id || (selection.extra && selection.extra.indexOf(s.id) >= 0))));
    var cb = tr.querySelector('input[type=checkbox]');
    if (document.activeElement !== cb) cb.checked = s.enabled;
    var inputs = tr.querySelectorAll('input[type=text],input[type=number]');
    var vals = { id: s.id, ax: s.a.x, ay: s.a.y, bx: s.b.x, by: s.b.y };
    for (var i = 0; i < inputs.length; i++) {
      var inp = inputs[i];
      if (document.activeElement === inp) continue;
      var v = vals[inp.dataset.field];
      if (inp.value !== String(v)) inp.value = v;
    }
  }

  function highlightTableRow(id) {
    var trs = tbody.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      if (trs[i].dataset.id === id) { trs[i].scrollIntoView({ block: 'nearest' }); return; }
    }
  }

  // ------------------------------------------------------------- 检查 / 路径面板

  function renderStatusBar() {
    var pill = document.getElementById('statusPill');
    var btnTopo = document.getElementById('btnExportTopo');
    if (workbench.result && !workbench.stale) {
      pill.textContent = '修复结果有效';
      pill.className = 'pill fresh';
      btnTopo.disabled = false;
    } else {
      pill.textContent = workbench.result ? '修复结果已过期' : '未修复';
      pill.className = 'pill stale';
      btnTopo.disabled = true;
    }
    document.getElementById('btnUndo').disabled = !workbench.canUndo;
    document.getElementById('btnRedo').disabled = !workbench.canRedo;
  }

  function renderSummary() {
    var box = document.getElementById('summary');
    var result = workbench.result;
    if (!result) {
      box.innerHTML = '<div class="path-empty" style="grid-column:1/-1">尚未执行修复。</div>';
      return;
    }
    var s = result.summary;
    var items = [
      ['节点', s.nodes], ['边', s.edges], ['连通分量', s.components],
      ['度1 端点', s.endpoints], ['度&gt;2 分叉', s.junctions],
      ['开链', s.openPaths], ['闭环', s.rings]
    ];
    box.innerHTML = items.map(function (it) {
      return '<div class="stat"><div class="v">' + it[1] + '</div><div class="k">' + it[0] + '</div></div>';
    }).join('');
  }

  function renderIssues() {
    var ul = document.getElementById('issueList');
    var result = workbench.result;
    if (!result) {
      ul.innerHTML = '<li class="path-empty" style="border:none;background:none">执行修复后在此显示断口、分叉与诊断。</li>';
      return;
    }
    var html = '';
    result.diagnostics.forEach(function (d, di) {
      var cls = d.code === 'ZERO_LENGTH_INPUT' ? 'diag-zero' : 'diag-collapse';
      var label = d.code === 'ZERO_LENGTH_INPUT' ? '原始零长度线段' : '吸附后退化线段';
      html += '<li class="' + cls + '" data-diag="' + di + '"><span>' + label + '（' +
        d.sources.length + '）：' + escapeHtml(d.sources.join(', ')) +
        '</span><span class="loc">' + escapeHtml(d.message) + '</span></li>';
    });
    result.edges.forEach(function (e) {
      if (e.sources.length > 1) {
        var a = result.nodes[e.from], b = result.nodes[e.to];
        html += '<li class="diag-overlap" data-edge="' + e.id +
          '"><span>共线重叠边  #' + e.id + '（' + e.sources.length + ' 个来源）：' +
          escapeHtml(e.sources.join(', ')) + '</span><span class="loc">#' + e.from +
          ' → #' + e.to + '</span></li>';
      }
    });
    result.nodes.forEach(function (nd) {
      if (nd.degree === 1 || nd.degree > 2) {
        var title = nd.degree === 1 ? '度 1 端点  #' : '度 ' + nd.degree + ' 分叉点  #';
        html += '<li class="endpoint" data-node="' + nd.id + '"><span>' + title + nd.id +
          '</span><span class="loc">(' + fmt(nd.x) + ', ' + fmt(nd.y) + ')</span></li>';
      }
    });
    if (!html) html = '<li class="path-empty" style="border:none;background:none">未发现问题。</li>';
    ul.innerHTML = html;

    ul.querySelectorAll('li[data-diag]').forEach(function (li) {
      li.addEventListener('click', function () {
        var d = result.diagnostics[Number(li.dataset.diag)];
        selection = { kind: 'segment', id: d.sources[0], extra: d.sources.slice() };
        renderSelection();
        var s = segById(d.sources[0]);
        if (s) recenterWorld((s.a.x + s.b.x) / 2, (s.a.y + s.b.y) / 2);
      });
    });
    ul.querySelectorAll('li[data-edge]').forEach(function (li) {
      li.addEventListener('click', function () {
        var eid = Number(li.dataset.edge);
        var e = result.edges[eid];
        selection = { kind: 'edge', id: eid };
        renderSelection();
        var a = result.nodes[e.from], b = result.nodes[e.to];
        recenterWorld((a.x + b.x) / 2, (a.y + b.y) / 2);
      });
    });
    ul.querySelectorAll('li[data-node]').forEach(function (li) {
      li.addEventListener('click', function () {
        selectNode(Number(li.dataset.node), true);
      });
    });
  }

  function renderPaths() {
    var ul = document.getElementById('pathList');
    var result = workbench.result;
    if (!result) { ul.innerHTML = '<li class="path-empty">执行修复后显示提取的路径。</li>'; return; }
    if (!result.paths.length) { ul.innerHTML = '<li class="path-empty">空线稿：没有路径。</li>'; return; }

    ul.innerHTML = result.paths.map(function (p) {
      var sel = selection && selection.kind === 'path' && selection.id === p.id ? ' selected' : '';
      var kind = p.closed
        ? '<span class="path-kind ring">闭环</span>'
        : '<span class="path-kind open">开链</span>';
      return '<li data-path="' + p.id + '" class="' + sel.trim() + '"><div class="path-top">' + kind +
        '<span class="path-meta">长度 ' + fmt(p.length) +
        (p.closed ? '　面积 ' + fmt(p.area) : '') + '</span></div>' +
        '<div class="path-nodes">#' + p.nodes.join(' → #') + '</div>' +
        '<div class="path-meta">来源：<span class="path-sources">' +
        escapeHtml(p.sources.join(', ')) + '</span></div></li>';
    }).join('');

    ul.querySelectorAll('li[data-path]').forEach(function (li) {
      li.addEventListener('click', function () {
        selection = { kind: 'path', id: Number(li.dataset.path) };
        renderSelection();
      });
    });
  }

  function selectNode(id, recenter) {
    selection = { kind: 'node', id: id };
    renderSelection();
    if (recenter && workbench.result) {
      var nd = workbench.result.nodes[id];
      recenterWorld(nd.x, nd.y);
    }
  }

  // ------------------------------------------------------------- 选择联动

  function renderSelection() {
    var trs = tbody.querySelectorAll('tr');
    for (var i = 0; i < trs.length; i++) {
      var on = false;
      if (selection && selection.kind === 'segment') {
        on = trs[i].dataset.id === selection.id ||
          (selection.extra && selection.extra.indexOf(trs[i].dataset.id) >= 0);
      }
      trs[i].classList.toggle('selected', on);
    }
    if (selection && selection.kind === 'segment') highlightTableRow(selection.id);

    document.querySelectorAll('#pathList li').forEach(function (li) {
      var on = selection && selection.kind === 'path' && Number(li.dataset.path) === selection.id;
      li.classList.toggle('selected', !!on);
    });
    draw();
  }

  // ------------------------------------------------------------- 画布坐标

  function worldToScreen(wx, wy) {
    return { x: view.originX + wx * view.scale, y: view.originY - wy * view.scale };
  }
  function screenToWorld(sx, sy) {
    return { x: (sx - view.originX) / view.scale, y: (view.originY - sy) / view.scale };
  }

  function resizeCanvas() {
    var rect = canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvasW = rect.width;
    canvasH = rect.height;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function fitView() {
    var xs = [], ys = [];
    workbench.draft.segments.forEach(function (s) {
      if (!s.enabled) return;
      xs.push(s.a.x, s.b.x); ys.push(s.a.y, s.b.y);
    });
    if (!xs.length) {
      view.scale = 30;
      view.originX = canvasW / 2;
      view.originY = canvasH / 2;
      draw();
      return;
    }
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    if (minX === maxX) { minX -= 5; maxX += 5; }
    if (minY === maxY) { minY -= 5; maxY += 5; }
    var pad = 46;
    view.scale = Math.min((canvasW - pad * 2) / (maxX - minX), (canvasH - pad * 2) / (maxY - minY));
    view.originX = canvasW / 2 - (minX + maxX) / 2 * view.scale;
    view.originY = canvasH / 2 + (minY + maxY) / 2 * view.scale;
    draw();
  }

  function recenterWorld(wx, wy) {
    view.originX = canvasW / 2 - wx * view.scale;
    view.originY = canvasH / 2 + wy * view.scale;
    draw();
  }

  function zoomAt(sx, sy, factor) {
    var w = screenToWorld(sx, sy);
    view.scale *= factor;
    view.originX = sx - w.x * view.scale;
    view.originY = sy + w.y * view.scale;
    draw();
  }

  // ------------------------------------------------------------- 画布绘制

  function draw() {
    ctx.clearRect(0, 0, canvasW, canvasH);
    drawGrid();
    if (showOriginal) drawOriginal();
    // 修复结果即使已过期也可叠加查看（灰化），但不能导出
    if (showRepaired && workbench.result) drawRepaired(workbench.stale);
    drawStaleBadge();
  }

  function drawGrid() {
    var step = view.scale >= 12 ? 1 : view.scale >= 3 ? 5 : 50;
    var tl = screenToWorld(0, 0), br = screenToWorld(canvasW, canvasH);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#1b232c';
    ctx.beginPath();
    for (var gx = Math.ceil(tl.x / step) * step; gx <= br.x; gx += step) {
      var p = worldToScreen(gx, 0);
      ctx.moveTo(p.x, 0); ctx.lineTo(p.x, canvasH);
    }
    for (var gy = Math.ceil(br.y / step) * step; gy <= tl.y; gy += step) {
      var q = worldToScreen(0, gy);
      ctx.moveTo(0, q.y); ctx.lineTo(canvasW, q.y);
    }
    ctx.stroke();
    var o = worldToScreen(0, 0);
    ctx.strokeStyle = '#33414f';
    ctx.beginPath();
    ctx.moveTo(0, o.y); ctx.lineTo(canvasW, o.y);
    ctx.moveTo(o.x, 0); ctx.lineTo(o.x, canvasH);
    ctx.stroke();
  }

  function drawOriginal() {
    workbench.draft.segments.forEach(function (s) {
      var a = worldToScreen(s.a.x, s.a.y);
      var b = worldToScreen(s.b.x, s.b.y);
      var zero = s.a.x === s.b.x && s.a.y === s.b.y;
      var sel = selection && selection.kind === 'segment' &&
        (selection.id === s.id || (selection.extra && selection.extra.indexOf(s.id) >= 0));

      if (zero) {
        var r = sel ? 7 : 5;
        ctx.strokeStyle = s.enabled ? '#ef6a6a' : '#5a4646';
        ctx.lineWidth = sel ? 2.5 : 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x - r, a.y - r); ctx.lineTo(a.x + r, a.y + r);
        ctx.moveTo(a.x + r, a.y - r); ctx.lineTo(a.x - r, a.y + r);
        ctx.stroke();
        return;
      }
      if (!s.enabled) {
        ctx.strokeStyle = sel ? '#8fa6bc' : '#46505a';
        ctx.lineWidth = sel ? 3 : 1.5;
        ctx.setLineDash([5, 4]);
      } else {
        ctx.strokeStyle = sel ? '#4aa8ff' : '#7d8c9c';
        ctx.lineWidth = sel ? 3.5 : 2;
        ctx.setLineDash([]);
      }
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = s.enabled ? (sel ? '#9fd0ff' : '#9aabbc') : '#46505a';
      [a, b].forEach(function (pt) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, sel ? 3.6 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }

  function drawRepaired(dimmed) {
    var result = workbench.result;
    var pathEdges = null;
    var hotEdge = -1;
    if (selection && selection.kind === 'path') {
      var p = result.paths.filter(function (x) { return x.id === selection.id; })[0];
      if (p) {
        pathEdges = {};
        p.edges.forEach(function (eid) { pathEdges[eid] = 1; });
      }
    }
    if (selection && selection.kind === 'edge') hotEdge = selection.id;

    ctx.globalAlpha = dimmed ? 0.35 : 1;

    result.edges.forEach(function (e) {
      var a = worldToScreen(result.nodes[e.from].x, result.nodes[e.from].y);
      var b = worldToScreen(result.nodes[e.to].x, result.nodes[e.to].y);
      var overlap = e.sources.length > 1;
      var hot = (pathEdges && pathEdges[e.id]) || hotEdge === e.id;
      ctx.strokeStyle = hot ? '#b78cf0' : overlap ? '#f0b146' : '#4aa8ff';
      ctx.lineWidth = hot ? 5 : overlap ? 4 : 2.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.stroke();
    });

    result.nodes.forEach(function (nd) {
      var p = worldToScreen(nd.x, nd.y);
      var sel = selection && selection.kind === 'node' && selection.id === nd.id;
      var color = nd.degree === 1 ? '#57c87d' : nd.degree > 2 ? '#ef6a6a' : '#cfe0f2';
      var radius = nd.degree === 2 ? 2.6 : 4.2;
      if (nd.degree > 2) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - radius - 1);
        ctx.lineTo(p.x + radius + 1, p.y);
        ctx.lineTo(p.x, p.y + radius + 1);
        ctx.lineTo(p.x - radius - 1, p.y);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      if (sel) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.font = '10px ui-monospace, Consolas, monospace';
      ctx.fillStyle = sel ? '#ffffff' : '#8fa3b8';
      ctx.fillText('#' + nd.id, p.x + 7, p.y - 6);
    });
    ctx.globalAlpha = 1;
  }

  function drawStaleBadge() {
    if (!workbench.stale || !workbench.result) return;
    ctx.font = '12px sans-serif';
    var text = '修复结果已过期（修改草稿后需重新执行修复）';
    var w = ctx.measureText(text).width + 22;
    ctx.fillStyle = 'rgba(35,28,15,.92)';
    ctx.fillRect(canvasW / 2 - w / 2, 10, w, 24);
    ctx.strokeStyle = '#f0b146';
    ctx.strokeRect(canvasW / 2 - w / 2, 10, w, 24);
    ctx.fillStyle = '#f0b146';
    ctx.fillText(text, canvasW / 2 - w / 2 + 11, 26);
  }

  // ------------------------------------------------------------- 画布交互

  canvas.addEventListener('mousedown', function (e) {
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    drag = { x: sx, y: sy, ox: view.originX, oy: view.originY, panned: false, pan: !!(e.button === 1 || e.shiftKey) };
    if (drag.pan) { canvas.style.cursor = 'grabbing'; e.preventDefault(); }
  });

  window.addEventListener('mousemove', function (e) {
    var rect = canvas.getBoundingClientRect();
    var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
    var inside = sx >= 0 && sy >= 0 && sx <= rect.width && sy <= rect.height;
    if (drag) {
      if (drag.pan || Math.hypot(sx - drag.x, sy - drag.y) > 4) {
        drag.pan = true;
        drag.panned = true;
        canvas.style.cursor = 'grabbing';
        view.originX = drag.ox + (sx - drag.x);
        view.originY = drag.oy + (sy - drag.y);
        draw();
      }
    } else if (inside) {
      var w = screenToWorld(sx, sy);
      document.getElementById('coordReadout').textContent = 'x ' + w.x.toFixed(3) + '   y ' + w.y.toFixed(3);
    }
  });

  window.addEventListener('mouseup', function (e) {
    if (!drag) return;
    var panned = drag.panned;
    drag = null;
    canvas.style.cursor = 'crosshair';
    if (!panned) {
      var rect = canvas.getBoundingClientRect();
      handlePick(e.clientX - rect.left, e.clientY - rect.top);
    }
  });

  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var rect = canvas.getBoundingClientRect();
    zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  function handlePick(sx, sy) {
    var hit = pickResultNode(sx, sy) || pickResultEdge(sx, sy) || pickOriginalSegment(sx, sy);
    selection = hit;
    renderSelection();
  }

  function pickResultNode(sx, sy) {
    var result = workbench.result;
    if (!result) return null;
    var best = null, bestD = 9;
    result.nodes.forEach(function (nd) {
      var p = worldToScreen(nd.x, nd.y);
      var d = Math.hypot(p.x - sx, p.y - sy);
      if (d < bestD) { bestD = d; best = { kind: 'node', id: nd.id }; }
    });
    return best;
  }

  function pickResultEdge(sx, sy) {
    var result = workbench.result;
    if (!result) return null;
    var best = null, bestD = 6;
    result.edges.forEach(function (ed) {
      var a = worldToScreen(result.nodes[ed.from].x, result.nodes[ed.from].y);
      var b = worldToScreen(result.nodes[ed.to].x, result.nodes[ed.to].y);
      var d = pointToSegmentDist(sx, sy, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = { kind: 'edge', id: ed.id }; }
    });
    return best;
  }

  function pickOriginalSegment(sx, sy) {
    var best = null, bestD = 6;
    workbench.draft.segments.forEach(function (s) {
      if (s.a.x === s.b.x && s.a.y === s.b.y) return; // 零长度点用表格/问题列表定位
      var a = worldToScreen(s.a.x, s.a.y), b = worldToScreen(s.b.x, s.b.y);
      var d = pointToSegmentDist(sx, sy, a.x, a.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = { kind: 'segment', id: s.id }; }
    });
    return best;
  }

  function pointToSegmentDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    var l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(px - ax, py - ay);
    var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  // ------------------------------------------------------------- 错误 / 导入导出

  function showErrors(errors, title) {
    var box = document.getElementById('importErrors');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="err-title">' + title + '（' + errors.length +
      ' 项，草稿未被修改）</div>' + errors.map(function (er) {
        return '<div class="err-item"><span class="err-path">' + escapeHtml(er.path) +
          '</span> — ' + escapeHtml(er.message) + '</div>';
      }).join('');
  }
  function hideErrors() {
    var box = document.getElementById('importErrors');
    box.classList.add('hidden');
    box.innerHTML = '';
  }

  function importJsonText(text) {
    var obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      showErrors([{ path: '$', message: 'JSON 语法不合法：' + e.message }], '导入失败');
      return;
    }
    var r = workbench.replaceDraft(obj);
    if (!r.ok) {
      showErrors(r.errors, '导入失败，错误定位到字段'); // 失败不改变当前草稿
      return;
    }
    hideErrors();
    selection = workbench.draft.segments.length
      ? { kind: 'segment', id: workbench.draft.segments[0].id } : null;
    renderAll();
    fitView();
  }

  function download(filename, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ------------------------------------------------------------- 渲染总入口

  function renderAll() {
    renderStatusBar();
    renderTable();
    renderSummary();
    renderIssues();
    renderPaths();
    draw();
  }

  // ------------------------------------------------------------- 事件绑定

  function bindEvents() {
    document.getElementById('draftName').addEventListener('change', function (e) {
      workbench.setName(e.target.value);
      e.target.value = workbench.draft.name; // 非法（空/超长）时回退
    });
    document.getElementById('snapDistance').addEventListener('change', function (e) {
      var v = Number(e.target.value);
      if (e.target.value.trim() !== '' && isFinite(v) && v >= 0 && v <= 10 && atMost3(v)) {
        workbench.setSnapDistance(v);
      }
      e.target.value = workbench.draft.snapDistance;
    });

    document.getElementById('btnAddSeg').addEventListener('click', function () {
      if (workbench.draft.segments.length >= 200) return;
      var id = workbench.addSegment();
      selection = { kind: 'segment', id: id };
      renderSelection();
    });
    document.getElementById('btnRepair').addEventListener('click', runRepair);
    document.getElementById('btnUndo').addEventListener('click', function () { workbench.undo(); });
    document.getElementById('btnRedo').addEventListener('click', function () { workbench.redo(); });
    document.getElementById('btnFit').addEventListener('click', fitView);
    document.getElementById('btnZoomIn').addEventListener('click', function () {
      zoomAt(canvasW / 2, canvasH / 2, 1.25);
    });
    document.getElementById('btnZoomOut').addEventListener('click', function () {
      zoomAt(canvasW / 2, canvasH / 2, 1 / 1.25);
    });

    document.getElementById('layerOriginal').addEventListener('change', function (e) {
      showOriginal = e.target.checked; draw();
    });
    document.getElementById('layerRepaired').addEventListener('change', function (e) {
      showRepaired = e.target.checked; draw();
    });

    document.getElementById('btnImport').addEventListener('click', function () {
      document.getElementById('fileInput').click();
    });
    document.getElementById('fileInput').addEventListener('change', function (e) {
      var f = e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () { importJsonText(reader.result); };
      reader.readAsText(f);
      e.target.value = '';
    });

    document.getElementById('btnExportDraft').addEventListener('click', function () {
      download('draft.json', JSON.stringify(workbench.exportDraft(), null, 2));
    });
    document.getElementById('btnExportTopo').addEventListener('click', function () {
      var topo = workbench.exportTopology(); // 过期/未修复时为 null
      if (topo) download('topology.json', JSON.stringify(topo, null, 2));
    });

    document.getElementById('btnLoadCase').addEventListener('click', function () {
      var key = document.getElementById('caseSelect').value;
      var c = casesCatalog.filter(function (x) { return x.key === key; })[0];
      if (!c) return;
      var r = workbench.replaceDraft(c.draft);
      if (!r.ok) { showErrors(r.errors, '样例数据异常'); return; }
      hideErrors();
      selection = workbench.draft.segments.length
        ? { kind: 'segment', id: workbench.draft.segments[0].id } : null;
      renderAll();
      fitView();
    });

    window.addEventListener('resize', resizeCanvas);

    // Ctrl+Z / Ctrl+Y 撤销重做（在文本输入框内不拦截，保留原生撤销）
    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(e.ctrlKey || e.metaKey)) return;
      var k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); workbench.undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); workbench.redo(); }
    });
  }

  function loadCases() {
    return fetch('fixtures/cases.json').then(function (r) { return r.json(); }).then(function (cat) {
      casesCatalog = cat.cases || [];
      var sel = document.getElementById('caseSelect');
      sel.innerHTML = casesCatalog.map(function (c) {
        return '<option value="' + c.key + '">' + escapeHtml(c.label) + '</option>';
      }).join('');
    }).catch(function () {
      document.getElementById('btnLoadCase').disabled = true;
    });
  }

  // ------------------------------------------------------------- 初始化

  bindEvents();
  resizeCanvas();
  renderAll();
  fitView();
  loadCases();
})();
