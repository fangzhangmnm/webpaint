# toki pona UCSUR 词表（vendor 快照）

`ucsur-map.json` = 拉丁 toki pona 词 → UCSUR sitelen pona 码点（U+F1900 块）。

- 来源：lipu Linku 词数据（linku.la），经家族 Toki Pona 代偿系统 repo 的
  `ai-workbench/data/linku-words.json` 快照转出（representations.ucsur 字段），2026-07-25。
- 消费者：`src/i18n/ucsur.ts`（tok 语言运行时转写；规则见该文件头注释）。
- 更新方式：重跑上述转出（勿手编码点——drift 即乱码）。
