# 线稿格式 v1

草稿唯一允许字段：`version`（固定数字 1）、`name`（1～80 字符）、`snapDistance`（0～10，最多三位小数）、`segments`（最多 200 项）。

每个 segment 恰有 `id`（1～40 字符，唯一）、`enabled`（布尔）、`a`、`b`。a/b 恰有 x/y，必须有限数字、最多三位小数且绝对值 <= 10000。未知字段、缺失字段、重复 ID、null、数字字符串和用布尔代数字均拒绝。JSON 语法不合法同样不能影响原草稿。ID 区分大小写，排序按 Unicode 码点。

`cases.json` 是样例目录，顶层 `cases` 含若干 `{key,label,draft}`；导入单份草稿时使用其中 draft 对象，不是目录对象。

导出 topology.json：

```json
{
  "version": 1,
  "name": "当前草稿名称",
  "snapDistance": 0,
  "nodes": [{"id":0,"x":0,"y":0,"degree":1}],
  "edges": [{"id":0,"from":0,"to":1,"sources":["s1"],"length":10}],
  "paths": [{"id":0,"nodes":[0,1],"edges":[0],"closed":false,"length":10,"area":null,"sources":["s1"]}],
  "summary": {"nodes":2,"edges":1,"components":1,"endpoints":2,"junctions":0,"openPaths":1,"rings":0},
  "diagnostics": []
}
```

节点/边/路径 ID 均是各自排序后的从 0 开始的连续整数。路径 edges 按路径行走顺序列出，每条 edge 的 from/to 自身仍保持 from < to。路径首尾节点相同即 closed=true，包括从分叉点绕一圈回到同一分叉点提取出的链；闭环不要求其所有节点度均为 2。所有闭环均按环中最小节点起步、逆时针归一，nodes 最后重复第一点，area 为正的包围面积；开链 area=null。summary.rings 数闭环路径，openPaths 只数起终点不同的路径。不同闭环分别计算，不对嵌套环做孔洞相减。数值 JSON 输出保留最多六位小数；长度和面积先用内部精度完整计算再四舍五入，不使用已舍入坐标再计算。空线稿为全 0 计数及空数组。

diagnostics 至少支持 `ZERO_LENGTH_INPUT`、`COLLAPSED_AFTER_SNAP`，每项有 `code`、`sources`（相关原始 ID）、`message`。端点/分叉点在 summary 和页面问题列表中展示即可，不要求重复写入 diagnostics。所有诊断来源有序，按 code、sources 排序。处于阈值边界的端点按距离 <= snapDistance + 1e-9 吸附。

原始零长度是 a、b 的坐标完全相同，必须在建立吸附端点集合前排除；它的坐标不能充当传递吸附的中间桥。吸附后再排除退化段，剩余段才进入交点阶段。交点阶段收集全部剩余端点和计算得到的交点，对欧氏距离 <= 1e-9 的点取传递闭包，每组归一到组内按 x、y 字典序最小的点，再用于切分及节点去重；归一后两端相同的小边忽略。此步骤只用于计算同点归一，阈值固定为 1e-9，不能使用 snapDistance 再吸附新增交点。
