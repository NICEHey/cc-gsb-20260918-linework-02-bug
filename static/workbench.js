/*
 * workbench.js — 工作台状态模型（浏览器与 Node 自测共用）
 *
 * 只负责草稿/结果/撤销栈/过期标记这些“可测试”的状态，
 * 不碰 DOM、localStorage；持久化与渲染由外层订阅 change 事件完成。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./topology.js'));
  } else {
    root.Workbench = factory(root.Topology);
  }
})(typeof self !== 'undefined' ? self : this, function (Topology) {
  'use strict';

  var HISTORY_LIMIT = 50; // 规格要求至少 30

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function createWorkbench(initialDraft) {
    var wb = {
      draft: initialDraft ? deepClone(initialDraft) : {
        version: 1, name: '未命名线稿', snapDistance: 0, segments: []
      },
      result: null,
      stale: false,
      undoStack: [],
      redoStack: [],
      _listeners: [],
      _draftVersion: 0,
      _repairing: false
    };

    function emit() {
      wb._listeners.forEach(function (fn) { fn(wb); });
    }

    function bumpVersion() { wb._draftVersion++; }

    function segIndex(id) {
      for (var i = 0; i < wb.draft.segments.length; i++) {
        if (wb.draft.segments[i].id === id) return i;
      }
      return -1;
    }

    // 任何对草稿的完整编辑：先压栈、再修改、标记过期
    function commit(mutator) {
      wb.undoStack.push(deepClone(wb.draft));
      if (wb.undoStack.length > HISTORY_LIMIT) wb.undoStack.shift();
      wb.redoStack = [];
      mutator();
      wb.stale = true;
      bumpVersion();
      emit();
    }

    function restoreSnapshot(snap, pushCurrentTo) {
      pushCurrentTo.push(deepClone(wb.draft));
      wb.draft = snap;
      wb.stale = true;
      bumpVersion();
      emit();
    }

    var api = {
      onChange: function (fn) { wb._listeners.push(fn); },
      get draft() { return wb.draft; },
      get result() { return wb.result; },
      get stale() { return wb.stale; },
      get canUndo() { return wb.undoStack.length > 0; },
      get canRedo() { return wb.redoStack.length > 0; },
      get undoDepth() { return wb.undoStack.length; },
      get repairing() { return wb._repairing; },

      undo: function () {
        if (!wb.undoStack.length) return;
        restoreSnapshot(wb.undoStack.pop(), wb.redoStack);
      },
      redo: function () {
        if (!wb.redoStack.length) return;
        restoreSnapshot(wb.redoStack.pop(), wb.undoStack);
      },

      setName: function (name) {
        if (typeof name !== 'string' || name.length < 1 || name.length > 80 || name === wb.draft.name) return;
        commit(function () { wb.draft.name = name; });
      },

      setSnapDistance: function (v) {
        if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 10) return;
        if (Math.abs(v - Math.round(v * 1000) / 1000) > 1e-9) return;
        if (v === wb.draft.snapDistance) return;
        commit(function () { wb.draft.snapDistance = v; });
      },

      addSegment: function () {
        if (wb.draft.segments.length >= 200) return null;
        var id = 'seg1', n = 1;
        while (segIndex(id) >= 0) { n++; id = 'seg' + n; }
        var seg = { id: id, enabled: true, a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
        commit(function () { wb.draft.segments.push(seg); });
        return id;
      },

      deleteSegment: function (id) {
        if (segIndex(id) < 0) return;
        commit(function () {
          wb.draft.segments = wb.draft.segments.filter(function (s) { return s.id !== id; });
        });
      },

      toggleEnabled: function (id, enabled) {
        var i = segIndex(id);
        if (i < 0 || typeof enabled !== 'boolean') return;
        if (wb.draft.segments[i].enabled === enabled) return;
        commit(function () { wb.draft.segments[segIndex(id)].enabled = enabled; });
      },

      renameSegment: function (oldId, newId) {
        if (typeof newId !== 'string' || newId.length < 1 || newId.length > 40) {
          return { ok: false, error: 'id 长度必须为 1～40 字符' };
        }
        var i = segIndex(oldId);
        if (i < 0) return { ok: false, error: '线段不存在' };
        if (newId !== oldId && segIndex(newId) >= 0) {
          return { ok: false, error: 'id 重复：' + newId };
        }
        if (newId === oldId) return { ok: true };
        commit(function () { wb.draft.segments[segIndex(oldId)].id = newId; });
        return { ok: true };
      },

      setEndpointCoord: function (id, end, axis, value) {
        if (end !== 'a' && end !== 'b') return { ok: false, error: '端点非法' };
        if (axis !== 'x' && axis !== 'y') return { ok: false, error: '坐标轴非法' };
        if (typeof value === 'boolean' || typeof value !== 'number' || !isFinite(value)) {
          return { ok: false, error: '必须是有限数字（不接受布尔值）' };
        }
        if (Math.abs(value) > 10000) return { ok: false, error: '绝对值不能超过 10000' };
        if (Math.abs(value - Math.round(value * 1000) / 1000) > 1e-9) {
          return { ok: false, error: '最多三位小数' };
        }
        var i = segIndex(id);
        if (i < 0) return { ok: false, error: '线段不存在' };
        if (wb.draft.segments[i][end][axis] === value) return { ok: true };
        commit(function () { wb.draft.segments[segIndex(id)][end][axis] = value; });
        return { ok: true };
      },

      // 成功导入 / 样例替换：整份替换算一次完整编辑，可一次撤销
      replaceDraft: function (obj) {
        var v = Topology.validateDraft(obj);
        if (!v.ok) return { ok: false, errors: v.errors };
        commit(function () { wb.draft = deepClone(obj); });
        return { ok: true };
      },

      // 修复不消耗撤销记录
      repair: function () {
        var v = Topology.validateDraft(wb.draft);
        if (!v.ok) return { ok: false, errors: v.errors };
        wb.result = Topology.repair(wb.draft);
        wb.stale = false;
        emit();
        return { ok: true, result: wb.result };
      },

      // 浏览器用：与 repair() 同一份引擎、同一份结果，只在成对求交循环中
      // 分批让出事件循环，避免大量线段时长时间卡死页面。
      // 修复期间若草稿被修改，到达的旧结果直接丢弃（旧结果失效规则不变）。
      repairAsync: function () {
        var v = Topology.validateDraft(wb.draft);
        if (!v.ok) return Promise.resolve({ ok: false, errors: v.errors });
        if (wb._repairing) return Promise.resolve({ ok: false, errors: [{ path: '$', message: '修复正在进行中' }] });
        var snapshot = deepClone(wb.draft);
        var version = wb._draftVersion;
        wb._repairing = true;
        emit();
        return Topology.repairAsync(snapshot).then(function (result) {
          wb._repairing = false;
          // 期间草稿发生过编辑（版本号变化）：结果对应旧草稿，丢弃
          if (version !== wb._draftVersion) {
            emit();
            return { ok: true, result: wb.result, stale: true };
          }
          wb.result = result;
          wb.stale = false;
          emit();
          return { ok: true, result: result };
        });
      },

      // 只有与当前草稿一致的修复结果才允许导出
      exportTopology: function () {
        if (!wb.result || wb.stale) return null;
        return wb.result;
      },

      exportDraft: function () { return deepClone(wb.draft); }
    };
    return api;
  }

  return { create: createWorkbench };
});
